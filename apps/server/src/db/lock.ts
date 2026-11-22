import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LOCK_FILE = 'review-desk.lock';
const OWNER_FILE = 'review-desk.owner.json';

/** SQLite's "database is busy" and "database is locked" result codes. */
const BUSY_CODES = new Set([5, 6]);

/**
 * An exclusive SQLite lock on the file at `path` (created if missing), held by this process until
 * `release`, or until it exits however it exits. `null` when another process holds it; any other
 * failure (not a database, no permission) is thrown.
 */
export function holdExclusive(path: string): { release(): void } | null {
  const connection = new DatabaseSync(path, { timeout: 0 });

  try {
    connection.exec('PRAGMA locking_mode = EXCLUSIVE');
    connection.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    connection.close();

    const code = (error as { errcode?: unknown }).errcode;

    if (typeof code === 'number' && BUSY_CODES.has(code)) return null;

    throw error;
  }

  let released = false;

  return {
    release() {
      if (released) return;

      released = true;
      connection.close();
    },
  };
}

interface Owner {
  pid: number;
  startedAt: string;
}

export interface DataDirectoryLock {
  /** The folder it holds: where the folder is now, after `moved`. */
  readonly directory: string;
  /**
   * The folder was renamed to `to` while held: its lock file went with it (the open file follows
   * the rename), so the lock now holds `to`, and its owner file is cleaned up there.
   */
  moved(to: string): void;
  /** Gives up ownership. Call it only once nothing in this process can touch the database. */
  release(): void;
}

/** Another process already owns the data directory. */
export class DataDirectoryLocked extends Error {
  constructor(
    readonly directory: string,
    readonly ownerPid: number | null,
  ) {
    super(
      `Review Desk is already running with the data in ${directory}` +
        (ownerPid ? ` (process ${ownerPid})` : '') +
        '. Stop it first, or set REVIEW_DESK_DATA_DIR to use another directory.',
    );
  }
}

function readOwner(directory: string): Owner | null {
  try {
    const owner = JSON.parse(readFileSync(join(directory, OWNER_FILE), 'utf8')) as Partial<Owner>;

    return typeof owner.pid === 'number' && typeof owner.startedAt === 'string'
      ? { pid: owner.pid, startedAt: owner.startedAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * Makes this process the only one that uses `directory`, before anything opens, migrates or
 * recovers the database in it. The lock is an exclusive SQLite lock on a separate file, which the
 * operating system holds for this process: it ends when the process exits, however it exits, so a
 * crash never leaves the directory locked and no heartbeat or timeout decides ownership.
 */
export function lockDataDirectory(
  directory: string,
  /** `create: false` locks only a folder that exists: never one that just moved away. */
  { create = true }: { create?: boolean } = {},
): DataDirectoryLock {
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  else if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${directory} is not a folder.`);

  const connection = new DatabaseSync(join(directory, LOCK_FILE), { timeout: 0 });

  try {
    connection.exec('PRAGMA locking_mode = EXCLUSIVE');
    connection.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    connection.close();

    const code = (error as { errcode?: unknown }).errcode;

    if (typeof code === 'number' && BUSY_CODES.has(code))
      throw new DataDirectoryLocked(directory, readOwner(directory)?.pid ?? null);

    throw error;
  }

  // Only says who holds the lock, for the message a second launch shows; the lock itself decides.
  const owner: Owner = { pid: process.pid, startedAt: new Date().toISOString() };

  writeFileSync(join(directory, OWNER_FILE), JSON.stringify(owner), { mode: 0o600 });

  let released = false;
  let current = directory;

  return {
    get directory() {
      return current;
    },
    moved(to) {
      current = to;
    },
    release() {
      if (released) return;

      released = true;

      if (readOwner(current)?.pid === process.pid)
        rmSync(join(current, OWNER_FILE), { force: true });

      connection.close();
    },
  };
}
