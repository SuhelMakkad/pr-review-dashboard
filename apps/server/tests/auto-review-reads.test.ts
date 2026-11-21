import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodexAccountStatus } from '@review-desk/shared/ai';
import { AutoReviewer } from '@/ai/auto-review.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { AiRunner } from '@/ai/runner.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { TestClock } from '@/clock.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { Notifier } from '@/notify/notifier.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';

/**
 * The interpreter's reads, where the rules (`ai/auto-review-rules.ts`) cannot see them: what it
 * never asks for when a rule needs no more, and what admission asks afresh.
 */

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

async function setup() {
  const clock = new TestClock();
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => {
    const scenario = defaultScenario(Date.parse('2026-11-05T10:00:00Z'));

    scenario.world.now = () => clock.now();

    return scenario;
  });
  const events = new EventBus();
  const sync = new SyncService(store, github, events, null, clock);
  const diffs = new DiffService(github);
  const reviews = new ReviewService(sync, github, diffs, events);
  const providers = { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') };
  const root = mkdtempSync(join(tmpdir(), 'review-desk-auto-reads-'));
  const exportRepository: RepositoryExporter = async (repository, oid, directory) => {
    for (const [path, content] of Object.entries(
      github.scenario.world.repos.files(repository, oid),
    )) {
      const target = join(directory, path);

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }

    return [];
  };
  const runner = new AiRunner(sync, diffs, reviews, events, providers, root, exportRepository);

  providers.codex.delayMs = 5;
  runner.open();

  const reviewer = new AutoReviewer(
    sync,
    runner,
    new Notifier(
      store,
      events,
      vi.fn(async () => undefined),
    ),
  );

  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  cleanups.push(() => runner.close());
  runner.onSettled = (row) => reviewer.settled(row);
  runner.onFinished = (row) => reviewer.finished(row);
  sync.afterSync = (login) => reviewer.afterSync(login);
  await sync.sync();

  const enable = () => {
    runner.saveSettings({ ...runner.settings(), autoReview: { enabled: true } });
    reviewer.settingsSaved('you');
  };
  /** #1846, which the scenario's second step requests: there from then. */
  const prId = () =>
    github.scenario.world.pulls.find((pull) => pull.snapshot.number === 1846)!.snapshot.id;

  /** Pushes a commit to #1846 on GitHub. */
  const push = (label: string) => {
    const snapshot = github.scenario.world.pulls.find(
      (pull) => pull.snapshot.number === 1846,
    )!.snapshot;
    const oid = createHash('sha1').update(label).digest('hex');
    const now = new Date(clock.now()).toISOString();

    github.scenario.world.repos.derive(
      snapshot.repository,
      oid,
      snapshot.headOid,
      {
        [`notes/${label}.md`]: `${label}\n`,
      },
      now,
    );
    snapshot.headOid = oid;
    snapshot.headCommittedAt = now;
    snapshot.updatedAt = now;
  };
  /** #1846 asked for again, directly. */
  const askAgain = () => {
    const snapshot = github.scenario.world.pulls.find(
      (pull) => pull.snapshot.number === 1846,
    )!.snapshot;
    const now = new Date(clock.now()).toISOString();

    snapshot.requestEvents.push({
      id: 'req-1846-again',
      createdAt: now,
      removed: false,
      reviewer: { kind: 'user', login: 'you', name: 'you' },
    });
    snapshot.updatedAt = now;
  };

  return { store, github, sync, runner, providers, enable, prId, push, askAgain };
}

describe("the automatic reviewer's reads", () => {
  it('never reads the run in progress while Codex cannot run', async () => {
    const { github, sync, runner, providers, enable, prId: idOf } = await setup();
    const blocked: CodexAccountStatus = { ...providers.codex.account, limitReached: true };
    const plan = vi.spyOn(runner, 'codexStatus').mockResolvedValue(blocked);

    enable();
    // A new direct request on #1846.
    github.advance();
    github.advance();

    const prId = idOf();
    const active = vi.spyOn(runner, 'activeRun');

    await sync.sync();

    expect(plan).toHaveBeenCalled();
    expect(active.mock.calls.filter(([, pr]) => pr === prId)).toEqual([]);
  });

  it('reads the run in progress again inside admission, after start() refreshed the PR', async () => {
    const { github, sync, runner, enable, prId: idOf } = await setup();

    enable();
    github.advance();
    github.advance();

    const prId = idOf();
    const order: string[] = [];
    const active = vi.spyOn(runner, 'activeRun');
    const start = runner.start.bind(runner);

    active.mockImplementation(function (this: AiRunner, ...args) {
      if (args[1] === prId) order.push('activeRun');

      return AiRunner.prototype.activeRun.apply(runner, args);
    });
    vi.spyOn(runner, 'start').mockImplementation(async (...args) => {
      if (args[1] === prId) order.push('start');

      return start(...args);
    });
    await sync.sync();

    expect(order.slice(0, 3)).toEqual(['activeRun', 'start', 'activeRun']);
  });
});

describe("the automatic reviewer's writes", () => {
  it('stops a review once for every request waiting on it', async () => {
    const { github, sync, runner, providers, enable, push, askAgain } = await setup();

    // A review that stays in progress while the PR is asked for again, then pushed to.
    providers.codex.delayMs = 60_000;
    enable();
    github.advance();
    github.advance();
    await sync.sync();
    askAgain();
    await sync.sync();

    const cancel = vi.spyOn(runner, 'cancel');

    push('after-asking-again');
    await sync.sync();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps no secret in the failure it records', async () => {
    const { store, github, sync, runner, enable, prId } = await setup();

    vi.spyOn(runner, 'start').mockRejectedValue(
      new Error('Could not start: ghp_abcdefghijklmnopqrstuvwxyz0123456789 was refused'),
    );
    enable();
    github.advance();
    github.advance();
    await sync.sync();

    const failed = store.autoReviewLog.all('you').find((entry) => entry.prId === prId());

    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed!.error).not.toContain('ghp_');
  });
});
