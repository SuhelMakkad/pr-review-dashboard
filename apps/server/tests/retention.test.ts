import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import type { AiRunStatus } from '@review-desk/shared/ai';
import { FixtureProvider } from '@/ai/fixture.js';
import { agentLockPath } from '@/ai/provider.js';
import { AiRunner } from '@/ai/runner.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { BACKUP_NAME, backupFolder, pruneBackups, writeBackup } from '@/db/backups.js';
import { aiRuns } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { log } from '@/log.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'review-desk-retention-'));

  cleanups.push(() => {
    // A test may have made `backups/` read-only.
    if (existsSync(join(path, 'backups'))) chmodSync(join(path, 'backups'), 0o700);
    rmSync(path, { recursive: true, force: true });
  });

  return path;
}

/** A file last modified `minutesAgo`. */
function file(path: string, minutesAgo: number, content = 'x'): void {
  const at = new Date(Date.now() - minutesAgo * 60_000);

  writeFileSync(path, content);
  utimesSync(path, at, at);
}

/** A database with one table, at `path`. */
function database(path: string): DatabaseSync {
  const db = new DatabaseSync(path);

  db.exec('CREATE TABLE kept (id INTEGER)');
  cleanups.push(() => db.close());

  return db;
}

describe('database backups', () => {
  it('keeps the newest three of the app’s backups in backups/, and touches nothing else', async () => {
    const data = directory();
    const backups = join(data, 'backups');
    const outside = join(data, 'elsewhere.sqlite');

    mkdirSync(backups);
    file(outside, 0);

    // Every name the app has used: by version or migration, plain, timestamped, or with hex.
    const ages: Record<string, number> = {
      'backup-v1.sqlite': 600,
      'backup-v2-1794845016461.sqlite': 500,
      'backup-before-20261106192937_review_freshness.sqlite': 400,
      'backup-before-20261116160251_auto_review_restart-1794845016461.sqlite': 300,
      'backup-before-20261120000000_next-1794845016461-ab12.sqlite': 5,
      'backup-before-a.sqlite': 10,
      'backup-before-b.sqlite': 10,
      'backup-before-c.sqlite': 10,
    };

    for (const [name, age] of Object.entries(ages)) file(join(backups, name), age);

    // Not the app's backups: another name, SQLite's side file, a symlink, and the folder's root.
    file(join(backups, 'my copy.sqlite'), 900);
    file(join(backups, 'backup-before-a.sqlite-wal'), 900);
    symlinkSync(outside, join(backups, 'backup-v9.sqlite'));
    file(join(data, 'backup-v1.sqlite'), 900);

    expect(await pruneBackups(data)).toEqual({ kept: 3, removed: 5, failed: 0, managed: true });
    // The newest, then the same age broken by name.
    expect(readdirSync(backups).sort()).toEqual(
      [
        'backup-before-20261120000000_next-1794845016461-ab12.sqlite',
        'backup-before-c.sqlite',
        'backup-before-b.sqlite',
        'backup-before-a.sqlite-wal',
        'backup-v9.sqlite',
        'my copy.sqlite',
      ].sort(),
    );
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(data, 'backup-v1.sqlite'))).toBe(true);
  });

  it('never prunes through a symlinked backups/, and backs up into the data folder instead', async () => {
    const data = directory();
    const sibling = directory();

    for (const version of [1, 2, 3, 4]) file(join(sibling, `backup-v${version}.sqlite`), 10);
    symlinkSync(sibling, join(data, 'backups'));

    expect(await pruneBackups(data)).toMatchObject({ managed: false, removed: 0 });
    expect(backupFolder(data)).toEqual({ path: data, managed: false });

    const path = join(data, 'review-desk.sqlite');
    const published = writeBackup(database(path), path, 'before-test');

    expect(published).toBe(join(data, 'backup-before-test.sqlite'));
    expect(readdirSync(sibling)).toHaveLength(4);
  });

  it('publishes a complete copy without replacing a file, under a name it then manages', async () => {
    const data = directory();
    const backups = join(data, 'backups');
    const path = join(data, 'review-desk.sqlite');

    mkdirSync(backups);
    file(join(backups, 'backup-before-test.sqlite'), 60, 'an earlier backup');

    const published = writeBackup(database(path), path, 'before-test');

    // The file already at the first name is left byte for byte.
    expect(readFileSync(join(backups, 'backup-before-test.sqlite'), 'utf8')).toBe(
      'an earlier backup',
    );
    expect(basename(published)).toMatch(/^backup-before-test-\d{13}-[0-9a-f]{4}\.sqlite$/);
    expect(BACKUP_NAME.test(basename(published))).toBe(true);
    expect(readdirSync(backups).filter((name) => name.endsWith('.partial'))).toEqual([]);

    const copy = new DatabaseSync(published);

    expect(copy.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toEqual([
      { name: 'kept' },
    ]);
    copy.close();

    // It counts toward the three kept like any other.
    for (const version of [1, 2, 3]) file(join(backups, `backup-v${version}.sqlite`), 120);
    await pruneBackups(data);

    expect(readdirSync(backups).sort()).toEqual(
      [basename(published), 'backup-before-test.sqlite', 'backup-v3.sqlite'].sort(),
    );
  });

  it.skipIf(process.getuid?.() === 0)('counts a backup it cannot remove, and goes on', async () => {
    const data = directory();
    const backups = join(data, 'backups');

    mkdirSync(backups);
    for (const version of [1, 2, 3, 4]) file(join(backups, `backup-v${version}.sqlite`), version);
    chmodSync(backups, 0o500);

    expect(await pruneBackups(data)).toEqual({ kept: 3, removed: 0, failed: 1, managed: true });
  });
});

