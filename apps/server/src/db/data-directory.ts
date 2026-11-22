import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '@/config.js';
import { holdExclusive, lockDataDirectory, type DataDirectoryLock } from '@/db/lock.js';
import { databaseState } from '@/db/migrate.js';

const DATABASE = 'review-desk.sqlite';
const STARTUP_LOCK = 'review-desk-startup.lock';
const MOVED_NOTE = '.data-moved-to.txt';
/** What a start leaves in a folder before it has a database: never data. */
const RESIDUE = new Set(['review-desk.lock', 'review-desk.owner.json', 'logs', 'dev-session.json']);
/** Files that are a database's to recover: never replaced by an empty one. */
const RECOVERY = [`${DATABASE}-wal`, `${DATABASE}-shm`, `${DATABASE}-journal`];

/** Why the data folder could not be settled: the start stops, and the message says what to do. */
export class DataDirectoryRefused extends Error {}

/** The start was asked to stop (SIGTERM, Ctrl-C) while it waited: nothing was moved or kept. */
export class StartCancelled extends Error {
  constructor() {
    super('Review Desk was stopped while it started.');
  }
}

/** Waits `ms`, or throws `StartCancelled` as soon as `signal` aborts. */
async function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new StartCancelled();

  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw new StartCancelled();

    throw error;
  }
}

export interface Adoption {
  /** `moved`: the checkout's folder became the OS's. `kept`: the OS's has data; the checkout's is ignored. */
  outcome: 'moved' | 'kept';
  from: string;
  to: string;
  /** The move's directories were flushed to disk (a move is committed either way). */
  synced: boolean;
}

export interface ResolvedDataDirectory {
  lock: DataDirectoryLock;
  adoption: Adoption | null;
}

/** What a test can stand in for, and where it can pause or crash. */
export interface AdoptionHost {
  rename?: (from: string, to: string) => void;
  mkdir?: (path: string) => void;
  syncDirectory?: (path: string) => void;
  /** With every lock held, right before the rename. */
  beforeRename?: () => void | Promise<void>;
  /** Right after the rename committed, before anything else. */
  afterRename?: () => void;
  /** Aborted when the start is asked to stop: every wait ends, and nothing more is moved. */
  signal?: AbortSignal;
  waitMs?: number;
  pollMs?: number;
}

const stat = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;

    throw error;
  }
};

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Creates `path` and its missing ancestors (0700): those it created, outermost first. */
function ensureDirectory(
  path: string,
  mkdir = (directory: string) => mkdirSync(directory, { mode: 0o700 }),
): string[] {
  const missing: string[] = [];

  for (let current = path; !stat(current); current = dirname(current)) missing.unshift(current);

  for (const directory of missing) {
    try {
      mkdir(directory);
    } catch (error) {
      // Another first launch made it a moment ago: as good, if it is a folder.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !statSync(directory).isDirectory())
        throw error;
    }
  }

  return missing;
}

/**
 * What `review-desk.sqlite` in `folder` is. Opened as the store opens it, while this process holds
 * the folder's lock, so SQLite recovers a hot journal or WAL it left first.
 */
function databaseIn(folder: string): 'missing' | 'established' | 'empty' | 'unusable' {
  const path = join(folder, DATABASE);
  const entry = stat(path);

  if (!entry) return 'missing';
  if (!entry.isFile()) return 'unusable';

  try {
    const client = new DatabaseSync(path, { timeout: 0 });

    try {
      const check = client.prepare('PRAGMA quick_check').get() as { quick_check?: string };

      if (check.quick_check !== 'ok') return 'unusable';

      const state = databaseState(client);

      return state === 'drizzle' || state === 'legacy'
        ? 'established'
        : state === 'empty'
          ? 'empty'
          : 'unusable';
    } finally {
      client.close();
    }
  } catch {
    return 'unusable';
  }
}

/** What the OS folder holds, decided while this process holds its lock. */
function destinationIn(
  folder: string,
): 'established' | 'fresh' | 'recovery' | 'occupied' | 'unusable' {
  const database = databaseIn(folder);

  if (database === 'established') return 'established';
  if (database === 'unusable') return 'unusable';

  const names = readdirSync(folder);
  const backups =
    names.includes('backups') || names.some((name) => /^backup-v\d+\.sqlite$/.test(name));

  // An empty database SQLite recovered is a first start that stopped early, unless backups say
  // there was data once. Recovery files without their database are never replaced.
  if (database === 'empty') return backups ? 'recovery' : 'fresh';
  if (backups || names.some((name) => RECOVERY.includes(name))) return 'recovery';

  return names.every((name) => RESIDUE.has(name)) ? 'fresh' : 'occupied';
}

