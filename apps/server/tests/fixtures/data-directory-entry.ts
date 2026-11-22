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
  /** Dies right after the rename commits, or right after creating an empty database. */
  kill?: 'afterRename' | 'afterCreate';
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
