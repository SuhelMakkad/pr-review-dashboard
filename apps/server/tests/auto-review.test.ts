import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createApp } from '@/app.js';
import { AutoReviewer } from '@/ai/auto-review.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { AiRunner } from '@/ai/runner.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { aiRuns, autoReviewLog } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario, type ScenarioPull } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { Notifier } from '@/notify/notifier.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';
import type { AiReviewStatus, CodexAccountStatus } from '@review-desk/shared/ai';
import { defaultNotificationSettings, type ReviewNotification } from '@review-desk/shared/notify';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

const direct = { kind: 'user' as const, login: 'you', name: 'you' };
const platformTeam = { kind: 'team' as const, login: 'acme/platform', name: 'Platform' };

async function setup() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events);
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
    const now = new Date().toISOString();
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
    createdAt: new Date().toISOString(),
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
    rerequested.updatedAt = new Date().toISOString();

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
    pull(9003).snapshot.updatedAt = new Date().toISOString();
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
    pull(877).snapshot.updatedAt = new Date().toISOString();
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
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

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
    pull(1846).snapshot.updatedAt = new Date().toISOString();
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

describe('automatic review routes', () => {
  it('keeps `since` on the server and lists review status for the inbox', async () => {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const sync = new SyncService(store, fixture, new EventBus());
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
    const saved = await app.inject({
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

    expect(saved.statusCode).toBe(200);
    expect(saved.json().autoReview.enabled).toBe(true);
    expect(saved.json().autoReview.since).not.toBe('1999-01-01T00:00:00.000Z');

    const reviews = async () =>
      (await app.inject({ method: 'GET', url: '/api/ai/reviews?account=you', headers })).json() as {
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
        { prId: id, runId: expect.any(String), status: 'done', stale: false, trigger: 'auto' },
      ]);
  });
});