/** Whether the checkout's folder holds a database, links followed: only to say it is ignored. */
function hasData(folder: string): boolean {
  try {
    return statSync(folder).isDirectory() && statSync(join(folder, DATABASE)).isFile();
  } catch {
    return false;
  }
}

/** The checkout's folder, if it holds data: refused when it cannot be moved as one folder. */
function legacyIn(folder: string): Stats | null {
  const root = stat(folder);

  if (!root) return null;
  if (root.isSymbolicLink())
    throw new DataDirectoryRefused(`${folder} is a link, so its data cannot be moved for you.`);
  if (!root.isDirectory() || !stat(join(folder, DATABASE))) return null;

  for (const name of readdirSync(folder)) {
    if (stat(join(folder, name))?.isSymbolicLink())
      throw new DataDirectoryRefused(
        `${join(folder, name)} is a link, so the data in ${folder} cannot be moved for you.`,
      );
  }

  if (stat(join(folder, 'ai-runs', '.locks'))?.isSymbolicLink())
    throw new DataDirectoryRefused(
      `${join(folder, 'ai-runs', '.locks')} is a link, so the data in ${folder} cannot be moved for you.`,
    );

  if (!stat(join(folder, DATABASE))!.isFile())
    throw new DataDirectoryRefused(`${join(folder, DATABASE)} is not a file.`);

  return root;
}

const errorCode = (error: unknown) =>
  (error as NodeJS.ErrnoException).code ??
  String((error as { errcode?: unknown }).errcode ?? 'unknown');

/**
 * Holds each AI run's agent lock in `folder` (the lock each run's agent holds while it runs),
 * waiting up to `waitMs` for agents of an earlier process to finish. All of them, or none: on any
 * failure the ones taken are released.
 */
async function holdRunLocks(
  folder: string,
  waitMs: number,
  pollMs: number,
  signal: AbortSignal | undefined,
): Promise<{ release(): void }[]> {
  const runs = join(folder, 'ai-runs');

  if (!stat(runs)?.isDirectory()) return [];

  const locks = join(runs, '.locks');
  const ids = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.locks')
    .map((entry) => entry.name);
  const held: { release(): void }[] = [];
  const deadline = Date.now() + waitMs;

  try {
    for (const id of ids) {
      const path = join(locks, `${id}.lock`);
      const entry = stat(path);

      if (entry && !entry.isFile())
        throw new DataDirectoryRefused(`The agent lock for AI run ${id} (${path}) is not a file.`);

      mkdirSync(locks, { recursive: true, mode: 0o700 });

      for (;;) {
        let lock: { release(): void } | null;

        try {
          lock = holdExclusive(path);
        } catch (error) {
          throw new DataDirectoryRefused(
            `The agent lock for AI run ${id} (${path}) cannot be used (${errorCode(error)}).`,
          );
        }

        if (lock) {
          held.push(lock);
          break;
        }

        if (Date.now() >= deadline)
          throw new DataDirectoryRefused(
            `An AI agent started by an earlier Review Desk is still running in ${join(runs, id)}.`,
          );

        await wait(pollMs, signal);
      }
    }

    return held;
  } catch (error) {
    for (const lock of held) lock.release();

    throw error;
  }
}

/** What to do when the folder cannot be moved for you. */
function manualSteps(from: string, to: string): string {
  return [
    `To move it yourself: stop Review Desk and any AI agents it started, then move ${from} to ${to} (which must not exist yet).`,
    `Or keep using the old folder: start with REVIEW_DESK_DATA_DIR=${basename(from)}.`,
  ].join('\n');
}

/**
 * Settles the data folder and takes ownership of it, before anything opens, migrates or recovers
 * the database. With an override or in demo mode, that is just the lock. Otherwise the folder is
 * the OS's, and a checkout's old `.data` moves there once, as one rename while every lock on it is
 * held (see the README): a rename is atomic, so a crash at any point leaves it in one place or the
 * other, never partly moved. A move it cannot make safely stops the start, saying what to do.
 */
