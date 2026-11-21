import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_REVIEW_QUIET_MS, type CodexAccountStatus } from '@review-desk/shared/ai';
import { AutoReviewer, RESTART_WORK } from '@/ai/auto-review.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { AiRunner } from '@/ai/runner.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { TestClock } from '@/clock.js';
import { aiRuns, autoReviewLog } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { defaultScenario } from '@/demo/scenario.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { Notifier } from '@/notify/notifier.js';
import { ReviewService } from '@/review/service.js';
import { Scheduler } from '@/scheduler/scheduler.js';
import type { PassOutcome } from '@/sync/runner.js';
import { SyncService } from '@/sync/index.js';
import { RecordingClock } from '@test/fixtures/recording-clock.js';

const cleanups: (() => unknown)[] = [];

/** The app's test clock follows real time: a time or delay it computed is off by a few ms. */
const about = (ms: number) => expect.closeTo(ms, -3);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

/**
 * The automatic reviewer with its restarts on the scheduler, wired as the app wires it: the sync's
 * hook hands back the pass without awaiting it. The app's clock moves by hand (`later`); the
 * scheduler's timer fires only when a test fires it (`timers.fire()`).
 */
async function setup() {
  const clock = new TestClock();
  const timers = new RecordingClock(clock);
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
  const root = mkdtempSync(join(tmpdir(), 'review-desk-restart-'));

  providers.codex.delayMs = 5;
  providers.claude.delayMs = 5;
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const exportRepository: RepositoryExporter = async (repository, oid, directory, signal) => {
    for (const [path, content] of Object.entries(
      github.scenario.world.repos.files(repository, oid),
    )) {
      signal.throwIfAborted();

      const target = join(directory, path);

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }

    return [];
  };
  const runner = new AiRunner(sync, diffs, reviews, events, providers, root, exportRepository);

  runner.open();
  cleanups.push(() => runner.close());

  const notifier = new Notifier(
    store,
    events,
    vi.fn(async () => undefined),
  );
  let scheduler = new Scheduler(store, timers, 'boot-1');
  let reviewer = new AutoReviewer(sync, runner, notifier, scheduler);
  /** The pass the last sync's hook handed back. */
  let lastPass: Promise<PassOutcome> = Promise.resolve({ account: 'you', cutoff: null });

  cleanups.push(() => scheduler.close());
  cleanups.push(() => reviewer.close());
  runner.onSettled = (row) => reviewer.settled(row);
  runner.onFinished = (row) => reviewer.finished(row);
  sync.afterSync = async (login) => {
    lastPass = reviewer.afterSync(login);

    return { pass: lastPass };
  };
  scheduler.open();
  reviewer.open();
  await sync.sync();

  const pull = (number: number) =>
    github.scenario.world.pulls.find((candidate) => candidate.snapshot.number === number)!;
  const idOf = (number: number) => pull(number).snapshot.id;
  const stamp = (offsetMs = 0) => new Date(clock.now() + offsetMs).toISOString();
  /** A sync, and the pass its hook started. */
  const synced = async () => {
    await sync.sync();
    await lastPass;
  };
  const enable = () => {
    runner.saveSettings({ ...runner.settings(), autoReview: { enabled: true } });
    reviewer.settingsSaved('you');
  };
  const runs = (number: number) =>
    store.db
      .select()
      .from(aiRuns)
      .all()
      .filter((row) => row.prId === idOf(number));
  const logFor = (number: number) =>
    store.db
      .select()
      .from(autoReviewLog)
      .where(and(eq(autoReviewLog.account, 'you'), eq(autoReviewLog.prId, idOf(number))))
      .all();
  const settled = async () => {
    await vi.waitFor(
      () =>
        expect(
          store.db
            .select()
            .from(aiRuns)
            .all()
            .some((row) => ['queued', 'running'].includes(row.status)),
        ).toBe(false),
      { timeout: 5000, interval: 10 },
    );
  };
  const push = (number: number, label: string) => {
    const snapshot = pull(number).snapshot;
    const oid = createHash('sha1').update(label).digest('hex');

    github.scenario.world.repos.derive(
      snapshot.repository,
      oid,
      snapshot.headOid,
      { [`notes/${label}.md`]: `${label}\n` },
      stamp(),
    );
    snapshot.headOid = oid;
    snapshot.headCommittedAt = stamp();
    snapshot.updatedAt = stamp();

    return oid;
  };
  const later = (ms: number) => clock.advance(ms);
  const work = () => store.scheduledWork.get(RESTART_WORK, 'you');
  /** Fires the restart's wake, and waits until its run has settled. */
  const fired = async () => {
    timers.fire();
    await vi.waitFor(() => expect(work()?.claimedBy ?? null).toBe(null), { timeout: 5000 });
    // Its settlement re-arms in the same turn; let it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** A new process on the same data, once this one has stopped: its own scheduler and reviewer. */
  const reboot = async (bootId: string) => {
    await scheduler.close();
    await reviewer.close();
    scheduler = new Scheduler(store, timers, bootId);
    reviewer = new AutoReviewer(sync, runner, notifier, scheduler);
    cleanups.push(() => scheduler.close());
    cleanups.push(() => reviewer.close());
    scheduler.open();
    reviewer.open();
  };

  /** A review of #1846 stopped by a push: its request waits for the PR to go quiet. */
  const waiting = async () => {
    enable();
    providers.codex.delayMs = 5_000;
    github.advance();
    github.advance();
    await synced();

    const [first] = runs(1846);
    const head = push(1846, 'follow-up');

    await synced();
    providers.codex.delayMs = 5;

    const [entry] = logFor(1846);

    expect(entry).toEqual(expect.objectContaining({ status: 'waiting', headOid: head }));

    return { first, head, restartAt: entry.restartAt! };
  };

  return {
    clock,
    timers,
    store,
    github,
    sync,
    runner,
    providers,
    reviewer: () => reviewer,
    scheduler: () => scheduler,
    enable,
    idOf,
    stamp,
    synced,
    runs,
    logFor,
    settled,
    push,
    later,
    work,
    fired,
    reboot,
    waiting,
  };
}

describe('automatic review restarts on time', () => {
  it('asks for a restart when a review waits, and starts it then, without waiting for a sync', async () => {
    const context = await setup();
    const { timers, sync, runs, settled, later, work, fired } = context;
    const { first, head, restartAt } = await context.waiting();

    expect(work()).toMatchObject({ requestedAt: restartAt, account: 'you', class: 'automation' });
    expect(timers.wakes()).toEqual([about(AUTO_REVIEW_QUIET_MS)]);

    const own = vi.spyOn(sync, 'syncOwn');

    later(AUTO_REVIEW_QUIET_MS);
    await fired();
    await settled();

    expect(own).toHaveBeenCalledTimes(1);
    expect(runs(1846).find((run) => run.id !== first.id)).toEqual(
      expect.objectContaining({ trigger: 'auto', headOid: head }),
    );
    // Nothing more waits: nothing more is asked for.
    expect(work()).toBeUndefined();
    expect(timers.wakes()).toEqual([]);
  });

  it('puts the restart off without a sync when another push moved it later', async () => {
    const context = await setup();
    const { timers, sync, synced, logFor, push, later, work, fired } = context;
    const { restartAt } = await context.waiting();

    later(2 * 60_000);
    push(1846, 'second-push');
    await synced();

    const moved = logFor(1846)[0].restartAt!;

    expect(Date.parse(moved)).toBeGreaterThan(Date.parse(restartAt));
    // The earliest ask stands until it fires.
    expect(work()).toMatchObject({ requestedAt: restartAt });

    const own = vi.spyOn(sync, 'syncOwn');

    later(AUTO_REVIEW_QUIET_MS - 2 * 60_000);
    await fired();

    expect(own).not.toHaveBeenCalled();
    expect(work()).toMatchObject({ requestedAt: moved, claimedBy: null });
    expect(timers.wakes()).toEqual([about(2 * 60_000)]);
  });

  it('leaves an account not in use, and asks again once it is in use, an overdue restart included', async () => {
    const context = await setup();
    const { timers, sync, runs, settled, later, work, fired } = context;
    const { first, restartAt } = await context.waiting();
    const status = sync.status;
    const own = vi.spyOn(sync, 'syncOwn');

    sync.status = { ...status, account: { ...status.account!, login: 'someone-else' } };
    sync.events.emit({ type: 'status', status: sync.status });
    later(AUTO_REVIEW_QUIET_MS);
    await fired();

    expect(own).not.toHaveBeenCalled();
    expect(work()).toBeUndefined();

    // In use again: its overdue restart is asked for at once.
    sync.status = status;
    sync.events.emit({ type: 'status', status: sync.status });

    expect(work()).toMatchObject({ requestedAt: restartAt });
    expect(timers.wakes()).toEqual([100]);

    await fired();
    await settled();

    expect(runs(1846).filter((run) => run.id !== first.id)).toHaveLength(1);
  });

  it("asks for an overdue restart when it starts, waiting out the account's cooldown", async () => {
    const context = await setup();
    const { timers, store, sync, later, work, reboot, stamp } = context;
    const { restartAt } = await context.waiting();

    later(AUTO_REVIEW_QUIET_MS + 60_000);
    store.scheduledWork.delete({ kind: RESTART_WORK, key: 'you' });
    sync.deferUntil(stamp(120_000), 'you');
    await reboot('boot-2');

    expect(work()).toMatchObject({ requestedAt: restartAt, notBefore: sync.cooldown('you') });
    expect(timers.wakes()).toEqual([about(120_000)]);
  });

  it('waits out a cooldown met as the restart syncs, counting no attempt', async () => {
    const context = await setup();
    const { sync, later, work, fired, stamp } = context;

    await context.waiting();
    later(AUTO_REVIEW_QUIET_MS);
    sync.deferUntil(stamp(600_000), 'you');
    await fired();

    expect(work()).toMatchObject({ notBefore: sync.cooldown('you'), attempts: 0 });
  });

  it('backs off when the sync for a restart missed automatic review', async () => {
    const context = await setup();
    const { sync, later, work, fired, stamp } = context;

    await context.waiting();
    later(AUTO_REVIEW_QUIET_MS);

    const hook = sync.afterSync;

    sync.afterSync = async () => {
      throw new Error('hook failed');
    };
    await fired();
    sync.afterSync = hook;

    expect(work()).toMatchObject({ attempts: 1 });
    expect(Date.parse(work()!.notBefore!)).toEqual(about(Date.parse(stamp(30_000))));
    expect(work()!.lastError).toContain('did not reach automatic review');
  });

  it('waits out a cooldown a pass ran into before the sync saved it', async () => {
    const context = await setup();
    const { sync, later, work, fired, stamp } = context;

    await context.waiting();
    later(AUTO_REVIEW_QUIET_MS);
    // The sync's hook ran, and its pass started nothing, before the sync saved its rate limit.
    vi.spyOn(sync, 'syncOwn').mockImplementationOnce(async (account) => {
      sync.deferUntil(stamp(600_000), account);

      return {
        kind: 'synced',
        account,
        hooked: { pass: Promise.resolve({ account, cutoff: context.clock.now() - 1 }) },
      };
    });
    await fired();

    expect(work()).toMatchObject({ notBefore: sync.cooldown('you'), attempts: 0 });
  });

  it('leaves a restart a pass looked at and could not start to the next sync', async () => {
    const context = await setup();
    const { runner, providers, later, work, fired, logFor } = context;

    await context.waiting();
    vi.spyOn(runner, 'codexStatus').mockResolvedValue({
      ...providers.codex.account,
      limitReached: true,
    } as CodexAccountStatus);
    later(AUTO_REVIEW_QUIET_MS);
    await fired();

    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'waiting' })]);
    expect(work()).toBeUndefined();
  });

  it('asks again for a restart that fell due while a pass ran', async () => {
    const context = await setup();
    const { timers, store, sync, synced, later, work } = context;
    const { restartAt } = await context.waiting();
    const listFor = sync.listFor.bind(sync);

    later(AUTO_REVIEW_QUIET_MS - 5_000);
    store.scheduledWork.delete({ kind: RESTART_WORK, key: 'you' });
    // The pass reads its cutoff, then its list, which takes past the restart's time.
    vi.spyOn(sync, 'listFor').mockImplementation((account) => {
      if (new Error().stack?.includes('AutoReviewer.pass')) later(10_000);

      return listFor(account);
    });
    await synced();

    expect(work()).toMatchObject({ requestedAt: restartAt });
    expect(timers.wakes()).toEqual([100]);
  });

  it('asks for the restart of a review found outdated as it finished, with no pass after', async () => {
    const context = await setup();
    const { github, providers, runs, logFor, settled, push, work, synced } = context;

    context.enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await synced();

    const [first] = runs(1846);

    // Pushed while it runs; no sync sees it before the review finishes.
    push(1846, 'pushed-before-finishing');
    await settled();
    await vi.waitFor(() =>
      expect(logFor(1846)).toEqual([
        expect.objectContaining({ status: 'waiting', runId: first.id }),
      ]),
    );

    expect(work()).toMatchObject({ requestedAt: logFor(1846)[0].restartAt });
  });

  it('defers a restart whose sync missed automatic review while the account cools down', async () => {
    const context = await setup();
    const { sync, later, work, fired, stamp } = context;

    await context.waiting();
    later(AUTO_REVIEW_QUIET_MS);
    // A rate limit met reading teams: the hook never ran, and the cooldown was saved.
    vi.spyOn(sync, 'syncOwn').mockImplementationOnce(async (account) => {
      sync.deferUntil(stamp(600_000), account);

      return { kind: 'missed', account };
    });
    await fired();

    expect(work()).toMatchObject({ notBefore: sync.cooldown('you'), attempts: 0 });
  });

  it('never asks again for a restart its pass looked at, at its very time', async () => {
    const context = await setup();
    const { clock, runner, providers, store, synced, work } = context;
    const { restartAt } = await context.waiting();

    vi.spyOn(runner, 'codexStatus').mockResolvedValue({
      ...providers.codex.account,
      limitReached: true,
    } as CodexAccountStatus);
    store.scheduledWork.delete({ kind: RESTART_WORK, key: 'you' });

    // Held still, so the pass's cutoff is the restart's very time.
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());

    clock.set(Date.parse(restartAt));
    await synced();
    frozen.mockRestore();

    expect(work()).toBeUndefined();
  });

  it('releases a restart stopped by shutdown as it was', async () => {
    const context = await setup();
    const { timers, sync, later, work } = context;
    const { restartAt } = await context.waiting();

    later(AUTO_REVIEW_QUIET_MS);
    // A pass that never ends: the restart is still waiting for it at shutdown.
    sync.afterSync = async () => ({ pass: new Promise<PassOutcome>(() => undefined) });
    timers.fire();
    await vi.waitFor(() => expect(work()?.claimedBy).toBe('boot-1'));
    await context.scheduler().close();

    expect(work()).toMatchObject({
      requestedAt: restartAt,
      claimedBy: null,
      attempts: 0,
      notBefore: null,
    });
  });
});

describe('a pass for each call', () => {
  it('resolves a call made during a pass with the follow-up, and one superseded with nothing', async () => {
    const context = await setup();
    const reviewer = context.reviewer();
    const order: string[] = [];
    const first = reviewer.afterSync('you');
    const second = reviewer.afterSync('you');
    const again = reviewer.afterSync('you');

    expect(second).not.toBe(first);
    expect(again).toBe(second);

    void first.then(() => order.push('first'));
    void second.then((outcome) => order.push(`second:${outcome.cutoff === null ? 'none' : 'ran'}`));

    const other = reviewer.afterSync('someone-else');

    await Promise.all([first, second, other]);

    // Taken over by another account's call: its pass never came.
    expect(await second).toEqual({ account: 'you', cutoff: null });
    expect(order[0]).toBe('second:none');
  });
});
