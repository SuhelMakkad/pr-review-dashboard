import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from '@/app.js';
import { AutoReviewer } from '@/ai/auto-review.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { postedReviewMarker } from '@/ai/freshness.js';
import { FindingsPoster, postedReviewBody, postedReviewOperationId } from '@/ai/post-findings.js';
import { AiRunner } from '@/ai/runner.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { aiRuns } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { GitHubError } from '@/github/errors.js';
import { Notifier } from '@/notify/notifier.js';
import { OperationQueue } from '@/operations/queue.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';
import type { FullReviewResult } from '@review-desk/shared/ai';
import type { GitHubOperation, OperationList } from '@review-desk/shared/operations';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

async function setup() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events);
  const diffs = new DiffService(github);
  const reviews = new ReviewService(sync, github, diffs, events);
  const providers = { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') };
  const root = mkdtempSync(join(tmpdir(), 'review-desk-post-findings-'));

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
  const queue = new OperationQueue(sync, { mutationIntervalMs: 0, retryDelaysMs: [1, 2, 3] });
  queue.open();
  const poster = new FindingsPoster(sync, runner, queue);
  const autoReviewer = new AutoReviewer(sync, runner, new Notifier(store, events, vi.fn()));

  cleanups.push(() => runner.close());
  cleanups.push(() => queue.close());
  runner.onSettled = (row) => autoReviewer.settled(row);
  runner.onFinished = (row) => {
    poster.finished(row);
    autoReviewer.finished(row);
  };
  sync.afterSync = async (login) => {
    await autoReviewer.afterSync(login);
  };
  await sync.sync();

  const pull = (number: number) =>
    github.scenario.world.pulls.find((candidate) => candidate.snapshot.number === number)!;
  const idOf = (number: number) => pull(number).snapshot.id;

  const setPosting = (postFindings: boolean, autoReview?: boolean) => {
    runner.saveSettings({
      ...runner.settings(),
      postFindings,
      ...(autoReview === undefined ? {} : { autoReview: { enabled: autoReview } }),
    });
    autoReviewer.settingsSaved('you');
  };
  const runs = () => store.db.select().from(aiRuns).all();
  const settled = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!runs().some((row) => ['queued', 'running'].includes(row.status))) return;

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('runs did not settle');
  };
  const review = async (number = 1839, output?: FullReviewResult) => {
    if (output) {
      vi.spyOn(providers.codex, 'run').mockResolvedValueOnce({
        output: {
          ...output,
          comments: output.comments.map((comment) => ({ ...comment, line: comment.line ?? 1 })),
        },
        model: 'test',
        usage: null,
      });
    }

    const run = await runner.start('you', idOf(number), 'full_review');

    await settled();

    return store.db
      .select()
      .from(aiRuns)
      .all()
      .find((row) => row.id === run.id)!;
  };
  const postings = () =>
    queue.list('you').items.filter((operation) => operation.action.type === 'ai_review');
  const posted = async (runId: string, status: GitHubOperation['status'] = 'succeeded') => {
    await expect
      .poll(() => queue.find('you', postedReviewOperationId(runId))?.status, {
        timeout: 2500,
        interval: 20,
      })
      .toBe(status);

    return queue.get('you', postedReviewOperationId(runId));
  };
  const comments = () => github.writes.filter((write) => write.op === 'AddComment');

  return {
    store,
    github,
    sync,
    reviews,
    runner,
    queue,
    poster,
    providers,
    pull,
    idOf,
    setPosting,
    review,
    settled,
    postings,
    posted,
    comments,
  };
}

const result = (changes: Partial<FullReviewResult> = {}): FullReviewResult => ({
  overall: 'The retry loop never backs off.',
  assessment: 'changes_requested',
  coverage: [],
  comments: [],
  ...changes,
});

