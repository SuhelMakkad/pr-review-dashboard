import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createApp } from '@/app.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { AiRunner } from '@/ai/runner.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { aiRuns, autoReviewLog } from '@/db/schema.js';
import { AutoReviewer, autoReviewCandidates } from '@/ai/auto-review.js';
import { TestClock } from '@/clock.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { GitHubError } from '@/github/errors.js';
import { defaultScenario, type ScenarioPull } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { Notifier } from '@/notify/notifier.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';
import {
  AUTO_REVIEW_QUIET_MS,
  type AiReviewStatus,
  type CodexAccountStatus,
} from '@review-desk/shared/ai';
import { defaultNotificationSettings, type ReviewNotification } from '@review-desk/shared/notify';

const cleanups: (() => unknown)[] = [];

/** The app's clock in each test, moved by `later()`; the process's own clock is never touched. */
let clock = new TestClock();
/** A timestamp on the test clock, `offsetMs` from now. */
const stamp = (offsetMs = 0) => new Date(clock.now() + offsetMs).toISOString();
/** The fixture forge reads the same clock as the app. */
const onClock = <T extends { world: { now: () => number } }>(scenario: T): T => {
  scenario.world.now = () => clock.now();

  return scenario;
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

const direct = { kind: 'user' as const, login: 'you', name: 'you' };
const platformTeam = { kind: 'team' as const, login: 'acme/platform', name: 'Platform' };

async function setup() {
  clock = new TestClock();

  const store = new Store(':memory:');
  const github = new FixtureGitHub(() =>
    onClock(defaultScenario(Date.parse('2026-11-05T10:00:00Z'))),
  );
  const events = new EventBus();
  const sync = new SyncService(store, github, events, null, clock);
  const diffs = new DiffService(github);
  const reviews = new ReviewService(sync, github, diffs, events);
  const providers = { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') };
  const root = mkdtempSync(join(tmpdir(), 'review-desk-auto-review-'));

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
  const notifier = new Notifier(
    store,
    events,
    vi.fn(async () => undefined),
  );
  const notified: ReviewNotification[] = [];
  let reviewer = new AutoReviewer(sync, runner, notifier);

  cleanups.push(() => runner.close());
  events.subscribe((stored) => {
    if (stored.event.type === 'notify') notified.push(...stored.event.notifications);
  });
  runner.onSettled = (row) => reviewer.settled(row);
  runner.onFinished = (row) => reviewer.finished(row);
  // The app does not await the pass; tests do, so each sync's outcome is settled.
  sync.afterSync = async (login) => {
    await notifier.afterSync(login, sync.list().items, sync.mine().items);
    await reviewer.afterSync(login);
  };
  await sync.sync();

  const pull = (number: number) =>
    github.scenario.world.pulls.find((candidate) => candidate.snapshot.number === number)!;
  const idOf = (number: number) => pull(number).snapshot.id;

  /** A new PR on GitHub, reusing #1839's commits so its diff and repository exist. */
  const addPull = (
    number: number,
    changes: Partial<ScenarioPull['snapshot']>,
    feeds = ['requested'],
  ) => {
    const now = stamp();
    const added = structuredClone(pull(1839));

    added.feeds = feeds as ScenarioPull['feeds'];
    added.snapshot = {
      ...added.snapshot,
      id: `PR_acme_web_${number}`,
      number,
      title: `Incoming change ${number}`,
      url: `https://github.com/acme/web/pull/${number}`,
      createdAt: now,
      updatedAt: now,
      reviewRequests: [],
      requestEvents: [],
      ...changes,
    };
    github.scenario.world.pulls.push(added);

    return added;
  };
  const requestEvent = (id: string, reviewer: typeof direct | typeof platformTeam) => ({
    id,
    createdAt: stamp(),
    removed: false,
    reviewer,
  });

  const enable = (enabled = true) => {
    runner.saveSettings({ ...runner.settings(), autoReview: { enabled } });
    reviewer.settingsSaved('you');
  };
  const runs = (number?: number) =>
    store.db
      .select()
      .from(aiRuns)
      .all()
      .filter((row) => number === undefined || row.prId === idOf(number));
  const logFor = (number: number) =>
    store.db
      .select()
      .from(autoReviewLog)
      .where(and(eq(autoReviewLog.account, 'you'), eq(autoReviewLog.prId, idOf(number))))
      .all();
  const settled = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!runs().some((row) => ['queued', 'running'].includes(row.status))) return;

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('runs did not settle');
  };
  const restart = () => {
    reviewer = new AutoReviewer(sync, runner, notifier);
  };

  /** Pushes a commit to the PR on GitHub. The app sees it on its next sync or refresh. */
  const push = (number: number, label: string, committedAt = stamp()) => {
    const snapshot = pull(number).snapshot;
    const oid = createHash('sha1').update(label).digest('hex');

    github.scenario.world.repos.derive(
      snapshot.repository,
      oid,
      snapshot.headOid,
      { [`notes/${label}.md`]: `${label}\n` },
      committedAt,
    );
    snapshot.headOid = oid;
    snapshot.headCommittedAt = committedAt;
    snapshot.updatedAt = stamp();

    return oid;
  };

  /** Moves the app's clock, and the fixture forge's, forward. */
  const later = (ms: number) => clock.advance(ms);

  return {
    store,
    github,
    sync,
    reviews,
    runner,
    providers,
    notifier,
    notified,
    pull,
    idOf,
    addPull,
    requestEvent,
    enable,
    runs,
    logFor,
    settled,
    restart,
    push,
    later,
    restarts: () => reviewer.restarts('you'),
    paused: () => reviewer.pausedRestarts('you'),
  };
}

