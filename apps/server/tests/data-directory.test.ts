import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { dataLocation, runtimePorts } from '@review-desk/shared/runtime';
import { loadConfig } from '@/config.js';
import {
  DataDirectoryRefused,
  resolveDataDirectory,
  type AdoptionHost,
} from '@/db/data-directory.js';
import { DataDirectoryLocked, holdExclusive, lockDataDirectory } from '@/db/lock.js';
import { LAST_ACCOUNT } from '@/db/settings.js';
import { Store } from '@/db/store.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A home and a checkout of our own, so no real folder is ever in scope. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rd-data-')));
  const home = join(root, 'home');
  const project = join(root, 'project');

  mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true });
  mkdirSync(project);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const config = loadConfig(['node', 'index.js'], {}, { platform: 'darwin', home, root: project });
  const legacy = join(project, '.data');
  const target = join(home, 'Library', 'Application Support', 'Review Desk');

  return { root, home, project, config, legacy, target };
}

/** A database with data in it, as a checkout's `.data` held one. */
function withData(folder: string, account = 'kept') {
  mkdirSync(folder, { recursive: true });

  const store = new Store(join(folder, 'review-desk.sqlite'));

  store.settings.set(LAST_ACCOUNT, account);
  store.close();
}

const accountIn = (folder: string) => {
  const store = new Store(join(folder, 'review-desk.sqlite'));

  try {
    return store.settings.get(LAST_ACCOUNT);
  } finally {
    store.close();
  }
};

const fast: AdoptionHost = { waitMs: 300, pollMs: 20 };

const resolve = async (config: ReturnType<typeof machine>['config'], host: AdoptionHost = {}) => {
  const resolved = await resolveDataDirectory(config, { ...fast, ...host });

  cleanups.push(() => resolved.lock.release());

  return resolved;
};

describe('where the data lives', () => {
  const base = { home: '/Users/you', projectRoot: '/code/review-desk', path: path.posix };

  it.each([
    ['darwin', {}, '/Users/you/Library/Application Support/Review Desk'],
    ['linux', {}, '/Users/you/.local/share/review-desk'],
    ['linux', { XDG_DATA_HOME: '/data' }, '/data/review-desk'],
    // Relative XDG paths are ignored, as the spec says.
    ['linux', { XDG_DATA_HOME: 'data' }, '/Users/you/.local/share/review-desk'],
  ])('on %s with %j: %s', (platform, env, directory) => {
    expect(dataLocation({ ...base, env, platform, mode: 'production' })).toEqual({
      directory,
      kind: 'os',
      legacy: '/code/review-desk/.data',
    });
  });

  it('is the same for pnpm dev, and its own for demo mode and an override', () => {
    const at = (mode: 'development' | 'demo', env: Record<string, string> = {}) =>
      dataLocation({ ...base, env, platform: 'darwin', mode });

    expect(at('development').directory).toBe('/Users/you/Library/Application Support/Review Desk');
    expect(at('demo')).toEqual({
      directory: '/code/review-desk/.data-demo',
      kind: 'demo',
      legacy: null,
    });
    expect(at('development', { REVIEW_DESK_DATA_DIR: '.data' })).toEqual({
      directory: '/code/review-desk/.data',
      kind: 'override',
      legacy: null,
    });
  });

  it('on Windows, falls back from a missing or relative LOCALAPPDATA', () => {
    const windows = (env: Record<string, string>) =>
      dataLocation({
        env,
        platform: 'win32',
        home: 'C:\\Users\\you',
        projectRoot: 'C:\\code\\review-desk',
        mode: 'production',
        path: path.win32,
      }).directory;

    expect(windows({ LOCALAPPDATA: 'D:\\Local' })).toBe('D:\\Local\\Review Desk');
    expect(windows({})).toBe('C:\\Users\\you\\AppData\\Local\\Review Desk');
    expect(windows({ LOCALAPPDATA: 'Local' })).toBe('C:\\Users\\you\\AppData\\Local\\Review Desk');
  });

  it('gives the API and Vite the same ports, REVIEW_DESK_PORT included', () => {
    expect(runtimePorts({ demo: false, viteDev: true, env: {} })).toEqual({ ui: 4317, api: 4318 });
    expect(runtimePorts({ demo: false, viteDev: true, env: { REVIEW_DESK_PORT: '5000' } })).toEqual(
      { ui: 4317, api: 5000 },
    );
    expect(runtimePorts({ demo: true, viteDev: false, env: { REVIEW_DESK_PORT: '5001' } })).toEqual(
      { ui: 5001, api: 5001 },
    );
  });
});