describe('posting finished reviews', () => {
  it('is off by default', async () => {
    const { runner, review, github, postings } = await setup();

    expect(runner.settings().postFindings).toBe(false);

    const run = await review();

    expect(run.status).toBe('done');
    expect(postings()).toEqual([]);
    expect(github.writes).toEqual([]);
  });

  it('approves a finished review without blockers once, with all findings in its body', async () => {
    const { runner, sync, github, idOf, setPosting, review, posted, poster } = await setup();

    setPosting(true);

    const run = await review();
    const operation = await posted(run.id);
    const [write] = github.writes;

    expect(operation.action).toEqual({
      type: 'ai_review',
      runId: run.id,
      expectedHeadOid: run.headOid,
      body: expect.any(String),
      event: 'APPROVE',
    });
    expect(operation.result?.url).toMatch(/#pullrequestreview-/);
    expect(github.writes).toHaveLength(1);
    expect(write.details.prId).toBe(idOf(1839));
    expect(String(write.details.body)).toMatch(
      new RegExp(`^${postedReviewMarker(run.id)}\\n\\*\\*AI review\\*\\* · No blocking findings`),
    );
    expect(String(write.details.body)).toContain('empty-input behavior needs a regression test');
    expect(String(write.details.body)).toContain('**Suggestion** · `');

    expect(github.writes.map((item) => item.op)).toEqual(['ApproveReview']);
    await sync.refresh(idOf(1839));
    expect(sync.detail(idOf(1839))!.item.latestReview?.state).toBe('APPROVED');
    expect(sync.detail(idOf(1839))!.item.requestedVia).toEqual([]);

    // Finishing again never posts again.
    poster.finished(run);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(github.writes).toHaveLength(1);

    // Its own approval does not make the review it came from out of date.
    await sync.refresh(idOf(1839));
    expect(runner.runs('you', idOf(1839))[0]).toMatchObject({ id: run.id, stale: false });
  });

  it('resolves all open threads before approving and preserves the local review draft', async () => {
    const { reviews, github, sync, pull, idOf, setPosting, review, posted } = await setup();
    const snapshot = pull(2041).snapshot;

    snapshot.threads[0].isOutdated = true;
    snapshot.threads.push({ ...snapshot.threads[0], id: 'already-resolved', isResolved: true });
    await sync.refresh(snapshot.id);
    await reviews.saveDraft('you', snapshot.id, {
      body: 'My independent draft.',
      event: 'COMMENT',
    });
    await reviews.addComment(snapshot.id, {
      account: 'you',
      path: snapshot.threads[0].path,
      line: null,
      body: 'My unsubmitted comment.',
    });

    const draft = reviews.draft('you', snapshot.id);

    setPosting(true);

    const run = await review(
      2041,
      result({ assessment: 'no_blocking_findings', overall: 'No changes are needed.' }),
    );

    await posted(run.id);
    await sync.refresh(idOf(2041));

    expect(github.writes.map((write) => write.op)).toEqual([
      'ResolveThread',
      'ResolveThread',
      'ApproveReview',
    ]);
    expect(pull(2041).snapshot.threads.every((thread) => thread.isResolved)).toBe(true);
    expect(reviews.draft('you', snapshot.id)).toEqual(draft);
  });

  it.each(['assessment', 'finding'] as const)(
    'posts one conversation comment and keeps threads and the review request open for a blocking %s',
    async (blocking) => {
      const { github, sync, pull, setPosting, review, posted } = await setup();

      setPosting(true);

      const run = await review(
        2041,
        result({
          assessment: blocking === 'assessment' ? 'changes_requested' : 'no_blocking_findings',
          comments:
            blocking === 'finding'
              ? [
                  {
                    path: 'src/retry.ts',
                    line: 12,
                    side: 'RIGHT',
                    severity: 'blocking',
                    body: 'Add a delay.',
                  },
                ]
              : [],
        }),
      );
      const operation = await posted(run.id);

      await sync.refresh(run.prId);

      expect(operation.action).toMatchObject({ event: 'COMMENT' });
      expect(operation.result?.url).toMatch(/#issuecomment-/);
      expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
      expect(String(github.writes[0].details.body)).toContain('Changes recommended');
      expect(pull(2041).snapshot.threads.some((thread) => !thread.isResolved)).toBe(true);
      expect(sync.detail(run.prId)!.item.requestedVia.length).toBeGreaterThan(0);
    },
  );

  it.each(['ResolveThread', 'ApproveReview'])(
    'resumes after a rejected %s without repeating completed resolutions',
    async (failure) => {
      const { github, queue, setPosting, review, posted } = await setup();
      const resolve = github.setThreadResolved.bind(github);
      let resolutions = 0;

      vi.spyOn(github, 'setThreadResolved').mockImplementation(async (...args) => {
        if (++resolutions === 2 && failure === 'ResolveThread') github.failNext = failure;

        return resolve(...args);
      });

      if (failure === 'ApproveReview') github.failNext = failure;
      setPosting(true);

      const run = await review(2041);
      const operation = await posted(run.id, 'needs_attention');

      await queue.control('you', operation.id, 'retry');
      await posted(run.id);

      expect(github.writes.map((write) => write.op)).toEqual([
        'ResolveThread',
        'ResolveThread',
        'ApproveReview',
      ]);
    },
  );

  it.each(['ResolveThread', 'ApproveReview'])(
    'confirms a lost %s response without repeating the write',
    async (mutation) => {
      const { github, setPosting, review, posted } = await setup();

      github.loseResponseNext = mutation;
      setPosting(true);

      const run = await review(2041);
      const operation = await posted(run.id);

      expect(operation.result?.url).toMatch(/#pullrequestreview-/);
      expect(github.writes.map((write) => write.op)).toEqual([
        'ResolveThread',
        'ResolveThread',
        'ApproveReview',
      ]);
    },
  );

  it('confirms an approval whose response was lost even after newer commits arrive', async () => {
    const { github, pull, setPosting, review, posted } = await setup();
    const approve = github.approveReview.bind(github);

    vi.spyOn(github, 'approveReview').mockImplementationOnce(async (...args) => {
      await approve(...args);
      pull(1839).snapshot.headOid = 'new-commits-after-approval';

      throw new GitHubError('Response lost after approving.');
    });
    setPosting(true);

    const run = await review();
    const operation = await posted(run.id);

    expect(operation.result?.url).toMatch(/#pullrequestreview-/);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('stops before further resolutions or approval if new commits arrive during posting', async () => {
    const { github, queue, pull, setPosting, review, posted } = await setup();
    const resolve = github.setThreadResolved.bind(github);

    vi.spyOn(github, 'setThreadResolved').mockImplementationOnce(async (...args) => {
      await resolve(...args);
      pull(2041).snapshot.headOid = 'new-head-during-resolution';
    });
    setPosting(true);

    const run = await review(2041);
    const operation = await posted(run.id, 'needs_attention');

    expect(operation.error?.code).toBe('HEAD_MOVED');
    expect(github.writes.map((write) => write.op)).toEqual(['ResolveThread']);
    expect(operation.controls).toContain('cancel');

    await queue.control('you', operation.id, 'cancel');

    expect(queue.get('you', operation.id).status).toBe('cancelled');
  });

  it('keeps older queued automatic posts as conversation comments', async () => {
    const { queue, review, posted, github } = await setup();
    const run = await review();

    queue.enqueue('you', run.prId, postedReviewOperationId(run.id), {
      type: 'ai_review',
      runId: run.id,
      expectedHeadOid: run.headOid,
      body: postedReviewBody(run.id, run.headOid, JSON.parse(run.result!)),
    });

    await posted(run.id);

    expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
  });

  it('still notices other people commenting, even when they copy the marker', async () => {
    const { runner, sync, pull, idOf, setPosting, review, posted } = await setup();

    setPosting(true);

    const run = await review();

    await posted(run.id);

    const now = new Date().toISOString();

    pull(1839).snapshot.conversation.push({
      id: 'copycat',
      author: { login: 'someone-else' },
      body: `${postedReviewMarker(run.id)}\nI agree.`,
      createdAt: now,
      updatedAt: now,
      url: `${pull(1839).snapshot.url}#issuecomment-copycat`,
    });
    pull(1839).snapshot.updatedAt = now;
    await sync.refresh(idOf(1839));

    expect(runner.runs('you', idOf(1839))[0]).toMatchObject({ id: run.id, stale: true });
  });

  it('does not post a review that failed', async () => {
    const { providers, setPosting, review, postings, github } = await setup();

    setPosting(true);
    providers.codex.failNext = 'The agent crashed.';

    expect((await review()).status).toBe('failed');
    expect(postings()).toEqual([]);
    expect(github.writes).toEqual([]);
  });

  it('skips a review once new commits arrive, without holding back your own actions', async () => {
    const { queue, pull, idOf, setPosting, review, posted, comments } = await setup();

    setPosting(true);
    await queue.pause();

    const run = await review();

    pull(1839).snapshot.headOid = 'pushed-after-the-review';
    pull(1839).snapshot.updatedAt = new Date().toISOString();
    queue.resume();

    const operation = await posted(run.id, 'cancelled');

    expect(operation.progress).toBe(
      'Not posted: new commits arrived after this review. Run it again to review them.',
    );
    expect(comments()).toEqual([]);

    // An unmark holds for every diff, so it goes out even though the PR changed.
    const { operation: viewed } = queue.enqueue('you', idOf(1839), 'viewed-after-skip', {
      type: 'viewed',
      path: 'src/reminders.ts',
      viewed: false,
    });

    await expect
      .poll(() => queue.get('you', viewed.id).status, { timeout: 2500, interval: 20 })
      .toBe('succeeded');
  });

  it.each([
    ['a comment', () => result()],
    ['an approval', undefined],
  ] as const)(
    'skips %s when new commits land after the check before sending',
    async (_kind, output) => {
      const { sync, queue, pull, setPosting, review, posted, github } = await setup();
      const refresh = sync.refresh.bind(sync);
      let calls = 0;

      setPosting(true);
      await queue.pause();

      const run = await review(1839, output?.());

      // The first refresh is the check before sending; GitHub moves on right after it.
      vi.spyOn(sync, 'refresh').mockImplementation(async (id) => {
        calls += 1;

        if (calls === 2) {
          pull(1839).snapshot.headOid = 'pushed-while-posting';
          pull(1839).snapshot.updatedAt = new Date().toISOString();
        }

        return refresh(id);
      });
      queue.resume();

      const operation = await posted(run.id, 'cancelled');

      expect(operation.progress).toBe(
        'Not posted: new commits arrived after this review. Run it again to review them.',
      );
      expect(github.writes).toEqual([]);
    },
  );

  it('confirms a posted review whose response was lost, without posting it twice', async () => {
    const { github, setPosting, review, posted, comments } = await setup();

    setPosting(true);
    github.loseResponseNext = 'AddComment';

    const run = await review(1839, result());
    const operation = await posted(run.id);

    expect(comments()).toHaveLength(1);
    expect(operation.result?.url).toMatch(/#issuecomment-/);
  });

  it('can be left unposted when GitHub refuses it', async () => {
    const { github, queue, setPosting, review, posted, comments } = await setup();

    setPosting(true);
    github.failNext = 'AddComment';

    const run = await review(1839, result());
    const failed = await posted(run.id, 'needs_attention');

    expect(failed.controls).toEqual(['retry', 'cancel', 'dismiss']);

    const { operation } = await queue.control('you', failed.id, 'cancel');

    expect(operation).toMatchObject({
      status: 'cancelled',
      progress: 'Cancelled. Nothing was posted.',
    });
    expect(comments()).toEqual([]);
  });

  it('posts automatic reviews too', async () => {
    const { github, sync, runner, setPosting, settled, posted } = await setup();

    setPosting(true, true);
    await sync.sync();

    // The second scripted step is a new direct request on #1846.
    github.advance();
    github.advance();
    await sync.sync();
    await settled();

    const automatic = runner.reviewStatuses('you').find((status) => status.trigger === 'auto');

    expect(automatic).toMatchObject({ status: 'done' });
    await posted(automatic!.runId);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('keeps the setting when a save leaves it out, and loads older settings as off', async () => {
    const { store, runner } = await setup();

    runner.saveSettings({ ...runner.settings(), postFindings: true });

    const { postFindings: _left, ...older } = runner.settings();

    runner.saveSettings(older);
    expect(runner.settings().postFindings).toBe(true);

    store.setSetting('ai-settings', older);
    expect(runner.settings().postFindings).toBe(false);
  });
});

describe('the posted comment', () => {
  it('names the verdict and the reviewed commit, and lists findings tied to code', () => {
    const body = postedReviewBody(
      'run-1',
      'abcdef1234567890',
      result({
        comments: [
          {
            path: 'src/retry.ts',
            line: 12,
            side: 'RIGHT',
            severity: 'blocking',
            body: 'Add a delay.',
          },
          { path: 'src/retry.ts', line: null, side: 'RIGHT', severity: 'nit', body: 'Rename.' },
        ],
      }),
    );

    expect(body).toBe(
      [
        '<!-- review-desk:ai-review run=run-1 -->',
        '**AI review** · Changes recommended',
        '',
        'The retry loop never backs off.',
        '',
        '**Blocking** · `src/retry.ts:12`',
        '',
        'Add a delay.',
        '',
        '**Nit** · `src/retry.ts`',
        '',
        'Rename.',
        '',
        '<sub>Posted automatically by Review Desk when an AI review of abcdef1 finished.</sub>',
      ].join('\n'),
    );
  });

  it('fits within GitHub’s comment limit', () => {
    const body = postedReviewBody('run-2', 'abcdef1', result({ overall: 'x'.repeat(100_000) }));

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain('It is complete in Review Desk.');
    expect(body.endsWith('finished.</sub>')).toBe(true);
  });
});

describe('posting through the app', () => {
  it('saves the setting and posts a review started from the API', async () => {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const sync = new SyncService(store, fixture, new EventBus());
    const root = mkdtempSync(join(tmpdir(), 'review-desk-post-findings-app-'));

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
      operationQueue: { mutationIntervalMs: 0 },
    });

    cleanups.push(() => app.close());

    const headers = {
      host: '127.0.0.1:4317',
      'content-type': 'application/json',
      'x-review-desk': '1',
      'x-review-desk-session': 'test-session',
    };
    const overview = (await app.inject({ method: 'GET', url: '/api/ai', headers })).json();

    expect(overview.settings.postFindings).toBe(false);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers,
      payload: { account: 'you', settings: { ...overview.settings, postFindings: true } },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().postFindings).toBe(true);

    // A window opened before the setting existed does not turn it off.
    const { postFindings: _left, ...older } = overview.settings;
    const resaved = await app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers,
      payload: { account: 'you', settings: older },
    });

    expect(resaved.json().postFindings).toBe(true);

    const id = sync.list().items.find((item) => item.number === 1839)!.id;
    const started = await app.inject({
      method: 'POST',
      url: `/api/pulls/${id}/ai`,
      headers,
      payload: { account: 'you', task: 'full_review' },
    });

    expect(started.statusCode).toBe(200);

    const operations = async () =>
      (
        await app.inject({ method: 'GET', url: '/api/operations?account=you', headers })
      ).json() as OperationList;

    await expect
      .poll(
        async () =>
          (await operations()).items.find((item) => item.action.type === 'ai_review')?.status,
        { timeout: 5_000, interval: 50 },
      )
      .toBe('succeeded');
    expect(fixture.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });
});