export async function resolveDataDirectory(
  config: Pick<Config, 'dataLocation'>,
  host: AdoptionHost = {},
): Promise<ResolvedDataDirectory> {
  const { directory, kind, legacy } = config.dataLocation;

  if (kind !== 'os' || legacy === null)
    return { lock: lockDataDirectory(directory), adoption: null };

  const waitMs = host.waitMs ?? 30_000;
  const pollMs = host.pollMs ?? 1_000;
  const parent = dirname(directory);
  const created = ensureDirectory(parent, host.mkdir);

  // One launch at a time decides, from whichever checkout: the folder cannot change meanwhile.
  const startupDeadline = Date.now() + waitMs;
  let startup: { release(): void } | null = null;

  while (!(startup = holdExclusive(join(parent, STARTUP_LOCK)))) {
    if (Date.now() >= startupDeadline)
      throw new DataDirectoryRefused(
        `Another Review Desk has been starting for ${waitMs / 1000} s. Try again once it has started or stopped.`,
      );

    await wait(pollMs, host.signal);
  }

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = stat(directory);

      if (target && !(target.isSymbolicLink() ? statSync(directory) : target).isDirectory())
        throw new DataDirectoryRefused(`${directory} is not a folder.`);

      // A folder with nothing in it is no destination yet: a rename replaces it, and taking its
      // lock first would leave a file in it.
      if (target && readdirSync(directory).length > 0) {
        const lock = lockDataDirectory(directory);
        const destination = destinationIn(directory);
        // Whether the checkout has data, for what to say: its move-safety checks are the move's.
        const before = hasData(legacy);

        if (destination === 'established') {
          const adoption: Adoption | null = before
            ? { outcome: 'kept', from: legacy, to: directory, synced: true }
            : null;

          return { lock, adoption };
        }

        if (!before && (destination === 'fresh' || destination === 'occupied'))
          return { lock, adoption: null };

        lock.release();

        throw new DataDirectoryRefused(
          before
            ? `Review Desk keeps its data in ${directory} now, which already holds files but no data it can use, so the data in ${legacy} was not moved there.\n${manualSteps(legacy, directory)}`
            : `${directory} holds files a database may need to recover, but no database Review Desk can open. Move it aside, with Review Desk stopped, to start afresh.`,
        );
      }

      const before = legacyIn(legacy);

      if (!before) return { lock: lockDataDirectory(directory), adoption: null };

      if (process.platform === 'win32')
        throw new DataDirectoryRefused(
          `Review Desk keeps its data in ${directory} now. Moving ${legacy} there is not done for you on Windows yet.\n${manualSteps(legacy, directory)}`,
        );

      const legacyLock = lockDataDirectory(legacy, { create: false });
      const same = stat(legacy);

      // Moved or replaced before it was locked: decide again.
      if (
        !same ||
        same.dev !== before.dev ||
        same.ino !== before.ino ||
        !stat(join(legacy, DATABASE))
      ) {
        legacyLock.release();
        continue;
      }

      let runLocks: { release(): void }[] = [];
      let committed = false;

      try {
        runLocks = await holdRunLocks(legacy, waitMs, pollMs, host.signal);
        await host.beforeRename?.();

        // The last point a stop can still leave everything where it was.
        if (host.signal?.aborted) throw new StartCancelled();

        try {
          (host.rename ?? renameSync)(legacy, directory);
        } catch (error) {
          const code = errorCode(error);

          // Another launch filled it first: decide again, holding nothing.
          if (code === 'ENOTEMPTY' || code === 'EEXIST') continue;

          throw new DataDirectoryRefused(
            `The data in ${legacy} could not be moved to ${directory} (${code}).\n${manualSteps(legacy, directory)}`,
          );
        }

        committed = true;
      } finally {
        // Not moved, whatever stopped it: every lock taken for the move is given back.
        if (!committed) {
          for (const runLock of runLocks) runLock.release();
          legacyLock.release();
        }
      }

      // Committed: the folder is the OS's now, and so is the lock that went with it.
      legacyLock.moved(directory);
      host.afterRename?.();

      for (const runLock of runLocks) runLock.release();

      let synced = true;

      for (const entry of [parent, dirname(legacy), ...created.map((path) => dirname(path))]) {
        try {
          (host.syncDirectory ?? syncDirectory)(entry);
        } catch {
          synced = false;
        }
      }

      try {
        writeFileSync(
          join(dirname(legacy), MOVED_NOTE),
          `Review Desk moved its data from this checkout's ${basename(legacy)} folder to:\n${directory}\n`,
        );
      } catch {
        // Only a hint for a person.
      }

      return {
        lock: legacyLock,
        adoption: { outcome: 'moved', from: legacy, to: directory, synced },
      };
    }

    throw new DataDirectoryRefused(
      `${directory} kept changing while Review Desk tried to move ${legacy} there. Try again.`,
    );
  } finally {
    startup.release();
  }
}