describe('automatic review', () => {
  it('is off by default', async () => {
    const { github, sync, runs } = await setup();

    github.advance();
    github.advance();
    await sync.sync();

    expect(runs()).toEqual([]);
  });

  it('records the waiting backlog when turned on, then reviews only new requests', async () => {
    const { github, sync, enable, runs, settled, logFor } = await setup();

    enable();
    await sync.sync();
    expect(runs()).toEqual([]);
    expect(logFor(1839)).toEqual([expect.objectContaining({ status: 'primed' })]);

    // The second scripted step is a new direct request on #1846.
    github.advance();
    github.advance();
    await sync.sync();
    await sync.sync();

    expect(runs()).toEqual([
      expect.objectContaining({ task: 'full_review', trigger: 'auto', provider: 'codex' }),
    ]);
    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'started', runId: runs(1846)[0].id }),
    ]);

    await settled();
    expect(runs(1846)[0].status).toBe('done');
  });

  it('stops at the finished report: nothing is prepared or sent to GitHub', async () => {
    const { github, sync, reviews, enable, runs, settled, idOf } = await setup();

    enable();
    github.advance();
    github.advance();
    await sync.sync();
    await settled();

    expect(runs(1846)[0].status).toBe('done');
    expect(github.writes).toEqual([]);

    const draft = reviews.draft('you', idOf(1846));

    expect(draft.comments).toEqual([]);
    expect(draft.preparedReview ?? null).toBeNull();
  });

  it('reviews a PR you added by hand, without announcing it as a review request', async () => {
    const { sync, enable, runs, settled, notified, idOf } = await setup();

    enable();
    await sync.sync();
    await sync.track('you', 'acme/api', 2066);
    await sync.sync();
    await settled();
    await sync.sync();

    expect(runs(2066)).toEqual([expect.objectContaining({ trigger: 'auto', status: 'done' })]);
    expect(notified.filter((item) => item.prId === idOf(2066)).map((item) => item.kind)).toEqual([
      'ai_review_ready',
    ]);
  });

  it('reviews team requests, assignments and re-requests once each', async () => {
    const { sync, pull, addPull, requestEvent, enable, runs, settled } = await setup();

    enable();
    addPull(9001, {
      reviewRequests: [platformTeam],
      requestEvents: [requestEvent('req-9001', platformTeam)],
    });
    addPull(9002, {}, ['assigned']);

    const rerequested = pull(877).snapshot;

    rerequested.requestEvents.push(requestEvent('req-877-3', direct));
    rerequested.updatedAt = stamp();

    await sync.sync();
    await sync.sync();
    await settled();
    await sync.sync();

    expect(runs(9001)).toEqual([expect.objectContaining({ trigger: 'auto' })]);
    expect(runs(9002)).toEqual([expect.objectContaining({ trigger: 'auto' })]);
    expect(runs(877)).toEqual([expect.objectContaining({ trigger: 'auto' })]);
    expect(runs()).toHaveLength(3);
  });

  it('waits for a draft PR to be ready for review', async () => {
    const { sync, pull, addPull, requestEvent, enable, runs, settled } = await setup();

    enable();
    addPull(9003, {
      isDraft: true,
      reviewRequests: [direct],
      requestEvents: [requestEvent('req-9003', direct)],
    });
    await sync.sync();
    expect(runs(9003)).toEqual([]);

    pull(9003).snapshot.isDraft = false;
    pull(9003).snapshot.updatedAt = stamp();
    await sync.sync();
    await settled();

    expect(runs(9003)).toEqual([expect.objectContaining({ trigger: 'auto', status: 'done' })]);
  });

  it('never replaces a run you paused', async () => {
    const { sync, pull, runner, providers, requestEvent, enable, runs, logFor, idOf } =
      await setup();

    enable();
    providers.codex.delayMs = 5_000;

    const manual = await runner.start('you', idOf(877), 'full_review');

    runner.pause('you', manual.id);

    pull(877).snapshot.requestEvents.push(requestEvent('req-877-3', direct));
    pull(877).snapshot.updatedAt = stamp();
    await sync.sync();

    expect(runs(877)).toEqual([
      expect.objectContaining({ id: manual.id, status: 'paused', pauseReason: 'user' }),
    ]);
    expect(logFor(877)).toContainEqual(
      expect.objectContaining({ status: 'skipped', runId: manual.id }),
    );
  });

  it('waits while the ChatGPT plan is used up, then starts', async () => {
    const { github, sync, runner, providers, enable, runs, logFor, settled } = await setup();
    const blocked: CodexAccountStatus = { ...providers.codex.account, limitReached: true };
    const status = vi.spyOn(runner, 'codexStatus').mockResolvedValue(blocked);

    enable();
    github.advance();
    github.advance();
    await sync.sync();

    expect(runs()).toEqual([]);
    expect(logFor(1846)).toEqual([]);

    status.mockRestore();
    await sync.sync();
    await settled();

    expect(runs(1846)).toEqual([expect.objectContaining({ trigger: 'auto', status: 'done' })]);
  });

  it('reviews requests that arrived while the server was down, but not the backlog', async () => {
    const { github, sync, enable, runs, restart } = await setup();

    enable();
    await sync.sync();

    github.advance();
    github.advance();
    restart();
    await sync.sync();

    expect(runs()).toEqual([expect.objectContaining({ trigger: 'auto' })]);
    expect(runs(1846)).toHaveLength(1);
  });

  it('treats requests made before it was turned on as backlog, even when found later', async () => {
    const { sync, addPull, requestEvent, enable, runs, logFor } = await setup();
    const hourAgo = stamp(-3_600_000);

    enable();
    // Neither PR was cached when it was turned on: GitHub only returns them now.
    addPull(9004, {
      reviewRequests: [direct],
      requestEvents: [{ ...requestEvent('req-9004', direct), createdAt: hourAgo }],
    });
    addPull(9005, { createdAt: hourAgo, updatedAt: hourAgo }, ['assigned']);
    await sync.sync();
    await sync.sync();

    expect(runs()).toEqual([]);
    expect(logFor(9004)).toEqual([expect.objectContaining({ status: 'primed' })]);
    expect(logFor(9005)).toEqual([expect.objectContaining({ status: 'primed' })]);
  });

  it('starts nothing once turned off, even mid-way through starting a review', async () => {
    const { github, sync, runner, enable, runs, logFor } = await setup();
    const refresh = sync.refresh.bind(sync);

    enable();
    github.advance();
    github.advance();
    // Turned off while start() is refreshing the PR, after the pass decided to review it.
    vi.spyOn(sync, 'refresh').mockImplementation(async (id) => {
      enable(false);

      return refresh(id);
    });
    await sync.sync();

    expect(runner.settings().autoReview.enabled).toBe(false);
    expect(runs()).toEqual([]);
    expect(logFor(1846)).toEqual([]);
  });

  it('does not start when the refreshed PR turned out to be a draft, then waits for it', async () => {
    const { github, sync, pull, enable, runs, logFor, settled } = await setup();
    const refresh = sync.refresh.bind(sync);

    enable();
    github.advance();
    github.advance();

    // The cached PR is ready for review; GitHub says it was converted to a draft.
    const toDraft = vi.spyOn(sync, 'refresh').mockImplementation(async (id) => {
      pull(1846).snapshot.isDraft = true;

      return refresh(id);
    });

    await sync.sync();
    expect(runs()).toEqual([]);
    expect(logFor(1846)).toEqual([]);

    toDraft.mockRestore();
    pull(1846).snapshot.isDraft = false;
    pull(1846).snapshot.updatedAt = stamp();
    await sync.sync();
    await settled();

    expect(runs(1846)).toEqual([expect.objectContaining({ trigger: 'auto', status: 'done' })]);
  });

  it('does not start when the request was withdrawn, and stops trying', async () => {
    const { github, sync, pull, idOf, enable, runs, logFor } = await setup();
    const refresh = sync.refresh.bind(sync);

    enable();
    github.advance();
    github.advance();

    // GitHub search still lists the PR as requested, but the refreshed PR has no request.
    const withdraw = vi.spyOn(sync, 'refresh').mockImplementation(async (id) => {
      const withdrawn = pull(1846).snapshot;

      withdrawn.reviewRequests = [];
      withdrawn.requestEvents.push({
        ...withdrawn.requestEvents[0],
        id: 'req-1846-removed',
        removed: true,
      });

      return refresh(id);
    });

    await sync.sync();
    expect(runs()).toEqual([]);
    expect(logFor(1846)).toEqual([]);

    withdraw.mockClear();
    await sync.sync();

    expect(withdraw).not.toHaveBeenCalledWith(idOf(1846));
    expect(runs()).toEqual([]);
  });

  it('does not review requests that arrived while it was off', async () => {
    const { github, sync, runner, enable, runs } = await setup();

    enable();
    const since = runner.settings().autoReview.since;

    expect(since).toEqual(expect.any(String));
    enable();
    expect(runner.settings().autoReview.since).toBe(since);

    enable(false);
    expect(runner.settings().autoReview).toEqual({ enabled: false, since: null });

    github.advance();
    github.advance();
    await sync.sync();

    enable();
    await sync.sync();

    expect(runs()).toEqual([]);
  });

  it('loads settings saved before automatic review existed as off', async () => {
    const { store, runner } = await setup();
    const { autoReview: _ignored, ...older } = runner.settings();

    store.setSetting('ai-settings', older);

    expect(runner.settings().autoReview).toEqual({ enabled: false, since: null });
  });

  it('announces a finished automatic review once', async () => {
    const { github, sync, enable, notified, settled, runs } = await setup();

    enable();
    github.advance();
    github.advance();
    await sync.sync();
    await settled();
    await sync.sync();

    expect(notified.filter((notification) => notification.kind === 'ai_review_ready')).toEqual([
      {
        key: `ai:${runs(1846)[0].id}`,
        kind: 'ai_review_ready',
        prId: runs(1846)[0].prId,
        title: 'web#1846 · Reminder banner for upcoming events',
        body: expect.stringMatching(/^AI review ready · /),
        path: '/inbox/attention/acme/web/1846',
      },
    ]);
  });

  it('announces nothing about a review that finished after you switched accounts', async () => {
    const { github, sync, providers, enable, notified, settled, runs } = await setup();
    const run = providers.codex.run.bind(providers.codex);

    enable();
    // Another account is in use by the time the review finishes.
    vi.spyOn(providers.codex, 'run').mockImplementationOnce(async (...args) => {
      Object.assign(sync.status, { account: { login: 'someone-else' } });

      return run(...args);
    });
    github.advance();
    github.advance();
    await sync.sync();
    await settled();

    expect(runs(1846)).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(notified.filter((notification) => notification.kind === 'ai_review_ready')).toEqual([]);
  });

  it('says when an automatic review failed', async () => {
    const { github, sync, providers, enable, notified, settled } = await setup();

    enable();
    providers.codex.failNext = 'The agent crashed.';
    github.advance();
    github.advance();
    await sync.sync();
    await settled();

    expect(notified).toContainEqual(
      expect.objectContaining({
        kind: 'ai_review_ready',
        body: 'Automatic AI review failed. Open the PR to run it again.',
      }),
    );
  });

  it('stays quiet when the kind is off and for runs you start yourself', async () => {
    const { github, sync, runner, notifier, enable, notified, settled, idOf } = await setup();
    const defaults = defaultNotificationSettings();

    await runner.start('you', idOf(1839), 'full_review');
    await settled();

    notifier.saveSettings({ ...defaults, kinds: { ...defaults.kinds, ai_review_ready: false } });
    enable();
    github.advance();
    github.advance();
    await sync.sync();
    await settled();

    expect(notified.filter((notification) => notification.kind === 'ai_review_ready')).toEqual([]);
  });
});

