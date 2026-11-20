import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '@/log.js';

/** How many backups `backups/` keeps. */
export const KEPT_BACKUPS = 3;

const BASE = String.raw`backup-(?:v\d+|before-[A-Za-z0-9_-]+?)`;

/**
 * The names the app gives its backups: by legacy schema version or by first pending migration,
 * with a suffix when the plain name was taken (a timestamp, then random hex since this version).
 */
export const BACKUP_NAME = new RegExp(String.raw`^${BASE}(?:-\d{13}(?:-[0-9a-f]{4})?)?\.sqlite$`);

/** The staging name a backup is written under before it is published: the app's, and no other. */
export const STAGING_NAME = new RegExp(String.raw`^${BASE}\.sqlite\.[0-9a-f]{8}\.partial$`);

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** The data folder's `backups/` refused: it exists, but is not a real directory. */
export class BackupFolderUnusable extends Error {
  constructor(readonly path: string) {
    super(
      `${path} is not a folder, so the database cannot be backed up before its upgrade. Move it aside and start Review Desk again.`,
    );
  }
}

interface Identity {
  dev: number;
  ino: number;
}

/** `path` as a real directory (not a symlink), with its identity; null otherwise, or on error. */
function directoryAt(path: string): Identity | null {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });

    return stats?.isDirectory() && !stats.isSymbolicLink()
      ? { dev: stats.dev, ino: stats.ino }
      : null;
  } catch {
    return null;
  }
}

async function directoryAtAsync(path: string): Promise<Identity | null> {
  const stats = await lstat(path).catch(() => null);

  return stats?.isDirectory() && !stats.isSymbolicLink()
    ? { dev: stats.dev, ino: stats.ino }
    : null;
}

const same = (a: Identity | null, b: Identity | null) =>
  Boolean(a && b && a.dev === b.dev && a.ino === b.ino);

/**
 * `backups/` in the data folder, made if missing. Backups only ever go there: one that exists as
 * anything but a real directory refuses the backup, and with it the upgrade, rather than put the
 * copy somewhere the app does not manage.
 */
export function backupFolder(dataDir: string): string {
  const path = join(dataDir, 'backups');

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  if (!directoryAt(path)) throw new BackupFolderUnusable(path);

  return path;
}

/**
 * Removes the staging copies an interrupted backup left in `backups/`, by the app's staging name
 * only. Called before migrating, under the data folder's lock. Best effort: a folder that cannot
 * be read or changed never keeps the app from starting.
 */
export function clearPartialBackups(dataDir: string): void {
  const path = join(dataDir, 'backups');
  const identity = directoryAt(path);

  if (!identity) return;

  let names: string[];

  try {
    names = readdirSync(path);
  } catch {
    return;
  }

  for (const name of names) {
    if (!STAGING_NAME.test(name)) continue;

    try {
      // Only in the folder that was checked: never through one swapped in meanwhile.
      if (!same(directoryAt(path), identity)) return;
      if (lstatSync(join(path, name)).isFile()) unlinkSync(join(path, name));
    } catch {
      // The next start tries again.
    }
  }
}

/**
 * Copies the database before an upgrade, into `backups/`. The copy is written under a staging name
 * this call reserves (created exclusively, so it is nobody else's), published only once complete,
 * and published by hard link, which fails instead of replacing: a taken name is retried with a new
 * suffix, so an existing file is never overwritten.
 */
export function writeBackup(db: DatabaseSync, databasePath: string, label: string): string {
  const folder = backupFolder(dirname(databasePath));
  const base = `backup-${label}`;
  let partial: string | null = null;
  let reserved: Identity | null = null;
  let published: string | null = null;

  // Reserve a staging name; VACUUM INTO accepts an empty file and writes into it.
  for (let attempt = 0; attempt < 5 && !partial; attempt++) {
    const candidate = join(folder, `${base}.sqlite.${hex(4)}.partial`);

    try {
      const descriptor = openSync(candidate, 'wx', 0o600);
      const stats = fstatSync(descriptor);

      closeSync(descriptor);
      partial = candidate;
      reserved = { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  if (!partial) throw new Error('No free staging name to back up the database under.');

  /** The staging path still holds the file this call reserved, not one put there since. */
  const ours = () => {
    try {
      const stats = lstatSync(partial!);

      return stats.isFile() && stats.dev === reserved!.dev && stats.ino === reserved!.ino;
    } catch {
      return false;
    }
  };

  try {
    db.prepare('VACUUM INTO ?').run(partial);

    if (!ours()) throw new Error('The database backup was replaced while it was being written.');

    for (let attempt = 0; attempt < 5 && !published; attempt++) {
      const name = attempt === 0 ? `${base}.sqlite` : `${base}-${Date.now()}-${hex(2)}.sqlite`;

      try {
        linkSync(partial, join(folder, name));
        published = join(folder, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    // Only the file this call reserved is removed; one left behind is cleared next start.
    let left = false;

    if (ours()) {
      try {
        unlinkSync(partial);
      } catch (error) {
        left = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
    }

    log.event(left ? 'warn' : 'info', 'backup.written', {
      published: published !== null,
      stagingLeft: left,
    });
  }

  if (!published) throw new Error('No free name to publish the database backup under.');

  return published;
}

/**
 * Keeps the newest `keep` backups in `backups/` and removes the rest, newest by modification time
 * and then by name. Only regular files with the app's backup names are considered, nothing outside
 * `backups/` is ever removed, and each removal first checks that `backups/` is still the folder
 * that was listed. Best effort: anything that fails is counted, never thrown.
 *
 * Node cannot remove a file relative to an open directory, so a folder swapped for another in the
 * instant between that check and the removal is not caught. Only a process of the same user could
 * do that, and it could remove those files itself.
 */
export async function pruneBackups(
  dataDir: string,
  keep = KEPT_BACKUPS,
): Promise<{ kept: number; removed: number; failed: number; managed: boolean }> {
  const folder = join(dataDir, 'backups');
  const identity = await directoryAtAsync(folder);
  const report = (result: { kept: number; removed: number; failed: number; managed: boolean }) => {
    log.event(result.failed > 0 ? 'warn' : 'info', 'retention.backups', result);

    return result;
  };

  if (!identity) return report({ kept: 0, removed: 0, failed: 0, managed: false });

  const names = await readdir(folder).catch(() => null);

  if (!names) return report({ kept: 0, removed: 0, failed: 1, managed: true });

  const backups: { name: string; modified: number; dev: number; ino: number }[] = [];

  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;

    const entry = await lstat(join(folder, name)).catch(() => null);

    if (entry?.isFile())
      backups.push({ name, modified: entry.mtimeMs, dev: entry.dev, ino: entry.ino });
  }

  backups.sort(
    (a, b) => b.modified - a.modified || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );

  let removed = 0;
  let failed = 0;

  for (const backup of backups.slice(keep)) {
    // The folder and the file are checked and the file unlinked in the same JavaScript turn, so
    // nothing in this process runs in between: a swapped folder, or a backup restored under the
    // ranked name, is seen unless another process changes it between those system calls.
    try {
      if (!same(directoryAt(folder), identity)) {
        failed += 1;
        break;
      }

      const current = lstatSync(join(folder, backup.name), { throwIfNoEntry: false });

      if (
        !current?.isFile() ||
        current.dev !== backup.dev ||
        current.ino !== backup.ino ||
        current.mtimeMs !== backup.modified
      )
        continue;

      unlinkSync(join(folder, backup.name));
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  return report({ kept: Math.min(keep, backups.length), removed, failed, managed: true });
}
