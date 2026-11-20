import { randomBytes } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '@/log.js';

/** How many backups `backups/` keeps. */
export const KEPT_BACKUPS = 3;

/**
 * The names the app gives its backups: by legacy schema version or by first pending migration,
 * with a suffix when the plain name was taken (a timestamp, then random hex since this version).
 */
export const BACKUP_NAME =
  /^backup-(?:v\d+|before-[A-Za-z0-9_-]+?)(?:-\d{13}(?:-[0-9a-f]{4})?)?\.sqlite$/;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * Where backups go: `backups/` in the data folder, made if missing, when it is a real directory;
 * otherwise the data folder itself, which the app never prunes.
 */
export function backupFolder(dataDir: string): { path: string; managed: boolean } {
  const path = join(dataDir, 'backups');

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      return { path: dataDir, managed: false };
  }

  const stats = lstatSync(path, { throwIfNoEntry: false });

  return stats?.isDirectory() && !stats.isSymbolicLink()
    ? { path, managed: true }
    : { path: dataDir, managed: false };
}

/**
 * Removes the partial copies that an interrupted backup left in `backups/`. Called before
 * migrating, under the data folder's lock, so a leftover can neither block nor outrank a backup.
 */
export function clearPartialBackups(dataDir: string): void {
  const folder = backupFolder(dataDir);

  if (!folder.managed) return;

  for (const name of readdirSync(folder.path)) {
    if (!name.endsWith('.partial')) continue;

    const path = join(folder.path, name);

    try {
      if (lstatSync(path).isFile()) unlinkSync(path);
    } catch {
      // Best effort: the next start tries again.
    }
  }
}

/**
 * Copies the database before an upgrade. The copy is written under a fresh staging name and
 * published only once complete. Publishing is a hard link, which fails instead of replacing, so
 * an existing file is never overwritten: a taken name is retried with a new suffix.
 */
export function writeBackup(db: DatabaseSync, databasePath: string, label: string): string {
  const folder = backupFolder(dirname(databasePath));
  const base = `backup-${label}`;
  const partial = join(folder.path, `${base}.sqlite.${hex(4)}.partial`);
  let published: string | null = null;

  try {
    db.prepare('VACUUM INTO ?').run(partial);

    for (let attempt = 0; attempt < 5 && !published; attempt++) {
      const name = attempt === 0 ? `${base}.sqlite` : `${base}-${Date.now()}-${hex(2)}.sqlite`;

      try {
        linkSync(partial, join(folder.path, name));
        published = join(folder.path, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    // Published or not, the staging name goes; one left in `backups/` is cleared next start.
    let left = false;

    try {
      unlinkSync(partial);
    } catch (error) {
      left = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }

    log.event(left ? 'warn' : 'info', 'backup.written', {
      managed: folder.managed,
      published: published !== null,
      stagingLeft: left,
    });
  }

  if (!published) throw new Error('No free name to publish the database backup under.');

  return published;
}

/**
 * Keeps the newest `keep` backups in `backups/` and removes the rest, newest by modification time
 * and then by name. Only regular files with the app's backup names are considered, and nothing
 * outside `backups/` is ever removed. Best effort: a failed removal is counted, never thrown.
 */
export async function pruneBackups(
  dataDir: string,
  keep = KEPT_BACKUPS,
): Promise<{ kept: number; removed: number; failed: number; managed: boolean }> {
  const folder = join(dataDir, 'backups');
  const stats = await lstat(folder).catch(() => null);

  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    const result = { kept: 0, removed: 0, failed: 0, managed: false };

    log.event('info', 'retention.backups', result);

    return result;
  }

  const backups: { name: string; modified: number }[] = [];

  for (const name of await readdir(folder)) {
    if (!BACKUP_NAME.test(name)) continue;

    const entry = await lstat(join(folder, name)).catch(() => null);

    if (entry?.isFile()) backups.push({ name, modified: entry.mtimeMs });
  }

  backups.sort(
    (a, b) => b.modified - a.modified || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );

  let removed = 0;
  let failed = 0;

  for (const { name } of backups.slice(keep)) {
    try {
      await rm(join(folder, name));
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  const result = { kept: Math.min(keep, backups.length), removed, failed, managed: true };

  log.event(failed > 0 ? 'warn' : 'info', 'retention.backups', result);

  return result;
}
