/**
 * A start, as far as its data folder: for `data-directory-process.test.ts`. Settles the folder
 * with `resolveDataDirectory` for an injected home and checkout (never the real ones), opens the
 * store as the server does, and says what it found. `ENTRY` holds its options as JSON.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '@/config.js';
import { DataDirectoryRefused, resolveDataDirectory } from '@/db/data-directory.js';
import { DataDirectoryLocked } from '@/db/lock.js';
import { LAST_ACCOUNT } from '@/db/settings.js';
import { Store } from '@/db/store.js';

interface Entry {
  home: string;
  root: string;
  env?: Record<string, string>;
  /** Waits, with every lock held, until this file exists. */
  pauseFile?: string;
  /**
   * Dies right after the rename commits; or right after creating an empty database; or, as the
   * store does, after turning WAL on and starting its first migration, before it commits.
   */
  kill?: 'afterRename' | 'afterCreate' | 'afterWal' | 'afterJournal';
  /** Keeps running, holding the folder, until SIGTERM. */
  hold?: boolean;
}

const entry = JSON.parse(process.env.ENTRY!) as Entry;
const config = loadConfig(['node', 'index.js'], entry.env ?? {}, {
  platform: 'darwin',
  home: entry.home,
  root: entry.root,
});
const say = (message: Record<string, unknown>) => console.log(JSON.stringify(message));

let resolved: Awaited<ReturnType<typeof resolveDataDirectory>>;

try {
  resolved = await resolveDataDirectory(config, {
    waitMs: 3_000,
    pollMs: 50,
    beforeRename: entry.pauseFile
      ? async () => {
          say({ paused: true });

          while (!existsSync(entry.pauseFile!)) await delay(20);
        }
      : undefined,
    afterRename:
      entry.kill === 'afterRename' ? () => process.kill(process.pid, 'SIGKILL') : undefined,
  });
} catch (error) {
  say({
    refused:
      error instanceof DataDirectoryLocked
        ? 'locked'
        : error instanceof DataDirectoryRefused
          ? 'refused'
          : 'error',
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(2);
}

if (entry.kill === 'afterCreate') {
  // As the store's first step does, before any migration.
  new DatabaseSync(config.databasePath).close();
  process.kill(process.pid, 'SIGKILL');
}

if (entry.kill === 'afterJournal') {
  // A rollback journal SQLite must replay before anything reads the database.
  const client = new DatabaseSync(config.databasePath);

  client.exec('PRAGMA journal_mode = DELETE');
  // An empty ledger, as a first migration begins with; its first entry is never committed.
  client.exec(
    'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)',
  );
  // A cache too small to hold the transaction, so its changes reach the database file before it
  // commits: the journal is then hot, and must be replayed.
  client.exec('PRAGMA cache_size = 1');
  client.exec('BEGIN IMMEDIATE');
  client.exec(
    'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) INSERT INTO __drizzle_migrations (hash) SELECT hex(randomblob(2000)) FROM n',
  );
  process.kill(process.pid, 'SIGKILL');
}

if (entry.kill === 'afterWal') {
  const client = new DatabaseSync(config.databasePath);

  client.exec('PRAGMA journal_mode = WAL');
  client.exec('BEGIN IMMEDIATE');
  client.exec('CREATE TABLE half (done INTEGER)');
  process.kill(process.pid, 'SIGKILL');
}

const store = new Store(config.databasePath);
const account = store.settings.get(LAST_ACCOUNT);

store.close();
say({
  directory: resolved.lock.directory,
  outcome: resolved.adoption?.outcome ?? null,
  account,
});

if (entry.hold) {
  // A pending promise alone does not keep a process alive: this does, until SIGTERM.
  const alive = setInterval(() => {}, 60_000);

  await new Promise<void>((resolve) => process.once('SIGTERM', resolve));
  clearInterval(alive);
}

resolved.lock.release();
say({ released: true });
