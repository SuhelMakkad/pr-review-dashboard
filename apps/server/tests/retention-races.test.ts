import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureProvider } from '@/ai/fixture.js';
import { AiRunner } from '@/ai/runner.js';
import { pruneBackups } from '@/db/backups.js';
import { aiRuns } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';

/** Runs before each `lstat`, asynchronous or not, so a test can change the disk at that moment. */
const hook = vi.hoisted(() => ({
  before: null as null | ((path: string) => Promise<void> | void),
  beforeSync: null as null | ((path: string) => void),
}));

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();

  return {
    ...actual,
    lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
      hook.beforeSync?.(String(args[0]));

      return actual.lstatSync(...args);
    }) as typeof actual.lstatSync,
  };
});

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();

  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      await hook.before?.(String(args[0]));

      return actual.lstat(...args);
    },
  };
});

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  hook.before = null;
  hook.beforeSync = null;

  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'review-desk-races-'));

  cleanups.push(() => rmSync(path, { recursive: true, force: true }));

  return path;
}

async function runnerWith(root: string) {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events);
  const diffs = new DiffService(github);
  const runner = new AiRunner(
    sync,
    diffs,
    new ReviewService(sync, github, diffs, events),
    events,
    { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') },
    root,
    async () => [],
    { sweepWorkspaces: true },
  );

  cleanups.push(async () => {
    await runner.close();
    store.close();
  });

  /** A done run a previous process left, with its workspace. */
  const done = () => {
    const id = randomUUID();

    store.db
      .insert(aiRuns)
      .values({
        id,
        account: 'you',
        prId: 'PR_left_over',
        task: 'full_review',
        provider: 'codex',
        effort: 'medium',
        headOid: 'a'.repeat(40),
        promptVersion: 1,
        cacheKey: id,
        status: 'done',
        createdAt: new Date().toISOString(),
      })
      .run();
    mkdirSync(join(root, id, 'after'), { recursive: true });
    writeFileSync(join(root, id, 'after', 'file.ts'), 'x');

    return id;
  };

  return { runner, done };
}

describe('retention races', () => {
  it('starts no removal when shutdown begins while the workspace is being looked at', async () => {
    const root = directory();
    const { runner, done } = await runnerWith(root);
    const id = done();
    const workspace = join(root, id);
    let closing: Promise<void> | null = null;

    // Shutdown begins during the inventory, at the workspace's last file.
    hook.before = (path) => {
      if (path === join(workspace, 'after', 'file.ts')) closing ??= runner.close();
    };

    runner.open();
    await runner.cleanedUp();
    await closing;

    expect(closing).not.toBeNull();
    expect(existsSync(workspace)).toBe(true);
  });

  it('never follows or removes a workspace swapped for a symlink before it is looked at', async () => {
    const root = directory();
    const elsewhere = directory();
    const { runner, done } = await runnerWith(root);
    const id = done();
    const workspace = join(root, id);

    writeFileSync(join(elsewhere, 'keep.txt'), 'not the app’s');

    const looked: string[] = [];

    // Between the listing and the first look, the directory becomes a symlink to elsewhere.
    hook.before = (path) => {
      looked.push(path);
      if (path !== workspace || !existsSync(join(workspace, 'after'))) return;

      renameSync(workspace, `${workspace}.moved`);
      symlinkSync(elsewhere, workspace);
    };

    runner.open();
    await runner.cleanedUp();

    // Still the symlink, its target intact, and nothing under it was ever looked at.
    expect(lstatSync(workspace).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('not the app’s');
    expect(looked.filter((path) => path.startsWith(`${workspace}/`))).toEqual([]);
  });

  it('keeps a backup restored under an old name after the backups were ranked', async () => {
    const data = directory();
    const backups = join(data, 'backups');
    const now = Date.now();

    mkdirSync(backups);

    for (const [name, minutes] of [
      ['backup-v1.sqlite', 400],
      ['backup-v2.sqlite', 30],
      ['backup-v3.sqlite', 20],
      ['backup-v4.sqlite', 10],
    ] as const) {
      writeFileSync(join(backups, name), 'old');
      utimesSync(
        join(backups, name),
        new Date(now - minutes * 60_000),
        new Date(now - minutes * 60_000),
      );
    }

    // The oldest is ranked for removal; then, just before its last check, a fresh copy is
    // restored under its name.
    hook.beforeSync = (path) => {
      if (path !== join(backups, 'backup-v1.sqlite')) return;

      hook.beforeSync = null;
      writeFileSync(join(backups, 'restored.tmp'), 'restored');
      renameSync(join(backups, 'restored.tmp'), join(backups, 'backup-v1.sqlite'));
    };

    expect(await pruneBackups(data)).toMatchObject({ removed: 0, failed: 0 });
    expect(readFileSync(join(backups, 'backup-v1.sqlite'), 'utf8')).toBe('restored');
  });
});