describe('AI workspaces', () => {
  async function setup(options: { sweepWorkspaces?: boolean } = { sweepWorkspaces: true }) {
    const store = new Store(':memory:');
    const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const events = new EventBus();
    const sync = new SyncService(store, github, events);

    await sync.sync();

    const diffs = new DiffService(github);
    const reviews = new ReviewService(sync, github, diffs, events);
    const providers = {
      codex: new FixtureProvider('codex'),
      claude: new FixtureProvider('claude'),
    };
    const root = directory();
    const exportRepository: RepositoryExporter = async (repository, oid, target) => {
      for (const [path, content] of Object.entries(
        github.scenario.world.repos.files(repository, oid),
      )) {
        mkdirSync(dirname(join(target, path)), { recursive: true });
        writeFileSync(join(target, path), content);
      }

      return [];
    };
    const runner = new AiRunner(
      sync,
      diffs,
      reviews,
      events,
      providers,
      root,
      exportRepository,
      options,
    );
    const seen: string[] = [];

    events.subscribe((stored) => {
      if (stored.event.type === 'ai.updated') seen.push(stored.event.runId ?? '');
    });
    cleanups.push(async () => {
      await runner.close();
      store.close();
    });

    /** A run a previous process left, with its workspace on disk. */
    const leftover = (
      status: AiRunStatus,
      {
        provider = 'codex',
        request = true,
      }: { provider?: 'codex' | 'claude'; request?: boolean } = {},
    ) => {
      const id = randomUUID();

      store.db
        .insert(aiRuns)
        .values({
          id,
          account: 'you',
          prId: 'PR_left_over',
          task: 'full_review',
          provider,
          effort: 'medium',
          headOid: 'a'.repeat(40),
          promptVersion: 1,
          cacheKey: id,
          request: request
            ? { input: '', instructions: '', schema: {}, snapshot: {} as never }
            : null,
          status,
          createdAt: new Date().toISOString(),
        })
        .run();
      mkdirSync(join(root, id, 'after'), { recursive: true });
      writeFileSync(join(root, id, 'after', 'file.ts'), 'x'.repeat(100));

      return id;
    };
    const status = (id: string) =>
      store.db.select().from(aiRuns).where(eq(aiRuns.id, id)).get()?.status;

    return { store, sync, runner, providers, root, leftover, status, seen };
  }

  it('removes the workspaces nothing can use, and keeps every run that could go on', async () => {
    const { runner, root, leftover } = await setup();
    const records: Record<string, unknown>[] = [];

    log.open({ write: (line) => void records.push(JSON.parse(line)) }, 'info');
    cleanups.push(() => log.silence());

    const kept = [
      leftover('paused'),
      leftover('paused', { request: false }),
      leftover('failed'),
      leftover('interrupted'),
    ];
    const abandoned = [
      leftover('done'),
      leftover('cancelled'),
      leftover('failed', { provider: 'claude' }),
      leftover('failed', { request: false }),
      leftover('interrupted', { request: false }),
    ];
    const unknown = randomUUID();

    mkdirSync(join(root, unknown));
    abandoned.push(unknown);

    // An agent of an abandoned run that still holds its lock: left for the next start.
    const locked = leftover('done');

    mkdirSync(dirname(agentLockPath(join(root, locked))), { recursive: true });

    const lock = new DatabaseSync(agentLockPath(join(root, locked)));

    lock.exec('PRAGMA locking_mode = EXCLUSIVE');
    lock.exec('BEGIN EXCLUSIVE');
    cleanups.push(() => lock.close());

    // Never the app's: other names, and a run-named symlink to somewhere else.
    const outside = directory();

    mkdirSync(join(root, 'notes'));
    symlinkSync(outside, join(root, randomUUID()));

    runner.open();
    await runner.cleanedUp();

    for (const id of kept) expect(existsSync(join(root, id))).toBe(true);
    for (const id of abandoned) expect(existsSync(join(root, id))).toBe(false);
    expect(existsSync(join(root, locked))).toBe(true);
    expect(existsSync(join(root, 'notes'))).toBe(true);
    expect(existsSync(join(root, '.locks'))).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(records.filter((record) => record.event === 'ai.workspaces')).toEqual([
      expect.objectContaining({
        kept: kept.length,
        removed: abandoned.length,
        deferred: 1,
        failed: 0,
        keptBytes: kept.length * 100,
        removedBytes: (abandoned.length - 1) * 100,
      }),
    ]);
  });

  it('sweeps only a work root it was told it owns', async () => {
    const { runner, root, leftover } = await setup({});
    const done = leftover('done');

    runner.open();
    await runner.cleanedUp();

    expect(existsSync(join(root, done))).toBe(true);
  });

  it('leaves a paused run and its workspace when the cancelling transaction rolls back', async () => {
    const { store, runner, root, leftover, status, seen } = await setup({});
    const paused = leftover('paused');

    runner.open();
    expect(() =>
      store.transaction(() => {
        runner.cancel('you', paused);
        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');
    await runner.cleanedUp();

    expect(status(paused)).toBe('paused');
    expect(existsSync(join(root, paused))).toBe(true);
    expect(seen).not.toContain(paused);

    // Committed, it is cancelled and its workspace goes, before close returns.
    runner.cancel('you', paused);
    await runner.close();

    expect(status(paused)).toBe('cancelled');
    expect(seen).toContain(paused);
    expect(existsSync(join(root, paused))).toBe(false);
  });

  it('keeps a queued run in the queue when the cancelling transaction rolls back', async () => {
    const { store, sync, runner, providers, status, seen } = await setup({});

    providers.codex.delayMs = 5_000;
    runner.open();

    const prs = sync.list().items.slice(0, 3);
    const runs = [];

    for (const pr of prs) runs.push(await runner.start('you', pr.id, 'full_review'));

    const queued = runs[2];

    expect(status(queued.id)).toBe('queued');
    seen.length = 0;
    expect(() =>
      store.transaction(() => {
        runner.cancel('you', queued.id);
        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');

    expect(status(queued.id)).toBe('queued');
    expect(seen).not.toContain(queued.id);

    // Still queued: cancelling the first lets it start.
    runner.cancel('you', runs[0].id);
    await expect.poll(() => status(queued.id), { timeout: 5_000 }).toBe('running');
  });
});