describe('moving a checkout’s data to the OS folder', () => {
  it('moves it as one folder, holding its lock throughout, and leaves a note', async () => {
    const { config, legacy, target, project } = machine();

    withData(legacy);
    mkdirSync(join(legacy, 'ai-runs', 'run-1'), { recursive: true });

    const { lock, adoption } = await resolve(config);

    expect(adoption).toEqual({ outcome: 'moved', from: legacy, to: target, synced: true });
    expect(lock.directory).toBe(target);
    expect(existsSync(legacy)).toBe(false);
    expect(accountIn(target)).toBe('kept');
    expect(existsSync(join(target, 'ai-runs', 'run-1'))).toBe(true);
    expect(readFileSync(join(project, '.data-moved-to.txt'), 'utf8')).toContain(target);
    // Still held where it is now.
    expect(() => lockDataDirectory(target)).toThrow(DataDirectoryLocked);

    // Given up where it is now: the owner file there goes too.
    lock.release();
    expect(existsSync(join(target, 'review-desk.owner.json'))).toBe(false);
    expect(existsSync(join(target, 'review-desk.lock-journal'))).toBe(false);
    lockDataDirectory(target).release();
  });

  it('starts afresh in the OS folder when the checkout has no data', async () => {
    const { config, target, legacy } = machine();

    mkdirSync(join(legacy, 'logs'), { recursive: true });

    const { lock, adoption } = await resolve(config);

    expect(adoption).toBeNull();
    expect(lock.directory).toBe(target);
    expect(existsSync(legacy)).toBe(true);
  });

  it('uses data already in the OS folder, and says the checkout’s is ignored', async () => {
    const { config, legacy, target } = machine();

    withData(legacy, 'old');
    withData(target, 'new');

    const { adoption } = await resolve(config);

    expect(adoption).toMatchObject({ outcome: 'kept', from: legacy, to: target });
    expect(accountIn(target)).toBe('new');
    expect(accountIn(legacy)).toBe('old');
  });

  it('counts a database from before Drizzle as data, as migration does', async () => {
    const { config, legacy, target } = machine();

    withData(legacy);
    mkdirSync(target, { recursive: true });

    const old = new DatabaseSync(join(target, 'review-desk.sqlite'));

    old.exec('CREATE TABLE snapshots (id TEXT PRIMARY KEY)');
    old.close();

    expect((await resolve(config)).adoption).toMatchObject({ outcome: 'kept' });
  });

  it('refuses to move into a folder holding anything but data, and touches neither', async () => {
    const { config, legacy, target } = machine();

    withData(legacy);

    // What a start leaves before its database (a lock file among them), an empty database it
    // created, or a log: none of it is data, and none of it is removed.
    for (const leftover of ['residue', 'empty', 'log'] as const) {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(join(target, 'logs'), { recursive: true });

      if (leftover === 'residue') lockDataDirectory(target).release();
      if (leftover === 'empty') new DatabaseSync(join(target, 'review-desk.sqlite')).close();
      if (leftover === 'log') writeFileSync(join(target, 'notes.txt'), 'mine');

      await expect(resolveDataDirectory(config, fast)).rejects.toThrow(DataDirectoryRefused);
      expect(accountIn(legacy)).toBe('kept');
      expect(existsSync(join(target, 'logs'))).toBe(true);
    }

    expect(existsSync(join(target, 'notes.txt'))).toBe(true);
  });

  it('with no data to move, starts over what a stopped start left, but never over a database’s recovery files', async () => {
    const { config, target } = machine();

    mkdirSync(join(target, 'logs'), { recursive: true });
    new DatabaseSync(join(target, 'review-desk.sqlite')).close();

    // A first start that stopped after creating its database, before its first migration.
    (await resolve(config)).lock.release();

    rmSync(join(target, 'review-desk.sqlite'));

    for (const recovery of ['review-desk.sqlite-wal', 'review-desk.sqlite-journal', 'backups']) {
      if (recovery === 'backups') mkdirSync(join(target, recovery));
      else writeFileSync(join(target, recovery), '');

      await expect(resolveDataDirectory(config, fast)).rejects.toThrow(/recover/);
      rmSync(join(target, recovery), { recursive: true });
    }

    writeFileSync(join(target, 'review-desk.sqlite'), 'not a database');
    await expect(resolveDataDirectory(config, fast)).rejects.toThrow(DataDirectoryRefused);

    // A database, but not ours: never migrated over.
    rmSync(join(target, 'review-desk.sqlite'));

    const foreign = new DatabaseSync(join(target, 'review-desk.sqlite'));

    foreign.exec('CREATE TABLE notes (text TEXT)');
    foreign.close();
    await expect(resolveDataDirectory(config, fast)).rejects.toThrow(DataDirectoryRefused);
  });

  it('refuses a checkout folder, or a database in it, that is a link', async () => {
    const { config, legacy, root } = machine();

    withData(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), legacy);
    await expect(resolveDataDirectory(config, fast)).rejects.toThrow(/is a link/);

    rmSync(legacy);
    mkdirSync(legacy);
    symlinkSync(join(root, 'elsewhere', 'review-desk.sqlite'), join(legacy, 'review-desk.sqlite'));
    await expect(resolveDataDirectory(config, fast)).rejects.toThrow(/is a link/);
  });

  it('leaves a checkout folder another process runs on', async () => {
    const { config, legacy } = machine();

    withData(legacy);

    const running = lockDataDirectory(legacy);

    cleanups.push(() => running.release());
    await expect(resolveDataDirectory(config, fast)).rejects.toThrow(DataDirectoryLocked);
    expect(existsSync(legacy)).toBe(true);
  });

  it('stops when the move is not one rename, holding nothing afterwards', async () => {
    const { config, legacy } = machine();

    withData(legacy);

    const crossDevice = () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    };

    await expect(resolveDataDirectory(config, { ...fast, rename: crossDevice })).rejects.toThrow(
      /EXDEV[\s\S]*REVIEW_DESK_DATA_DIR=\.data/,
    );
    expect(accountIn(legacy)).toBe('kept');
    // Every lock it took is given back.
    lockDataDirectory(legacy).release();
  });

  it('decides again when another launch filled the OS folder first', async () => {
    const { config, legacy, target } = machine();

    withData(legacy, 'old');

    const filled = () => {
      withData(target, 'new');
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    };

    expect((await resolve(config, { rename: filled })).adoption).toMatchObject({
      outcome: 'kept',
    });
    expect(accountIn(legacy)).toBe('old');
  });

  it('waits for an earlier agent to finish, and stops when it does not', async () => {
    const { config, legacy, target } = machine();

    withData(legacy);
    mkdirSync(join(legacy, 'ai-runs', 'run-1'), { recursive: true });
    mkdirSync(join(legacy, 'ai-runs', '.locks'), { recursive: true });

    const agent = holdExclusive(join(legacy, 'ai-runs', '.locks', 'run-1.lock'))!;

    await expect(resolveDataDirectory(config, fast)).rejects.toThrow(/still running/);
    expect(existsSync(legacy)).toBe(true);

    // It finishes within the wait: the move goes ahead.
    setTimeout(() => agent.release(), 100);
    expect((await resolve(config, { waitMs: 2_000 })).adoption?.outcome).toBe('moved');
    expect(existsSync(target)).toBe(true);
  });

  it('names an agent lock it cannot use', async () => {
    const { config, legacy } = machine();

    withData(legacy);
    mkdirSync(join(legacy, 'ai-runs', 'run-1'), { recursive: true });
    mkdirSync(join(legacy, 'ai-runs', '.locks'), { recursive: true });
    writeFileSync(join(legacy, 'ai-runs', '.locks', 'run-1.lock'), 'not a database at all, really');

    await expect(resolveDataDirectory(config, fast)).rejects.toThrow(/AI run run-1/);
  });

  it('leaves an override and demo mode where they say', async () => {
    const { project, home } = machine();

    for (const env of [{ REVIEW_DESK_DATA_DIR: 'mine' }, { REVIEW_DESK_MODE: 'demo' }]) {
      const config = loadConfig(['node', 'index.js'], env, {
        platform: 'darwin',
        home,
        root: project,
      });
      const { lock, adoption } = await resolve(config);

      expect(adoption).toBeNull();
      expect(lock.directory).toBe(config.dataDir);
      expect(lock.directory.startsWith(project)).toBe(true);
    }
  });
});