describe('automatic review after new commits', () => {
  /** Turns it on and starts a long automatic review of the new request on #1846. */
  async function reviewing() {
    const context = await setup();
    const { github, sync, providers, enable, runs } = context;

    enable();
    providers.codex.delayMs = 5_000;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);

    expect(first).toEqual(
      expect.objectContaining({ trigger: 'auto', status: expect.stringMatching(/queued|running/) }),
    );

    return { ...context, first };
  }

  it('stops the running review, waits for the PR to go quiet, then reviews the new head', async () => {
    const {
      sync,
      providers,
      runs,
      logFor,
      settled,
      push,
      later,
      restarts,
      paused,
      notified,
      idOf,
      first,
    } = await reviewing();
    const head = push(1846, 'follow-up');

    await sync.sync();

    expect(runs(1846)).toEqual([expect.objectContaining({ id: first.id, status: 'cancelled' })]);

    const [waiting] = logFor(1846);

    expect(waiting).toEqual(
      expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
    );
    expect(Date.parse(waiting.restartAt!) - Date.parse(waiting.updatedAt)).toBeGreaterThanOrEqual(
      AUTO_REVIEW_QUIET_MS - 1_000,
    );
    expect(restarts()).toEqual(new Map([[idOf(1846), waiting.restartAt]]));
    expect(paused()).toEqual(new Set());

    // Read while another account is in use: no countdown runs for it, and the restart waits.
    const status = sync.status;

    sync.status = { ...status, account: { ...status.account!, login: 'someone-else' } };
    expect(restarts()).toEqual(new Map());
    expect(paused()).toEqual(new Set([idOf(1846)]));
    sync.status = status;

    // Not yet quiet for long enough.
    later(AUTO_REVIEW_QUIET_MS - 60_000);
    await sync.sync();
    expect(runs(1846)).toHaveLength(1);

    providers.codex.delayMs = 5;
    later(60_000);
    await sync.sync();
    await settled();

    const fresh = runs(1846).find((run) => run.id !== first.id);

    expect(fresh).toEqual(
      expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
    );
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'started', runId: fresh!.id, restartAt: null }),
    ]);
    expect(restarts()).toEqual(new Map());
    await vi.waitFor(() =>
      expect(notified.filter((item) => item.kind === 'ai_review_ready')).toEqual([
        expect.objectContaining({ key: `ai:${fresh!.id}` }),
      ]),
    );
  });

  it('stamps a whole cycle from the app clock, never from the process clock', async () => {
    const context = await setup();
    const { github, sync, providers, enable, runs, logFor, settled, push, later, notified } =
      context;

    // Far from the process's own time, so a stamp taken from it would stand out.
    later(30 * 86_400_000);
    enable();
    providers.codex.delayMs = 5_000;
    github.advance();
    github.advance();
    await sync.sync();

    push(1846, 'follow-up');
    await sync.sync();

    const waiting = logFor(1846);

    providers.codex.delayMs = 5;
    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    await settled();

    const [first, fresh] = runs(1846);
    const [restarted] = logFor(1846);
    /** Set, and on the app's clock: a month past the process's own, at most a quiet period ahead. */
    const onAppClock = (value: string | null | undefined) => {
      expect(value).toEqual(expect.any(String));
      expect(Date.parse(value!)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect(Date.parse(value!)).toBeLessThanOrEqual(clock.now() + AUTO_REVIEW_QUIET_MS);
    };

    expect(waiting).toEqual([expect.objectContaining({ status: 'waiting', runId: first.id })]);
    onAppClock(waiting[0].updatedAt);
    onAppClock(waiting[0].restartAt);
    onAppClock(waiting[0].waitingSince);

    expect(restarted).toEqual(expect.objectContaining({ status: 'started', runId: fresh.id }));
    onAppClock(restarted.updatedAt);

    expect(first).toEqual(expect.objectContaining({ status: 'cancelled' }));
    onAppClock(first.createdAt);
    onAppClock(first.finishedAt);

    expect(fresh).toEqual(expect.objectContaining({ trigger: 'auto', status: 'done' }));
    onAppClock(fresh.createdAt);
    onAppClock(fresh.finishedAt);
    await vi.waitFor(() =>
      expect(notified.filter((item) => item.kind === 'ai_review_ready')).toEqual([
        expect.objectContaining({ key: `ai:${fresh.id}` }),
      ]),
    );
  });

  it('starts the wait over when more commits arrive during it', async () => {
    const { sync, providers, runs, logFor, settled, push, later } = await reviewing();

    push(1846, 'first-push');
    await sync.sync();

    const before = logFor(1846)[0].restartAt!;

    later(2 * 60_000);

    const head = push(1846, 'second-push');

    await sync.sync();

    const [waiting] = logFor(1846);

    expect(waiting).toEqual(expect.objectContaining({ status: 'waiting', headOid: head }));
    expect(Date.parse(waiting.restartAt!)).toBeGreaterThan(Date.parse(before));

    // Quiet since the first push, but not since the second.
    later(AUTO_REVIEW_QUIET_MS - 60_000);
    await sync.sync();
    expect(runs(1846)).toHaveLength(1);

    providers.codex.delayMs = 5;
    later(60_000);
    await sync.sync();
    await settled();

    expect(runs(1846).at(-1)).toEqual(
      expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
    );
  });

  it('waits again when GitHub has newer commits than the last sync when restarting', async () => {
    const { sync, runs, logFor, push, later, first } = await reviewing();

    push(1846, 'seen-by-sync');
    await sync.sync();
    later(AUTO_REVIEW_QUIET_MS);

    const refresh = sync.refresh.bind(sync);
    let head = '';

    vi.spyOn(sync, 'refresh').mockImplementationOnce(async (id) => {
      head = push(1846, 'pushed-while-restarting');

      return refresh(id);
    });
    await sync.sync();

    expect(runs(1846)).toEqual([expect.objectContaining({ id: first.id, status: 'cancelled' })]);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
    ]);
  });

  it('waits when new commits arrive while the first review is being prepared', async () => {
    const { github, sync, enable, runs, logFor, push, restarts, idOf } = await setup();
    const refresh = sync.refresh.bind(sync);
    let calls = 0;
    let head = '';

    enable();
    github.advance();
    github.advance();
    // start() reads the PR again after building the review input; GitHub moved on in between.
    vi.spyOn(sync, 'refresh').mockImplementation(async (id) => {
      calls += 1;
      if (calls === 2) head = push(1846, 'pushed-while-preparing');

      return refresh(id);
    });
    await sync.sync();

    expect(runs(1846)).toEqual([]);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'waiting', runId: null, headOid: head }),
    ]);
    expect(restarts()).toEqual(new Map([[idOf(1846), logFor(1846)[0].restartAt]]));
  });

  it('reviews again when new commits arrived just before the review finished', async () => {
    const { github, sync, providers, enable, runs, logFor, settled, push, later, notified } =
      await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);

    // Pushed while it runs; no sync sees it before the review finishes.
    const head = push(1846, 'pushed-before-finishing');

    await settled();
    expect(runs(1846)).toEqual([expect.objectContaining({ id: first.id, status: 'done' })]);
    await vi.waitFor(() =>
      expect(logFor(1846)).toEqual([
        expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
      ]),
    );
    expect(notified.filter((item) => item.kind === 'ai_review_ready')).toEqual([]);

    providers.codex.delayMs = 5;
    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    await settled();

    expect(runs(1846).at(-1)).toEqual(
      expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
    );
  });

  it('announces a review that finished before any new commits', async () => {
    const { github, sync, enable, runs, logFor, settled, notified } = await setup();

    enable();
    github.advance();
    github.advance();
    await sync.sync();
    await settled();

    await vi.waitFor(() =>
      expect(notified.filter((item) => item.kind === 'ai_review_ready')).toHaveLength(1),
    );
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'started', runId: runs(1846)[0].id }),
    ]);
  });

  it('stops a review saved by a server restart when the PR moved on', async () => {
    const { sync, runner, runs, logFor, push, first } = await reviewing();

    runner.pause('you', first.id, 'restart');

    const head = push(1846, 'pushed-while-down');

    await sync.sync();

    expect(runs(1846)).toEqual([expect.objectContaining({ id: first.id, status: 'cancelled' })]);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
    ]);
  });

  it('leaves reviews you paused or started yourself alone', async () => {
    const { sync, runner, runs, logFor, push, idOf, first } = await reviewing();
    const manual = await runner.start('you', idOf(1839), 'full_review');

    runner.pause('you', first.id);
    push(1846, 'after-pause');
    push(1839, 'after-manual-start');
    await sync.sync();

    expect(runs(1846)).toEqual([
      expect.objectContaining({ id: first.id, status: 'paused', pauseReason: 'user' }),
    ]);
    expect(runs(1839)).toEqual([
      expect.objectContaining({ id: manual.id, status: expect.stringMatching(/queued|running/) }),
    ]);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'started', runId: first.id })]);
  });

  it('skips the restart when you start a review during the wait', async () => {
    const { sync, runner, providers, runs, logFor, settled, push, later, restarts, idOf, first } =
      await reviewing();

    push(1846, 'before-manual');
    await sync.sync();
    providers.codex.delayMs = 5_000;

    const manual = await runner.start('you', idOf(1846), 'full_review');

    expect(restarts()).toEqual(new Map());

    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();

    expect(
      runs(1846)
        .map((run) => run.id)
        .sort(),
    ).toEqual([first.id, manual.id].sort());
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'skipped', runId: manual.id }),
    ]);

    runner.cancel('you', manual.id);
    await settled();
  });

  it('restarts for a newer request that found the stopped review in progress', async () => {
    const { sync, pull, requestEvent, providers, runs, logFor, settled, push, later, first } =
      await reviewing();
    const restarted = (head: string) =>
      expect(runs(1846).at(-1)).toEqual(
        expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
      );
    const snapshot = pull(1846).snapshot;

    // Asked again while the review runs: the newer request waits on the same run.
    snapshot.requestEvents.push(requestEvent('req-1846-again', direct));
    snapshot.updatedAt = stamp();
    await sync.sync();
    expect(logFor(1846)).toContainEqual(
      expect.objectContaining({ status: 'skipped', runId: first.id }),
    );

    const head = push(1846, 'after-asking-again');

    await sync.sync();
    expect(logFor(1846).map((entry) => entry.status)).toEqual(['waiting', 'waiting']);

    providers.codex.delayMs = 5;
    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    await settled();

    restarted(head);

    // The request it replaced stops waiting, so it never holds back a later request.
    await vi.waitFor(() =>
      expect(logFor(1846).map((entry) => entry.status)).toEqual(['skipped', 'started']),
    );

    snapshot.requestEvents.push(requestEvent('req-1846-third', direct));

    const latest = push(1846, 'with-third-request');

    await sync.sync();
    await settled();

    restarted(latest);
    expect(runs(1846)).toHaveLength(3);
  });

  it('finishes the check later when GitHub cannot be asked as the review finishes', async () => {
    const { github, sync, providers, enable, runs, logFor, settled, push, later } = await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);
    const head = push(1846, 'pushed-before-an-outage');
    const refresh = vi
      .spyOn(sync, 'refresh')
      .mockRejectedValueOnce(new GitHubError('GitHub is unavailable.'));

    await settled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'checking', runId: first.id }),
    ]);

    // The next sync sees the commit, made before the review finished.
    await sync.sync();
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
    ]);

    providers.codex.delayMs = 5;
    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    await settled();

    expect(runs(1846).at(-1)).toEqual(
      expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
    );
  });

  it('leaves commits made after the review finished for you, when checked later', async () => {
    const { github, sync, enable, runs, logFor, settled, push, later } = await setup();

    enable();
    github.advance();
    github.advance();

    const refresh = sync.refresh.bind(sync);

    // GitHub is unavailable for the check as the review finishes, and for a while after.
    const outage = vi.spyOn(sync, 'refresh').mockImplementation(async (id) => {
      if (runs(1846).some((run) => run.status === 'done'))
        throw new GitHubError('GitHub is unavailable.');

      return refresh(id);
    });

    await sync.sync();
    await settled();
    await vi.waitFor(() => expect(logFor(1846)[0].status).toBe('checking'));

    later(60_000);
    push(1846, 'pushed-after-finishing');

    // The sync sees the new head, but the check waits until GitHub answers it.
    await sync.sync();
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'checking' })]);

    outage.mockRestore();
    await sync.sync();

    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'started' })]);
  });

  it('reviews again when the committer clock runs ahead of the review', async () => {
    const { github, sync, providers, enable, runs, logFor, settled, push, later, notified } =
      await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);

    // Pushed while it runs from a machine whose clock is ten minutes ahead.
    const head = push(1846, 'committed-in-the-future', stamp(10 * 60_000));

    await settled();
    await vi.waitFor(() =>
      expect(logFor(1846)).toEqual([
        expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
      ]),
    );
    expect(notified.filter((item) => item.kind === 'ai_review_ready')).toEqual([]);
  });

  it('lets a request wait for the check of the review before it', async () => {
    const { github, sync, pull, requestEvent, providers, enable, runs, logFor, settled, push } =
      await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);
    const head = push(1846, 'pushed-before-a-slow-check');
    const refresh = sync.refresh.bind(sync);
    let release = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });

    // GitHub is slow to answer the check as the review finishes.
    vi.spyOn(sync, 'refresh').mockImplementationOnce(async (id) => {
      await answered;

      return refresh(id);
    });
    await settled();

    // Asked again meanwhile: the request waits for the check instead of starting a review.
    pull(1846).snapshot.requestEvents.push(requestEvent('req-1846-during-check', direct));
    pull(1846).snapshot.updatedAt = stamp();
    await sync.sync();
    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'checking' })]);

    release();
    await vi.waitFor(() =>
      expect(logFor(1846)).toEqual([
        expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
      ]),
    );

    // The request takes over the wait, so nothing is left behind to hold back later requests.
    await sync.sync();
    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'skipped', restartAt: null }),
      expect.objectContaining({ status: 'waiting', headOid: head }),
    ]);
  });

  it('lets a request wait when the previous review ends while it is being started', async () => {
    const { github, sync, pull, requestEvent, runner, providers, enable, runs, logFor, push } =
      await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);
    let release = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plan = vi.spyOn(runner, 'codexStatus').mockImplementationOnce(async () => {
      await answered;

      return providers.codex.account;
    });

    // Asked again; while the plan is read for it, the PR moves on and the first review ends.
    pull(1846).snapshot.requestEvents.push(requestEvent('req-1846-while-ending', direct));
    pull(1846).snapshot.updatedAt = stamp();

    const syncing = sync.sync();

    await vi.waitFor(() => expect(plan).toHaveBeenCalled());

    const head = push(1846, 'pushed-while-ending');

    await vi.waitFor(() =>
      expect(logFor(1846)).toEqual([
        expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
      ]),
    );
    release();
    await syncing;

    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'waiting', headOid: head })]);

    await sync.sync();
    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'skipped', restartAt: null }),
      expect.objectContaining({ status: 'waiting', headOid: head }),
    ]);
  });

  it('writes nothing when a restart fails after it was turned off and on again', async () => {
    const { sync, runner, enable, runs, logFor, push, later } = await reviewing();

    push(1846, 'before-toggled-restart');
    await sync.sync();
    later(AUTO_REVIEW_QUIET_MS);

    let fail = () => {};
    const failed = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const start = vi.spyOn(runner, 'start').mockImplementationOnce(async () => {
      await failed;

      throw new Error('The diff could not be built.');
    });
    const syncing = sync.sync();

    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    enable(false);
    enable();
    fail();
    await syncing;

    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'primed', restartAt: null })]);

    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    expect(runs(1846)).toHaveLength(1);
  });

  it('keeps the check when the server stops before the run is announced', async () => {
    const { github, sync, runner, providers, enable, runs, logFor, settled, push } = await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);
    const head = push(1846, 'pushed-before-stopping');

    // The outcome is saved, then the server stops before anything else runs.
    runner.onFinished = undefined;
    await settled();
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'checking' })]);

    await sync.sync();

    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
    ]);
  });

  it('reviews again when new commits arrived just before the review failed', async () => {
    const { github, sync, providers, enable, runs, logFor, settled, push, notified } =
      await setup();

    enable();
    providers.codex.delayMs = 100;
    providers.codex.failNext = 'The agent crashed.';
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);
    const head = push(1846, 'pushed-before-failing');

    await settled();
    await vi.waitFor(() =>
      expect(logFor(1846)).toEqual([
        expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
      ]),
    );
    expect(notified.filter((item) => item.kind === 'ai_review_ready')).toEqual([]);
  });

  it('drops the restart when you start a review during the wait, even if you stop it', async () => {
    const { sync, runner, runs, logFor, push, later, restarts, idOf, first } = await reviewing();

    push(1846, 'before-stopped-manual');
    await sync.sync();

    const manual = await runner.start('you', idOf(1846), 'full_review');

    runner.cancel('you', manual.id);
    expect(restarts()).toEqual(new Map());

    // Another push starts the quiet period over, but not the wait.
    later(60_000);
    push(1846, 'after-stopped-manual');
    await sync.sync();
    expect(restarts()).toEqual(new Map());

    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();

    expect(
      runs(1846)
        .map((run) => run.id)
        .sort(),
    ).toEqual([first.id, manual.id].sort());
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'skipped', runId: manual.id }),
    ]);
  });

  it('reviews again when a commit made while it ran is behind a later one', async () => {
    const { github, sync, providers, enable, runs, logFor, settled, push, later } = await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);

    push(1846, 'made-while-running');

    const outage = vi
      .spyOn(sync, 'refresh')
      .mockRejectedValue(new GitHubError('GitHub is unavailable.'));

    await settled();
    await vi.waitFor(() => expect(logFor(1846)[0].status).toBe('checking'));

    // A later commit goes on top before GitHub can be asked.
    later(60_000);

    const head = push(1846, 'made-after-finishing');

    outage.mockRestore();
    await sync.sync();

    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'waiting', runId: first.id, headOid: head }),
    ]);
  });

  it('remembers a review you started when new commits interrupt the restart', async () => {
    const { sync, runner, runs, logFor, push, later, idOf, first } = await reviewing();

    push(1846, 'before-interrupted-restart');
    await sync.sync();
    later(AUTO_REVIEW_QUIET_MS);

    const refresh = sync.refresh.bind(sync);
    let calls = 0;
    let manual = '';

    // While the restart prepares, you start and stop a review, then the PR moves on.
    vi.spyOn(sync, 'refresh').mockImplementation(async (id) => {
      calls += 1;

      if (calls === 1) {
        manual = (await runner.start('you', idOf(1846), 'full_review')).id;
        runner.cancel('you', manual);
      }

      if (calls === 4) push(1846, 'interrupting-the-restart');

      return refresh(id);
    });
    await sync.sync();
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'waiting' })]);

    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();

    expect(
      runs(1846)
        .map((run) => run.id)
        .sort(),
    ).toEqual([first.id, manual].sort());
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'skipped', runId: manual })]);
  });

  it('waits again after a restart fails to start, and pushes still extend the wait', async () => {
    const { sync, runner, providers, runs, logFor, settled, push, later } = await reviewing();

    push(1846, 'before-failed-restart');
    await sync.sync();
    later(AUTO_REVIEW_QUIET_MS);
    vi.spyOn(runner, 'start').mockRejectedValueOnce(new Error('The diff could not be built.'));
    await sync.sync();

    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'waiting', attempts: 1 })]);

    later(60_000);

    const head = push(1846, 'after-failed-restart');

    await sync.sync();
    later(AUTO_REVIEW_QUIET_MS - 60_000);
    await sync.sync();
    expect(runs(1846)).toHaveLength(1);

    providers.codex.delayMs = 5;
    later(60_000);
    await sync.sync();
    await settled();

    expect(runs(1846).at(-1)).toEqual(
      expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
    );
  });

  it('drops the restart when you start and stop a review while it is starting', async () => {
    const { sync, runner, runs, logFor, push, later, idOf, first } = await reviewing();

    push(1846, 'before-restarting');
    await sync.sync();
    later(AUTO_REVIEW_QUIET_MS);

    const refresh = sync.refresh.bind(sync);
    let manual = '';

    vi.spyOn(sync, 'refresh').mockImplementationOnce(async (id) => {
      const started = await runner.start('you', idOf(1846), 'full_review');

      manual = started.id;
      runner.cancel('you', manual);

      return refresh(id);
    });
    await sync.sync();
    await sync.sync();

    expect(
      runs(1846)
        .map((run) => run.id)
        .sort(),
    ).toEqual([first.id, manual].sort());
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'skipped', runId: manual })]);
  });

  it('makes a request found with new commits wait for the PR to go quiet too', async () => {
    const { sync, pull, requestEvent, providers, runs, logFor, settled, push, later, first } =
      await reviewing();
    const snapshot = pull(1846).snapshot;

    // Asked again and pushed to before the next sync.
    snapshot.requestEvents.push(requestEvent('req-1846-with-push', direct));

    const head = push(1846, 'with-new-request');

    await sync.sync();

    expect(runs(1846)).toEqual([expect.objectContaining({ id: first.id, status: 'cancelled' })]);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'skipped', restartAt: null }),
      expect.objectContaining({ status: 'waiting', headOid: head }),
    ]);

    providers.codex.delayMs = 5;
    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    await settled();

    expect(runs(1846)).toHaveLength(2);
    expect(runs(1846).at(-1)).toEqual(
      expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
    );
  });

  it('waits again when the PR returns to a head that was already reviewed', async () => {
    const { github, sync, providers, enable, runs, logFor, settled, push, pull, later } =
      await setup();

    enable();
    providers.codex.delayMs = 100;
    github.advance();
    github.advance();
    await sync.sync();

    const [first] = runs(1846);
    const reviewed = first.headOid;

    push(1846, 'pushed-then-reverted');
    await settled();
    await vi.waitFor(() => expect(logFor(1846)[0].status).toBe('waiting'));

    // Force-pushed back to the reviewed head just before the restart.
    later(AUTO_REVIEW_QUIET_MS);

    const refresh = sync.refresh.bind(sync);

    vi.spyOn(sync, 'refresh').mockImplementationOnce(async (id) => {
      pull(1846).snapshot.headOid = reviewed;
      pull(1846).snapshot.updatedAt = stamp();

      return refresh(id);
    });
    await sync.sync();

    expect(runs(1846)).toEqual([expect.objectContaining({ id: first.id, status: 'done' })]);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'waiting', headOid: reviewed }),
    ]);

    // Quiet at the reviewed head: its review stands.
    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();

    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'started', runId: first.id })]);
  });

  it('restarts a review that kept running while it was turned off and on again', async () => {
    const { sync, providers, enable, runs, logFor, settled, push, later } = await reviewing();

    enable(false);
    enable();

    const head = push(1846, 'after-turning-on-again');

    await sync.sync();
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'waiting' })]);

    providers.codex.delayMs = 5;
    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    await settled();

    expect(runs(1846).at(-1)).toEqual(
      expect.objectContaining({ trigger: 'auto', status: 'done', headOid: head }),
    );
  });

  it('drops the wait when turned off, and does not restart it when turned on', async () => {
    const { sync, enable, runs, logFor, push, later, restarts, idOf } = await reviewing();

    push(1846, 'before-turning-off');
    await sync.sync();

    const updates: string[] = [];

    // Each names the account of its wait, a wait with no run of its own included.
    sync.events.subscribe(({ event }) => {
      if (event.type === 'ai.updated') updates.push(`${event.account}:${event.prId}`);
    });
    enable(false);
    expect(restarts()).toEqual(new Map());
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'primed', headOid: null, restartAt: null }),
    ]);
    expect(updates).toContain(`you:${idOf(1846)}`);

    later(AUTO_REVIEW_QUIET_MS);
    await sync.sync();
    expect(runs(1846)).toHaveLength(1);

    enable();
    await sync.sync();

    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([
      expect.objectContaining({ status: 'primed', headOid: null, restartAt: null }),
    ]);
  });

  it('keeps waiting while the ChatGPT plan is used up', async () => {
    const { sync, runner, providers, runs, logFor, settled, push, later } = await reviewing();

    push(1846, 'before-limit');
    await sync.sync();
    later(AUTO_REVIEW_QUIET_MS);

    const blocked: CodexAccountStatus = { ...providers.codex.account, limitReached: true };
    const status = vi.spyOn(runner, 'codexStatus').mockResolvedValue(blocked);

    await sync.sync();
    expect(runs(1846)).toHaveLength(1);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'waiting' })]);

    status.mockRestore();
    providers.codex.delayMs = 5;
    await sync.sync();
    await settled();

    expect(runs(1846)).toHaveLength(2);
    expect(logFor(1846)).toEqual([expect.objectContaining({ status: 'started' })]);
  });
});

describe('automatic review routes', () => {
  it('keeps `since` on the server and lists review status for the inbox', async () => {
    const store = new Store(':memory:');
    clock = new TestClock();

    const fixture = new FixtureGitHub(() =>
      onClock(defaultScenario(Date.parse('2026-11-05T10:00:00Z'))),
    );
    const sync = new SyncService(store, fixture, new EventBus(), null, clock);
    const root = mkdtempSync(join(tmpdir(), 'review-desk-auto-review-app-'));

    cleanups.push(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await sync.sync();

    const app = await createApp(sync, {
      sessionToken: 'test-session',
      ports: [4317],
      fixture,
      aiWorkRoot: root,
    });

    cleanups.push(() => app.close());

    const headers = {
      host: '127.0.0.1:4317',
      'content-type': 'application/json',
      'x-review-desk': '1',
      'x-review-desk-session': 'test-session',
    };
    const overview = (await app.inject({ method: 'GET', url: '/api/ai', headers })).json();
    // Saving agents and tasks never turns automatic review on, whatever the page sends.
    const agents = await app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers,
      payload: {
        account: 'you',
        settings: {
          ...overview.settings,
          autoReview: { enabled: true, since: '1999-01-01T00:00:00.000Z' },
        },
      },
    });

    expect(agents.statusCode).toBe(200);
    expect(agents.json().autoReview).toEqual({ enabled: false, since: null });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/ai/automation',
      headers,
      payload: { account: 'you', changes: { autoReview: true } },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().autoReview.enabled).toBe(true);
    expect(saved.json().autoReview.since).toEqual(expect.any(String));
    expect(saved.json().autoReview.since).not.toBe('1999-01-01T00:00:00.000Z');

    const reviews = async () =>
      (
        await app.inject({ method: 'GET', url: '/api/accounts/you/ai/reviews', headers })
      ).json() as {
        reviews: AiReviewStatus[];
      };

    expect((await reviews()).reviews).toEqual([]);

    fixture.advance();
    fixture.advance();
    await sync.sync();

    const id = fixture.scenario.world.pulls.find((pull) => pull.snapshot.number === 1846)!.snapshot
      .id;

    await expect
      .poll(async () => (await reviews()).reviews, { timeout: 5_000 })
      .toEqual([
        {
          prId: id,
          runId: expect.any(String),
          status: 'done',
          stale: false,
          trigger: 'auto',
          restartAt: null,
        },
      ]);

    // New commits stopped another PR's first review before it had a run.
    const [waiting] = autoReviewCandidates(sync.list().items).filter(
      ({ item }) => item.number === 1839,
    );
    const restartAt = stamp(60_000);
    const headOid = sync.detail(waiting.item.id)!.snapshot.headOid;

    store.db
      .insert(autoReviewLog)
      .values({
        account: 'you',
        key: waiting.key,
        prId: waiting.item.id,
        status: 'waiting',
        headOid,
        restartAt,
        updatedAt: stamp(),
      })
      .onConflictDoUpdate({
        target: [autoReviewLog.account, autoReviewLog.key],
        set: { status: 'waiting', headOid, restartAt },
      })
      .run();

    expect((await reviews()).reviews).toContainEqual({
      prId: waiting.item.id,
      runId: null,
      status: null,
      stale: false,
      trigger: 'auto',
      restartAt,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/accounts/you/pulls/${encodeURIComponent(waiting.item.id)}/ai`,
      headers,
    });

    expect(detail.json()).toEqual({ runs: [], restartAt });
  });
});
