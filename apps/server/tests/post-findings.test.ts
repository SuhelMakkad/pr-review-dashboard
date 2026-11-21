import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createApp } from '@/app.js';
import { AutoReviewer } from '@/ai/auto-review.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { postedReviewMarker, publicationFingerprint } from '@/ai/freshness.js';
import { evidence, unverified } from '@/ai/inputs.js';
import {
  FindingsPublisher,
  postedReviewBody,
  postedReviewOperationId,
} from '@/ai/post-findings.js';
import { AiRunner } from '@/ai/runner.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { aiRuns, githubOperations } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { GitHubError } from '@/github/errors.js';
import { Notifier } from '@/notify/notifier.js';
import { OperationQueue } from '@/operations/queue.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';
import type { FullReviewResult, ReviewInputs } from '@review-desk/shared/ai';
import type { DiffFile } from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { GitHubOperation, OperationList } from '@review-desk/shared/operations';
import { storeRaw } from './raw-settings.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

async function setup() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events, github);
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

  // Paths left out of every snapshot, as an archive leaves out symlinks or oversized files.
  const omit = new Set<string>();
  const exportRepository: RepositoryExporter = async (repository, oid, directory, signal) => {
    for (const [path, content] of Object.entries(
      github.scenario.world.repos.files(repository, oid),
    )) {
      signal.throwIfAborted();

      if (omit.has(path)) continue;

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
  const publisher = new FindingsPublisher(sync, runner, queue);
  const autoReviewer = new AutoReviewer(sync, runner, new Notifier(store, events, vi.fn()));

  cleanups.push(() => runner.close());
  cleanups.push(() => queue.close());
  // Before the store closes: a switch starts a sync that must not outlive the test.
  cleanups.push(() => sync.stop());
  runner.onSettled = (row) => autoReviewer.settled(row);
  runner.onPublish = (row, reviewed) => publisher.publish(row, reviewed);
  runner.onFinished = (row) => autoReviewer.finished(row);
  queue.posting = () => runner.settings();
  sync.afterSync = async (login) => {
    await autoReviewer.afterSync(login);
  };
  await sync.sync();

  const pull = (number: number) =>
    github.scenario.world.pulls.find((candidate) => candidate.snapshot.number === number)!;
  const idOf = (number: number) => pull(number).snapshot.id;

  // Posting as it was documented before approval and resolution had their own switches.
  const setPosting = (
    postFindings: boolean,
    autoReview?: boolean,
    grants = { approveFindings: postFindings, resolveThreads: postFindings },
  ) => {
    runner.saveSettings({
      ...runner.settings(),
      postFindings,
      ...grants,
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
    omit,
    publisher,
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

type Setup = Awaited<ReturnType<typeof setup>>;

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
    const { runner, sync, github, idOf, setPosting, review, posted, queue } = await setup();

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
      basis: {
        baseRefName: 'main',
        mergeBaseOid: run.inputs!.mergeBaseOid,
        fingerprint: expect.any(String),
        summaryFingerprint: expect.any(String),
        threadIds: [],
        grants: { approve: true, resolve: false },
      },
    });
    expect(run.inputs).toMatchObject({ inventory: 'verified', complete: true });
    expect(run.publication).toEqual({ operationId: operation.id, event: 'APPROVE' });
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

    // Queuing it again never posts again.
    queue.enqueueAutomatic('you', run.prId, operation.id, operation.action as never);
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

  it('confirms a lost approval response without repeating the write', async () => {
    const { github, setPosting, review, posted } = await setup();

    github.loseResponseNext = 'ApproveReview';
    setPosting(true);

    const run = await review(2041);
    const operation = await posted(run.id);

    expect(operation.result?.url).toMatch(/#pullrequestreview-/);
    expect(github.writes.map((write) => write.op)).toEqual([
      'ResolveThread',
      'ResolveThread',
      'ApproveReview',
    ]);
  });

  it('waits for you after a lost resolution response, since a resolved thread names no resolver', async () => {
    const { github, queue, setPosting, review, posted } = await setup();

    github.loseResponseNext = 'ResolveThread';
    setPosting(true);

    const run = await review(2041);
    const operation = await posted(run.id, 'needs_attention');

    expect(operation.error?.code).toBe('UNCONFIRMED');
    expect(github.writes.map((write) => write.op)).toEqual(['ResolveThread']);

    // Checking cannot settle it; you can stop the rest once you have looked.
    expect(operation.controls).toEqual(['cancel', 'dismiss']);

    await queue.control('you', operation.id, 'cancel', true);
    expect(queue.get('you', operation.id).status).toBe('cancelled');
    expect(github.writes.map((write) => write.op)).toEqual(['ResolveThread']);
  });

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

  it.each([true, false])(
    'posts older queued automatic posts as comments only while posting is on (%s)',
    async (posting) => {
      const { queue, review, posted, github, setPosting } = await setup();
      const run = await review();

      // Turned on after the review finished: that review itself is not posted.
      setPosting(posting);
      queue.enqueue('you', run.prId, postedReviewOperationId(run.id), {
        type: 'ai_review',
        runId: run.id,
        expectedHeadOid: run.headOid,
        body: postedReviewBody(run.id, run.headOid, JSON.parse(run.result!)),
      });

      if (posting) {
        await posted(run.id);
        expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
      } else {
        expect((await posted(run.id, 'cancelled')).progress).toBe(
          'Not posted: posting findings was turned off in Settings.',
        );
        expect(github.writes).toEqual([]);
      }
    },
  );

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

    storeRaw(store, 'ai-settings', older);
    expect(runner.settings().postFindings).toBe(false);
  });
});

/** Someone else comments on the PR in the conversation, as GitHub would list it. */
function commentOn(
  snapshot: Pick<PullRequestSnapshot, 'conversation' | 'url' | 'updatedAt'>,
  body: string,
  author = 'someone-else',
) {
  const now = new Date().toISOString();

  snapshot.conversation.push({
    id: `comment-${snapshot.conversation.length + 1}`,
    author: { login: author },
    body,
    createdAt: now,
    updatedAt: now,
    url: `${snapshot.url}#issuecomment-${snapshot.conversation.length + 1}`,
  });
  snapshot.updatedAt = now;
}

describe('what an automatic post rests on', () => {
  it('saves the decision with the run: a failed save leaves it unposted and resumable', async () => {
    const { runner, store, sync, setPosting, review, settled, postings, posted, github } =
      await setup();
    const announced: string[] = [];

    sync.events.subscribe(({ event }) => {
      if (event.type === 'operation.updated') announced.push(event.type);
    });
    setPosting(true);
    // After the outbox row is written, before the decision is: both go, or neither.
    vi.spyOn(runner, 'recordPublication').mockImplementationOnce(() => {
      throw new Error('The disk is full.');
    });

    const failed = await review();

    expect(failed).toMatchObject({ status: 'failed', publication: null });
    expect(failed.request).not.toBeNull();
    expect(store.db.select().from(githubOperations).all()).toEqual([]);
    expect(announced).toEqual([]);
    expect(postings()).toEqual([]);

    await runner.resume('you', failed.id);
    await settled();

    expect(store.db.select().from(aiRuns).get()).toMatchObject({ status: 'done' });
    await posted(failed.id);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('does not post a review that finished after you switched accounts', async () => {
    const { sync, providers, setPosting, review, postings } = await setup();
    const run = providers.codex.run.bind(providers.codex);

    setPosting(true);
    vi.spyOn(providers.codex, 'run').mockImplementationOnce(async (...args) => {
      await sync.switchAccount('you', DEMO_SECOND_ACCOUNT);

      return run(...args);
    });

    const done = await review();

    expect(done).toMatchObject({
      status: 'done',
      publication: { skipped: 'Finished after you switched accounts.' },
    });

    // Nor once you switch back.
    await sync.switchAccount(DEMO_SECOND_ACCOUNT, 'you');
    expect(postings()).toEqual([]);
  });

  it('comments instead of approving when the review could not read every changed file', async () => {
    const { github, pull, omit, setPosting, review, posted } = await setup();
    const { repository, number } = pull(1839).snapshot;
    const [{ path }] = await github.pullFiles(repository, number);

    omit.add(path);
    setPosting(true);

    const run = await review();
    const operation = await posted(run.id);

    expect(run.inputs).toMatchObject({ inventory: 'verified', complete: false });
    expect(run.publication).toEqual({
      operationId: operation.id,
      event: 'COMMENT',
      reason: 'The review could not read every changed file.',
    });
    expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
    expect(String(github.writes[0].details.body)).toMatch(
      new RegExp(
        `^${postedReviewMarker(run.id)}\\n_Not approved automatically: 1 of 3 changed files could not be read: \`${path}\`._\\n\\n\\*\\*AI review\\*\\* · No blocking findings`,
      ),
    );
  });

  it('comments, and gives the agent no patches, when the changed files cannot be verified', async () => {
    const { github, providers, setPosting, review, posted } = await setup();
    const compare = github.compare.bind(github);
    const run = providers.codex.run.bind(providers.codex);
    let given: DiffFile[] = [];

    vi.spyOn(github, 'compare').mockImplementation(async (...args) => {
      const result = await compare(...args);

      return result && { ...result, filesComplete: undefined };
    });
    vi.spyOn(providers.codex, 'run').mockImplementationOnce(async (request, ...rest) => {
      given = JSON.parse(readFileSync(join(request.workDir, 'review.json'), 'utf8')).files;

      return run(request, ...rest);
    });
    setPosting(true);

    const done = await review();

    await posted(done.id);

    expect(done.inputs).toMatchObject({ inventory: 'unverified', complete: false });
    expect(given.length).toBeGreaterThan(0);
    expect(given.every((file) => file.patch === undefined)).toBe(true);
    expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
    expect(String(github.writes[0].details.body)).toContain(
      '_Not approved automatically: Review Desk could not verify which files this review read._',
    );
  });

  it('skips a review whose PR discussion changed while it ran', async () => {
    const { providers, pull, sync, idOf, setPosting, review, postings } = await setup();
    const run = providers.codex.run.bind(providers.codex);

    setPosting(true);
    vi.spyOn(providers.codex, 'run').mockImplementationOnce(async (...args) => {
      commentOn(pull(1839).snapshot, 'Please wait for the security review.');
      await sync.refresh(idOf(1839));

      return run(...args);
    });

    expect((await review()).publication).toEqual({
      skipped: 'The PR or its discussion changed while this review ran.',
    });
    expect(postings()).toEqual([]);
  });

  it.each([
    [
      'someone comments',
      'the PR or its discussion changed after this review. Run it again to review it.',
      ({ pull }: Setup) => commentOn(pull(1839).snapshot, 'I found a problem.'),
    ],
    [
      'another run posts a review',
      'the PR or its discussion changed after this review. Run it again to review it.',
      ({ pull }: Setup) =>
        commentOn(
          pull(1839).snapshot,
          `${postedReviewMarker('another-run')}\nChanges recommended.`,
        ),
    ],
    [
      'another reviewer requests changes',
      'the PR or its discussion changed after this review. Run it again to review it.',
      ({ pull }: Setup) => {
        const snapshot = pull(1839).snapshot;

        snapshot.verdicts = [
          ...(snapshot.verdicts ?? []),
          {
            login: 'someone-else',
            state: 'CHANGES_REQUESTED',
            submittedAt: new Date().toISOString(),
            commitOid: snapshot.headOid,
          },
        ];
        snapshot.updatedAt = new Date().toISOString();
      },
    ],
    [
      'posting is turned off',
      'posting findings was turned off in Settings.',
      ({ setPosting }: Setup) => setPosting(false),
    ],
    [
      'approving is turned off',
      'automatic approval was turned off in Settings.',
      ({ setPosting }: Setup) =>
        setPosting(true, undefined, { approveFindings: false, resolveThreads: true }),
    ],
    [
      'the PR is retargeted',
      'the PR now targets another branch.',
      ({ pull }: Setup) => {
        pull(1839).snapshot.baseRefName = 'release';
        pull(1839).snapshot.updatedAt = new Date().toISOString();
      },
    ],
    [
      'the PR becomes a draft',
      'the PR was turned into a draft.',
      ({ pull }: Setup) => {
        pull(1839).snapshot.isDraft = true;
        pull(1839).snapshot.updatedAt = new Date().toISOString();
      },
    ],
  ])('skips an approval when %s after the review finished', async (_change, reason, change) => {
    const context = await setup();
    const { queue, setPosting, review, posted, github } = context;

    setPosting(true);
    await queue.pause();

    const run = await review();

    await change(context);
    queue.resume();

    expect((await posted(run.id, 'cancelled')).progress).toBe(`Not posted: ${reason}`);
    expect(github.writes).toEqual([]);
  });

  it.each([
    [
      'approving is turned off',
      'Not posted: automatic approval was turned off in Settings.',
      ({ setPosting }: Setup) =>
        setPosting(true, undefined, { approveFindings: false, resolveThreads: true }),
    ],
    [
      'a newer snapshot shows new discussion',
      'Not posted: the PR or its discussion changed after this review. Run it again to review it.',
      async ({ pull, sync, idOf }: Setup) => {
        commentOn(pull(1839).snapshot, 'Wait, there is a problem.');
        await sync.refresh(idOf(1839));
      },
    ],
  ])(
    'checks again after the merge base is looked up: %s meanwhile stops the approval',
    async (_change, progress, change) => {
      const context = await setup();
      const { github, queue, setPosting, review, posted } = context;
      const compare = github.compare.bind(github);

      setPosting(true);
      await queue.pause();

      const run = await review();

      vi.spyOn(github, 'compare').mockImplementationOnce(async (...args) => {
        await change(context);

        return compare(...args);
      });
      queue.resume();

      expect((await posted(run.id, 'cancelled')).progress).toBe(progress);
      expect(github.writes).toEqual([]);
    },
  );

  it.each([
    [
      'someone comments',
      'Not posted: the PR or its discussion changed after this review. Run it again to review it.',
      ({ pull }: Setup) => commentOn(pull(1839).snapshot, 'Hold on.'),
    ],
    [
      'new commits arrive',
      'Not posted: new commits arrived after this review. Run it again to review them.',
      ({ pull }: Setup) => {
        pull(1839).snapshot.headOid = 'pushed-during-the-lookup';
        pull(1839).snapshot.updatedAt = new Date().toISOString();
      },
    ],
  ])(
    'reads the PR again after the merge base is looked up: %s on the forge meanwhile',
    async (_change, progress, change) => {
      const context = await setup();
      const { github, queue, setPosting, review, posted } = context;
      const compare = github.compare.bind(github);

      setPosting(true);
      await queue.pause();

      const run = await review();

      // Only the forge changes; nothing here saves a newer snapshot.
      vi.spyOn(github, 'compare').mockImplementationOnce(async (...args) => {
        change(context);

        return compare(...args);
      });
      queue.resume();

      expect((await posted(run.id, 'cancelled')).progress).toBe(progress);
      expect(github.writes).toEqual([]);
    },
  );

  it('stops when the target branch moves before the last read, though the diff looks the same', async () => {
    const { github, sync, pull, queue, setPosting, review, posted } = await setup();
    const refresh = sync.refresh.bind(sync);
    const { repository, baseRefName } = pull(1839).snapshot;
    let reads = 0;

    setPosting(true);
    await queue.pause();

    const run = await review();

    // The target moves after the merge base was looked up: the last read of the PR sees the new
    // commit on the branch, while the PR's diff stays as it was.
    vi.spyOn(sync, 'refresh').mockImplementation(async (...args) => {
      if (++reads === 2)
        github.scenario.world.repos.ref(repository, baseRefName, 'target-moved-on');

      return refresh(...args);
    });
    queue.resume();

    expect((await posted(run.id, 'cancelled')).progress).toBe(
      'Not posted: the PR shows another diff than the one reviewed.',
    );
    expect(github.writes).toEqual([]);
  });

  it('tries again, rather than skipping, when the last read cannot say where the target is', async () => {
    const { github, queue, setPosting, review, posted } = await setup();
    const snapshot = github.snapshot.bind(github);
    let reads = 0;

    setPosting(true);
    await queue.pause();

    const run = await review();

    // The last read before the send could not read the branch.
    vi.spyOn(github, 'snapshot').mockImplementation(async (...args) => {
      const read = await snapshot(...args);

      if (++reads === 2) delete read.baseTipOid;

      return read;
    });
    queue.resume();

    await posted(run.id);
    expect(reads).toBeGreaterThan(2);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('waits for the forge’s own retry time when the last read is rate limited', async () => {
    const { sync, queue, setPosting, review, posted, github } = await setup();
    const refresh = sync.refresh.bind(sync);
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    let reads = 0;

    setPosting(true);
    await queue.pause();

    const run = await review();

    vi.spyOn(sync, 'refresh').mockImplementation(async (...args) => {
      if (++reads === 2)
        throw new GitHubError('GitLab rate limit reached.', retryAt, 429, 'rate_limit');

      return refresh(...args);
    });
    queue.resume();

    const waiting = await posted(run.id, 'waiting');

    expect(Date.parse(waiting.retryAt!)).toBeGreaterThanOrEqual(Date.parse(retryAt));
    expect(github.writes).toEqual([]);
  });

  it('keeps the forge’s rate limit even when posting is turned off during the limited read', async () => {
    const { sync, queue, setPosting, review, posted, github } = await setup();
    const refresh = sync.refresh.bind(sync);
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    let reads = 0;

    setPosting(true);
    await queue.pause();

    const run = await review();

    vi.spyOn(sync, 'refresh').mockImplementation(async (...args) => {
      if (++reads === 2) {
        setPosting(false);
        throw new GitHubError('GitLab rate limit reached.', retryAt, 429, 'rate_limit');
      }

      return refresh(...args);
    });
    queue.resume();

    expect((await posted(run.id, 'cancelled')).progress).toBe(
      'Not posted: posting findings was turned off in Settings.',
    );
    expect(Date.parse(sync.status.retryAt!)).toBeGreaterThanOrEqual(Date.parse(retryAt));
    expect(github.writes).toEqual([]);
  });

  it.each([
    ['already off', false],
    ['turned off while reading the PR fails', true],
  ])(
    'stops a post when posting is %s before sending, rather than retrying',
    async (_when, during) => {
      const { sync, queue, setPosting, review, posted, github } = await setup();

      setPosting(true);
      await queue.pause();

      const run = await review();

      vi.spyOn(sync, 'refresh').mockImplementationOnce(async () => {
        if (during) setPosting(false);

        throw new GitHubError('GitHub is unavailable.', null, 503, 'unavailable');
      });
      if (!during) setPosting(false);
      queue.resume();

      expect((await posted(run.id, 'cancelled')).progress).toBe(
        'Not posted: posting findings was turned off in Settings.',
      );
      expect(github.writes).toEqual([]);
    },
  );

  it.each([
    ['already off', false],
    ['turned off while the lookup fails', true],
  ])(
    'stops a post when posting is %s, without waiting to retry a failed lookup',
    async (_when, duringLookup) => {
      const { github, queue, setPosting, review, posted } = await setup();

      setPosting(true);
      await queue.pause();

      const run = await review();

      vi.spyOn(github, 'compare').mockImplementationOnce(async () => {
        if (duringLookup) setPosting(false);

        throw new GitHubError('GitHub is unavailable.', null, 503, 'unavailable');
      });
      if (!duringLookup) setPosting(false);
      queue.resume();

      expect((await posted(run.id, 'cancelled')).progress).toBe(
        'Not posted: posting findings was turned off in Settings.',
      );
      expect(github.writes).toEqual([]);
    },
  );

  it('approves after resolving threads on a forge that renews its notes’ times when resolving', async () => {
    const { github, pull, sync, idOf, setPosting, review, posted } = await setup();
    const snapshot = pull(2041).snapshot;
    const resolve = github.setThreadResolved.bind(github);
    const earlier = '2026-11-01T10:00:00Z';

    // A review of yours read from notes, as GitLab's are: its time follows theirs.
    snapshot.reviews.push({
      id: 'yours-from-notes',
      state: 'COMMENTED',
      submittedAt: earlier,
      updatedAt: earlier,
      commitOid: snapshot.headOid,
      body: 'Looked at the retry loop.',
      url: `${snapshot.url}#note-1`,
    });
    snapshot.updatedAt = new Date().toISOString();
    await sync.refresh(idOf(2041));

    vi.spyOn(github, 'setThreadResolved').mockImplementation(async (...args) => {
      const result = await resolve(...args);
      const now = new Date().toISOString();

      for (const thread of snapshot.threads)
        if (thread.id === args[0]) for (const comment of thread.comments) comment.updatedAt = now;
      for (const own of snapshot.reviews) own.updatedAt = now;

      return result;
    });
    setPosting(true);

    const run = await review(2041);

    await posted(run.id);
    expect(github.writes.map((write) => write.op)).toEqual([
      'ResolveThread',
      'ResolveThread',
      'ApproveReview',
    ]);
  });

  it('comments instead of approving when a resumed workspace lost part of its file list', async () => {
    const { providers, runner, github, omit, pull, setPosting, review, settled, posted } =
      await setup();
    const { repository, number } = pull(1839).snapshot;
    const [{ path }] = await github.pullFiles(repository, number);
    const run = providers.codex.run.bind(providers.codex);

    setPosting(true);
    vi.spyOn(providers.codex, 'run').mockImplementationOnce(async (request, ...rest) => {
      // While the run is stopped, the workspace loses a file and its entry in the file list.
      const file = join(request.workDir, 'review.json');
      const context = JSON.parse(readFileSync(file, 'utf8'));

      writeFileSync(
        file,
        JSON.stringify({
          ...context,
          files: context.files.filter((entry: DiffFile) => entry.path !== path),
        }),
      );
      omit.add(path);
      rmSync(join(request.workDir, 'after', path), { force: true });
      rmSync(join(request.workDir, 'before', path), { force: true });
      await run(request, ...rest);

      throw new Error('The agent was stopped.');
    });

    const failed = await review();

    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.inputs).toMatchObject({ complete: true });

    await runner.resume('you', failed.id);
    await settled();
    await posted(failed.id);

    expect(runner.runs('you', failed.prId)[0].inputs).toMatchObject({
      inventory: 'unverified',
      complete: false,
    });
    expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
  });

  it('leaves threads opened after the review alone, and does not approve over them', async () => {
    const { queue, pull, setPosting, review, posted, github } = await setup();
    const snapshot = pull(2041).snapshot;

    setPosting(true);
    await queue.pause();

    const run = await review(2041);

    snapshot.threads.push({ ...snapshot.threads[0], id: 'opened-after-review', isResolved: false });
    snapshot.updatedAt = new Date().toISOString();
    queue.resume();

    expect((await posted(run.id, 'cancelled')).progress).toBe(
      'Not posted: the PR or its discussion changed after this review. Run it again to review it.',
    );
    expect(github.writes).toEqual([]);
    expect(snapshot.threads.find((thread) => thread.id === 'opened-after-review')!.isResolved).toBe(
      false,
    );
  });

  it('stops when a thread it resolved is reopened', async () => {
    const { github, pull, setPosting, review, posted } = await setup();
    const resolve = github.setThreadResolved.bind(github);

    vi.spyOn(github, 'setThreadResolved').mockImplementationOnce(async (...args) => {
      const result = await resolve(...args);
      const snapshot = pull(2041).snapshot;

      snapshot.threads.find((thread) => thread.id === args[0])!.isResolved = false;
      snapshot.updatedAt = new Date().toISOString();

      return result;
    });
    setPosting(true);

    const run = await review(2041);
    const operation = await posted(run.id, 'needs_attention');

    expect(operation.error?.code).toBe('DISCUSSION_CHANGED');
    expect(github.writes.map((write) => write.op)).toEqual(['ResolveThread']);
  });

  it('stops before the next resolution once resolving is turned off', async () => {
    const { github, setPosting, review, posted } = await setup();
    const resolve = github.setThreadResolved.bind(github);

    vi.spyOn(github, 'setThreadResolved').mockImplementationOnce(async (...args) => {
      const result = await resolve(...args);

      setPosting(true, undefined, { approveFindings: true, resolveThreads: false });

      return result;
    });
    setPosting(true);

    const run = await review(2041);
    const operation = await posted(run.id, 'needs_attention');

    expect(operation.error?.message).toContain('Resolving threads was turned off in Settings.');
    expect(github.writes.map((write) => write.op)).toEqual(['ResolveThread']);
  });

  it('approves without resolving threads where only approving is allowed', async () => {
    const { github, setPosting, review, posted } = await setup();

    setPosting(true, undefined, { approveFindings: true, resolveThreads: false });

    const run = await review(2041);

    await posted(run.id);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('skips an outdated approval queued before inputs were checked, and sends your own action', async () => {
    const { queue, pull, idOf, review, posted, github, setPosting } = await setup();
    const run = await review();

    setPosting(true);
    await queue.pause();
    queue.enqueue('you', run.prId, postedReviewOperationId(run.id), {
      type: 'ai_review',
      runId: run.id,
      expectedHeadOid: run.headOid,
      event: 'APPROVE',
      body: postedReviewBody(run.id, run.headOid, JSON.parse(run.result!)),
    });
    pull(1839).snapshot.headOid = 'pushed-after-the-review';
    pull(1839).snapshot.updatedAt = new Date().toISOString();

    const { operation: viewed } = queue.enqueue('you', idOf(1839), 'viewed-behind-it', {
      type: 'viewed',
      path: 'src/reminders.ts',
      viewed: false,
    });

    queue.resume();

    expect((await posted(run.id, 'cancelled')).progress).toBe(
      'Not posted: new commits arrived after this review. Run it again to review them.',
    );
    await expect
      .poll(() => queue.get('you', viewed.id).status, { timeout: 2500, interval: 20 })
      .toBe('succeeded');
    expect(github.writes.map((write) => write.op)).not.toContain('ApproveReview');
  });

  it('waits for you before an approval queued before inputs were checked', async () => {
    const { queue, review, posted, github, setPosting } = await setup();
    const run = await review();

    setPosting(true);
    queue.enqueue('you', run.prId, postedReviewOperationId(run.id), {
      type: 'ai_review',
      runId: run.id,
      expectedHeadOid: run.headOid,
      event: 'APPROVE',
      body: postedReviewBody(run.id, run.headOid, JSON.parse(run.result!)),
    });

    const operation = await posted(run.id, 'needs_attention');

    expect(operation.error?.code).toBe('LEGACY_APPROVAL');
    expect(operation.controls).toEqual(['cancel', 'dismiss']);
    expect(github.writes).toEqual([]);
  });

  it('retries until the merge base can be confirmed, rather than posting unchecked', async () => {
    const { github, queue, setPosting, review, posted } = await setup();
    const compare = vi.spyOn(github, 'compare');

    setPosting(true);
    await queue.pause();

    const run = await review();

    compare.mockRejectedValueOnce(
      new GitHubError('GitHub is unavailable.', null, 503, 'unavailable'),
    );
    queue.resume();

    await posted(run.id);

    const { repository } = queue.get('you', postedReviewOperationId(run.id));

    // Compared from the exact commit the target branch points to.
    expect(compare).toHaveBeenCalledWith(
      repository,
      github.scenario.world.repos.refOid(repository, 'main'),
      run.headOid,
    );
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('reads settings saved before approving and resolving had their own switches as on', async () => {
    const { store, runner } = await setup();

    storeRaw(store, 'ai-settings', { postFindings: true });
    expect(runner.settings()).toMatchObject({ approveFindings: true, resolveThreads: true });

    storeRaw(store, 'ai-settings', { postFindings: false });
    expect(runner.settings()).toMatchObject({ approveFindings: false, resolveThreads: false });
  });
});

describe('approvals whose summary is a separate write', () => {
  /** A forge whose approval takes no text, as GitLab's: the summary is a note after it. */
  const gitlabLike = async () => {
    const context = await setup();

    context.github.traits = { ...context.github.traits, approvalCarriesSummary: false };
    context.setPosting(true);

    return context;
  };
  const stored = ({ store }: Setup, runId: string) =>
    store.db
      .select()
      .from(githubOperations)
      .where(
        and(
          eq(githubOperations.account, 'you'),
          eq(githubOperations.id, postedReviewOperationId(runId)),
        ),
      )
      .get()!.data;

  it('approves, then posts the summary, each as its own step', async () => {
    const context = await gitlabLike();
    const { github, review, posted } = context;
    const run = await review(2041);
    const operation = await posted(run.id);

    expect(github.writes.map((write) => write.op)).toEqual([
      'ResolveThread',
      'ResolveThread',
      'ApproveReview',
      'AddComment',
    ]);
    expect(github.writes[2].details.body).toBe('');
    expect(String(github.writes[3].details.body)).toMatch(
      new RegExp(`^${postedReviewMarker(run.id)}`),
    );
    expect(operation.result?.url).toMatch(/#issuecomment-/);
    expect(stored(context, run.id)).toMatchObject({ plan: 2 });
  });

  it('sends only the summary again when the forge refused it after approving', async () => {
    const { github, queue, review, posted } = await gitlabLike();

    github.failNext = 'AddComment';

    const run = await review();
    const failed = await posted(run.id, 'needs_attention');

    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);

    await queue.control('you', failed.id, 'retry');
    await posted(run.id);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview', 'AddComment']);
  });

  it('confirms a lost summary response from the PR, and sends nothing twice', async () => {
    const { github, review, posted } = await gitlabLike();

    github.loseResponseNext = 'AddComment';

    const run = await review();

    await posted(run.id);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview', 'AddComment']);
  });

  it('leaves a lost approval response unconfirmed: no approval names the request that made it', async () => {
    const { github, review, posted } = await gitlabLike();

    github.loseResponseNext = 'ApproveReview';

    const run = await review();
    const unconfirmed = await posted(run.id, 'needs_attention');

    expect(unconfirmed.error?.code).toBe('UNCONFIRMED');
    expect(unconfirmed.confirmStop).toBe(true);
    // Checking cannot settle it: only stopping, after confirming.
    expect(unconfirmed.controls).toEqual(['cancel', 'dismiss']);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('stops for the forge’s rate limit while naming the approval, and keeps its receipt', async () => {
    const context = await gitlabLike();
    const { github, sync, review, posted } = context;
    const refresh = sync.refresh.bind(sync);
    const retryAt = new Date(Date.now() + 300).toISOString();
    const approve = github.approveReview.bind(github);
    let approved = false;

    vi.spyOn(github, 'approveReview').mockImplementation(async (...args) => {
      const receipt = await approve(...args);

      approved = true;
      return receipt;
    });
    // The first read after the approval is the one that names it.
    vi.spyOn(sync, 'refresh').mockImplementation(async (...args) => {
      if (approved) {
        approved = false;
        throw new GitHubError('GitLab rate limit reached.', retryAt, 429, 'rate_limit');
      }

      return refresh(...args);
    });

    const run = await review();

    await posted(run.id, 'waiting');
    expect(Date.parse(sync.status.retryAt!)).toBeGreaterThanOrEqual(Date.parse(retryAt));
    expect(stored(context, run.id).steps[0]).toMatchObject({
      method: 'approveReview',
      completedAt: expect.any(String),
      acknowledged: true,
    });

    // After the limit, the approval is its receipt, never sent again; unnamed, its summary waits.
    await expect
      .poll(() => context.queue.get('you', postedReviewOperationId(run.id)).error?.code, {
        timeout: 2500,
        interval: 20,
      })
      .toBe('APPROVAL_UNKNOWN');
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it.each([
    [
      'someone comments',
      'DISCUSSION_CHANGED',
      ({ pull }: Setup) => commentOn(pull(1839).snapshot, 'This breaks the retry loop.'),
    ],
    [
      'the PR is retargeted',
      'BASE_CHANGED',
      ({ pull }: Setup) => {
        pull(1839).snapshot.baseRefName = 'release';
        pull(1839).snapshot.updatedAt = new Date().toISOString();
      },
    ],
  ])(
    'does not post the summary over a PR that changed after approving: %s',
    async (_change, code, change) => {
      const context = await gitlabLike();
      const { github, queue, review, posted } = context;

      github.failNext = 'AddComment';

      const run = await review();
      const failed = await posted(run.id, 'needs_attention');

      change(context);
      await queue.control('you', failed.id, 'retry');
      await expect
        .poll(() => queue.get('you', failed.id).error?.code, { timeout: 2500, interval: 20 })
        .toBe(code);

      expect(queue.get('you', failed.id).error?.message).toContain(
        'The PR was approved, but its summary was not posted',
      );
      expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
    },
  );

  it.each([
    [
      'you had approved this head before',
      ({ pull }: Setup) =>
        pull(1839).snapshot.reviews.push({
          id: 'approved-earlier',
          state: 'APPROVED',
          submittedAt: '2026-11-05T09:00:00Z',
          updatedAt: '2026-11-05T09:00:00Z',
          commitOid: pull(1839).snapshot.headOid,
          body: '',
          url: `${pull(1839).snapshot.url}#approved-earlier`,
        }),
    ],
    [
      'the approval joins a comment of yours in one review',
      ({ pull }: Setup) =>
        pull(1839).snapshot.reviews.push({
          id: 'your-comment',
          state: 'COMMENTED',
          submittedAt: '2026-11-05T09:00:00Z',
          updatedAt: '2026-11-05T09:00:00Z',
          commitOid: pull(1839).snapshot.headOid,
          body: 'Looked at the loop.',
          url: `${pull(1839).snapshot.url}#your-comment`,
        }),
    ],
  ])('posts the summary when %s', async (_case, seed) => {
    const context = await gitlabLike();
    const { github, sync, idOf, review, posted } = context;
    const approve = github.approveReview.bind(github);

    seed(context);
    await sync.refresh(idOf(1839));
    // GitLab folds the approval into the review that was there: its state changes, not its count.
    vi.spyOn(github, 'approveReview').mockImplementationOnce(async (...args) => {
      const receipt = await approve(...args);
      const reviews = context.pull(1839).snapshot.reviews;

      reviews.splice(reviews.length - 1, 1);
      reviews[reviews.length - 1].state = 'APPROVED';

      return receipt;
    });

    const run = await review();

    await posted(run.id);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview', 'AddComment']);
    expect(String(github.writes[1].details.body).split('\n')[1]).toBe(
      '<!-- review-desk:approval-summary -->',
    );
  });

  it('does not post the summary once you withdrew the approval it goes with', async () => {
    const { github, queue, pull, review, posted } = await gitlabLike();

    github.failNext = 'AddComment';

    const run = await review();
    const failed = await posted(run.id, 'needs_attention');
    const snapshot = pull(1839).snapshot;

    // Withdrawn: no approval of the head on the PR any more.
    snapshot.verdicts = snapshot.verdicts.filter((verdict) => verdict.login !== 'you');
    snapshot.updatedAt = new Date().toISOString();
    await queue.control('you', failed.id, 'retry');
    await expect
      .poll(() => queue.get('you', failed.id).error?.code, { timeout: 2500, interval: 20 })
      .toBe('APPROVAL_WITHDRAWN');
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it.each([false, true])(
    'holds a post queued before summaries were checked, before any write (discussion changed: %s)',
    async (changed) => {
      const context = await gitlabLike();
      const { github, queue, store, pull, review, posted } = context;

      await queue.pause();

      const run = await review();
      const data = stored(context, run.id);
      const action = data.action as Extract<typeof data.action, { type: 'ai_review' }>;
      const { summaryFingerprint: _new, ...basis } = action.basis!;

      // As an earlier version queued it: no summary fingerprint or tag, with or without a plan.
      store.db
        .update(githubOperations)
        .set({
          data: {
            ...data,
            ...(changed ? { plan: 2 as const } : {}),
            action: {
              ...action,
              basis,
              body: action.body.replace('\n<!-- review-desk:approval-summary -->', ''),
            },
          },
        })
        .where(and(eq(githubOperations.account, 'you'), eq(githubOperations.id, data.id)))
        .run();
      if (changed) commentOn(pull(1839).snapshot, 'One more thing.');
      queue.resume();

      const held = await posted(run.id, 'needs_attention');

      expect(held.error?.code).toBe('LEGACY_APPROVAL');
      expect(held.controls).toEqual(['cancel', 'dismiss']);
      expect(github.writes).toEqual([]);
    },
  );

  it('holds a split approval an earlier build saved as refused, before sending it again', async () => {
    const context = await gitlabLike();
    const { github, queue, store, review, posted } = context;

    await queue.pause();

    const run = await review();
    const data = stored(context, run.id);
    const action = data.action as Extract<typeof data.action, { type: 'ai_review' }>;
    const { summaryFingerprint: _new, ...basis } = action.basis!;
    const now = new Date().toISOString();

    store.db
      .update(githubOperations)
      .set({
        data: {
          ...data,
          plan: 2,
          action: { ...action, basis },
          steps: [
            {
              method: 'approveReview',
              args: [data.prId, action.expectedHeadOid, ''],
              startedAt: now,
              completedAt: null,
              result: null,
              uncertain: false,
            },
          ],
        },
      })
      .where(and(eq(githubOperations.account, 'you'), eq(githubOperations.id, data.id)))
      .run();
    queue.resume();

    expect((await posted(run.id, 'needs_attention')).error?.code).toBe('LEGACY_APPROVAL');
    expect(github.writes).toEqual([]);
  });

  it('holds the summary after a restart that came before its approval was named', async () => {
    const context = await gitlabLike();
    const { github, queue, sync, store, review, runner } = context;

    await queue.pause();

    const run = await review();
    const data = stored(context, run.id);
    const action = data.action as Extract<typeof data.action, { type: 'ai_review' }>;
    const now = new Date().toISOString();

    // Approved and receipted, then stopped before it was named; meanwhile it may be replaced.
    await github.approveReview(data.prId, action.expectedHeadOid, '');
    store.db
      .update(githubOperations)
      .set({
        status: 'running',
        data: {
          ...data,
          plan: 2,
          status: 'running',
          steps: [
            {
              method: 'approveReview',
              args: [data.prId, action.expectedHeadOid, ''],
              startedAt: now,
              completedAt: now,
              result: { url: data.prUrl },
              uncertain: false,
              acknowledged: true,
            },
          ],
        },
      })
      .where(and(eq(githubOperations.account, 'you'), eq(githubOperations.id, data.id)))
      .run();
    github.writes.length = 0;
    await queue.close();

    const reopened = new OperationQueue(sync, { mutationIntervalMs: 0, retryDelaysMs: [1, 2, 3] });

    reopened.posting = () => runner.settings();
    cleanups.push(() => reopened.close());
    reopened.open();

    await expect
      .poll(() => reopened.get('you', data.id).error?.code, { timeout: 2500, interval: 20 })
      .toBe('APPROVAL_UNKNOWN');
    expect(github.writes).toEqual([]);
  });

  it('does not post the summary with an approval that replaced the one this post gave', async () => {
    const { github, queue, pull, review, posted } = await gitlabLike();
    const add = github.addConversationComment.bind(github);
    let attempts = 0;

    // The summary is checked (recording this post's approval), then refused.
    vi.spyOn(github, 'addConversationComment').mockImplementation(async (...args) => {
      if (++attempts === 1)
        throw new GitHubError('GitLab refused the note.', null, 400, 'rejected');

      return add(...args);
    });

    const run = await review();
    const failed = await posted(run.id, 'needs_attention');
    const snapshot = pull(1839).snapshot;

    // Withdrawn and given again by hand on the same head: another approval.
    snapshot.verdicts = snapshot.verdicts.map((verdict) =>
      verdict.login === 'you' ? { ...verdict, id: 'note-by-hand' } : verdict,
    );
    snapshot.updatedAt = new Date().toISOString();
    await queue.control('you', failed.id, 'retry');
    await expect
      .poll(() => queue.get('you', failed.id).error?.code, { timeout: 2500, interval: 20 })
      .toBe('APPROVAL_WITHDRAWN');
    expect(attempts).toBe(1);
  });

  it('can be stopped after a restart lost the summary’s response, keeping the approval', async () => {
    const context = await gitlabLike();
    const { github, queue, sync, store, review, runner } = context;

    await queue.pause();

    const run = await review();
    const data = stored(context, run.id);
    const action = data.action as Extract<typeof data.action, { type: 'ai_review' }>;
    const now = new Date().toISOString();

    // Approved; the summary step saved, then the process stopped before it was sent.
    await github.approveReview(data.prId, action.expectedHeadOid, '');
    store.db
      .update(githubOperations)
      .set({
        status: 'running',
        data: {
          ...data,
          plan: 2,
          status: 'running',
          steps: [
            {
              method: 'approveReview',
              args: [data.prId, action.expectedHeadOid, ''],
              startedAt: now,
              completedAt: now,
              result: { url: data.prUrl },
              uncertain: false,
              acknowledged: true,
            },
            {
              method: 'addConversationComment',
              args: [data.prId, action.body],
              startedAt: now,
              completedAt: null,
              result: null,
              uncertain: true,
            },
          ],
        },
      })
      .where(and(eq(githubOperations.account, 'you'), eq(githubOperations.id, data.id)))
      .run();
    github.writes.length = 0;
    await queue.close();

    const reopened = new OperationQueue(sync, { mutationIntervalMs: 0, retryDelaysMs: [1, 2, 3] });

    reopened.posting = () => runner.settings();
    cleanups.push(() => reopened.close());
    reopened.open();

    await expect
      .poll(() => reopened.get('you', data.id).status, { timeout: 2500, interval: 20 })
      .toBe('needs_attention');

    const unconfirmed = reopened.get('you', data.id);

    expect(unconfirmed.error?.code).toBe('UNCONFIRMED');
    expect(unconfirmed.controls).toEqual(['check', 'cancel', 'dismiss']);

    const { operation } = await reopened.control('you', data.id, 'cancel', true);

    expect(operation.progress).toBe(
      'Stopped. The PR was approved; check whether its summary was posted.',
    );
    expect(github.writes).toEqual([]);
  });

  it('comments rather than approving again where you had approved the PR already', async () => {
    const { github, pull, sync, idOf, review, posted } = await gitlabLike();
    const snapshot = pull(1839).snapshot;

    snapshot.verdicts.push({
      id: 'note-yours',
      login: 'you',
      state: 'APPROVED',
      submittedAt: '2026-11-05T09:00:00Z',
      commitOid: snapshot.headOid,
    });
    snapshot.updatedAt = new Date().toISOString();
    await sync.refresh(idOf(1839));

    const run = await review();

    await posted(run.id);
    expect(run.publication).toMatchObject({
      event: 'COMMENT',
      reason: 'You had already approved this PR.',
    });
    expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
    expect(String(github.writes[0].details.body)).not.toContain('approval-summary');
  });

  it('finds a summary whose response was lost by the PR’s id, after its repository moved', async () => {
    const { github, pull, review, posted } = await gitlabLike();
    const add = github.addConversationComment.bind(github);

    vi.spyOn(github, 'addConversationComment').mockImplementationOnce(async (...args) => {
      await add(...args);
      pull(1839).snapshot.repository = 'acme/renamed';

      throw new GitHubError('The response was lost.');
    });

    const run = await review();

    await posted(run.id);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview', 'AddComment']);
  });

  it('says the PR was approved when its summary is cancelled', async () => {
    const { github, queue, review, posted } = await gitlabLike();

    github.failNext = 'AddComment';

    const run = await review();
    const failed = await posted(run.id, 'needs_attention');
    const { operation } = await queue.control('you', failed.id, 'cancel');

    expect(operation.progress).toBe('Cancelled. The PR was approved; its summary was not posted.');
  });

  it('does not take a review that groups other notes for the approval of the head', async () => {
    const context = await gitlabLike();
    const { github, queue, store, pull, review, posted } = context;

    await queue.pause();

    const run = await review();
    const data = stored(context, run.id);
    const action = data.action as Extract<typeof data.action, { type: 'ai_review' }>;
    const snapshot = pull(1839).snapshot;
    const now = new Date().toISOString();

    // Stopped after saving the approval step, before sending it. A review on the head that only
    // groups notes is on the PR, but no approval of the head is.
    snapshot.reviews.push({
      id: 'grouped',
      state: 'APPROVED',
      submittedAt: now,
      updatedAt: now,
      commitOid: action.expectedHeadOid,
      body: '',
      url: `${snapshot.url}#grouped`,
    });
    store.db
      .update(githubOperations)
      .set({
        status: 'checking',
        data: {
          ...data,
          plan: 2,
          status: 'checking',
          steps: [
            {
              method: 'approveReview',
              args: [data.prId, action.expectedHeadOid, ''],
              startedAt: now,
              completedAt: null,
              result: null,
              uncertain: true,
            },
          ],
        },
      })
      .where(and(eq(githubOperations.account, 'you'), eq(githubOperations.id, data.id)))
      .run();
    queue.resume();

    expect((await posted(run.id, 'needs_attention')).error?.code).toBe('UNCONFIRMED');
    expect(github.writes).toEqual([]);
  });

  it.each([
    ['after the approval', 1, ['AddComment']],
    ['after the summary', 2, []],
  ])(
    'resumes after a restart right %s, sending only what is left',
    async (_when, receipts, writes) => {
      const context = await gitlabLike();
      const { github, queue, sync, store, review, runner } = context;

      await queue.pause();

      const run = await review();
      const data = stored(context, run.id);
      const action = data.action as Extract<typeof data.action, { type: 'ai_review' }>;
      const now = new Date().toISOString();
      const receipt = (method: string, args: unknown[]) => ({
        method,
        args,
        startedAt: now,
        completedAt: now,
        result: { url: `${data.prUrl}#receipt` },
        uncertain: false,
        acknowledged: true,
      });

      // What the forge holds, and the receipts as the outbox saved them, with the process
      // stopped right after the last.
      await github.approveReview(data.prId, action.expectedHeadOid, '');
      if (receipts === 2) await github.addConversationComment(data.prId, action.body);
      store.db
        .update(githubOperations)
        .set({
          status: 'running',
          data: {
            ...data,
            plan: 2,
            status: 'running',
            // Named right after it was given, as the live send does.
            approvalId: context
              .pull(1839)
              .snapshot.verdicts.find((verdict) => verdict.login === 'you')?.id,
            steps: [
              receipt('approveReview', [data.prId, action.expectedHeadOid, '']),
              ...(receipts === 2
                ? [receipt('addConversationComment', [data.prId, action.body])]
                : []),
            ],
          },
        })
        .where(and(eq(githubOperations.account, 'you'), eq(githubOperations.id, data.id)))
        .run();
      github.writes.length = 0;
      await queue.close();

      const reopened = new OperationQueue(sync, {
        mutationIntervalMs: 0,
        retryDelaysMs: [1, 2, 3],
      });

      reopened.posting = () => runner.settings();
      cleanups.push(() => reopened.close());
      reopened.open();

      await expect
        .poll(() => reopened.get('you', data.id).status, { timeout: 2500, interval: 20 })
        .toBe('succeeded');
      expect(github.writes.map((write) => write.op)).toEqual(writes);
    },
  );

  describe('a row from before approvals were split', () => {
    /** Queues the post, then rewrites it as the old plan saved it: one step for both writes. */
    const legacy = async (
      on: { approved: boolean; summary: boolean },
      answered: boolean,
      before?: (context: Setup) => void,
    ) => {
      const context = await setup();
      const { github, queue, pull, store, review, setPosting } = context;

      setPosting(true);
      await queue.pause();

      const run = await review();
      const data = stored(context, run.id);
      const action = data.action as Extract<typeof data.action, { type: 'ai_review' }>;
      const snapshot = pull(1839).snapshot;
      const now = new Date().toISOString();

      // As GitLab reads it: a verdict from the approval's own note.
      if (on.approved)
        snapshot.verdicts.push({
          id: 'note-approved-earlier',
          login: 'you',
          state: 'APPROVED',
          submittedAt: now,
          commitOid: action.expectedHeadOid,
        });
      if (on.summary)
        commentOn(snapshot, `${postedReviewMarker(run.id)}\nNo blocking findings.`, 'you');
      snapshot.updatedAt = now;

      const status = answered ? 'queued' : 'checking';

      store.db
        .update(githubOperations)
        .set({
          status,
          data: {
            ...data,
            status,
            steps: [
              {
                method: 'approveReview',
                args: [data.prId, action.expectedHeadOid, action.body],
                startedAt: now,
                completedAt: null,
                result: null,
                uncertain: !answered,
              },
            ],
          },
        })
        .where(and(eq(githubOperations.account, 'you'), eq(githubOperations.id, data.id)))
        .run();
      github.traits = { ...github.traits, approvalCarriesSummary: false };
      before?.(context);
      queue.resume();

      return { ...context, run };
    };

    it('is done when both went out, and sends nothing again otherwise', async () => {
      const both = await legacy({ approved: true, summary: true }, true);

      await both.posted(both.run.id);
      expect(both.github.writes).toEqual([]);

      // The approval alone, or neither: GitLab's history cannot tell a send that failed from an
      // approval since withdrawn, so it waits for you, whatever Settings say now.
      for (const on of [
        { approved: true, summary: false },
        { approved: false, summary: false },
      ]) {
        const unsure = await legacy(on, true, (context) =>
          context.setPosting(true, undefined, { approveFindings: false, resolveThreads: false }),
        );
        const held = await unsure.posted(unsure.run.id, 'needs_attention');

        expect(held.error?.code).toBe('UNCONFIRMED');
        expect(held.controls).toContain('cancel');
        expect(unsure.github.writes).toEqual([]);
      }
    });

    it('says the approval may have gone out when a refused one is stopped', async () => {
      const { queue, posted, run, github } = await legacy({ approved: true, summary: false }, true);
      const held = await posted(run.id, 'needs_attention');

      await expect(queue.control('you', held.id, 'cancel')).rejects.toMatchObject({
        code: 'CONFIRM_REQUIRED',
      });

      const { operation } = await queue.control('you', held.id, 'cancel', true);

      expect(operation.progress).toBe(
        'Stopped. Check GitLab: the approval may have gone out without its summary.',
      );
      expect(github.writes).toEqual([]);
    });

    it('stays stopped when cancelled while the PR is checked', async () => {
      const context = await legacy(
        { approved: true, summary: false },
        true,
        ({ github, queue }) => {
          vi.spyOn(github, 'markedComment').mockImplementationOnce(async () => {
            const row = queue.list('you').items.find((item) => item.action.type === 'ai_review')!;

            // Confirmed: the refused step may have approved.
            await queue.control('you', row.id, 'cancel', true);

            return { id: 'posted', url: 'posted-url' };
          });
        },
      );

      expect((await context.posted(context.run.id, 'cancelled')).status).toBe('cancelled');
      expect(context.github.writes).toEqual([]);
    });

    it('finds the summary through every page, and never assumes it is missing', async () => {
      // Pushed out of the snapshot's latest comments, but on the PR: done.
      const found = await legacy({ approved: true, summary: false }, true, ({ github }) => {
        vi.spyOn(github, 'markedComment').mockResolvedValue({ id: 'older', url: 'older-url' });
      });

      await found.posted(found.run.id);
      expect(found.github.writes).toEqual([]);

      const unknown = await legacy({ approved: true, summary: false }, true, ({ github }) => {
        vi.spyOn(github, 'markedComment').mockRejectedValue(
          new GitHubError('The conversation is too long to check for an earlier post.'),
        );
      });

      await unknown.posted(unknown.run.id, 'needs_attention');
      expect(unknown.github.writes).toEqual([]);
    });

    it('leaves a lost response unconfirmed unless both are on the PR', async () => {
      const lost = await legacy({ approved: true, summary: false }, false);

      expect((await lost.posted(lost.run.id, 'needs_attention')).error?.code).toBe('UNCONFIRMED');
      expect(lost.github.writes).toEqual([]);

      const both = await legacy({ approved: true, summary: true }, false);

      await both.posted(both.run.id);
      expect(both.github.writes).toEqual([]);
    });
  });
});

describe('the publication fingerprint', () => {
  const pr = (changes: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot =>
    ({
      ...structuredClone(
        defaultScenario(Date.parse('2026-11-05T10:00:00Z')).world.pulls[0].snapshot,
      ),
      ...changes,
    }) as PullRequestSnapshot;

  it('ignores comment times and this run’s own post, but not edits or other runs’ posts', () => {
    const reviewed = pr();
    const base = publicationFingerprint(reviewed, 'run-1', 'you');
    const touched = structuredClone(reviewed);

    for (const thread of touched.threads)
      for (const comment of thread.comments) comment.updatedAt = '2030-01-01T00:00:00Z';

    expect(publicationFingerprint(touched, 'run-1', 'you')).toBe(base);

    const own = structuredClone(reviewed);

    commentOn(own, `${postedReviewMarker('run-1')}\nNo blocking findings.`, 'you');
    expect(publicationFingerprint(own, 'run-1', 'you')).toBe(base);

    // Someone else's comment counts, even when it carries the marker.
    const copied = structuredClone(reviewed);

    commentOn(copied, `${postedReviewMarker('run-1')}\nI agree.`);
    expect(publicationFingerprint(copied, 'run-1', 'you')).not.toBe(base);

    // Another reviewer's verdict counts; yours, which an approval changes, does not.
    const verdict = (login: string) => ({
      ...structuredClone(reviewed),
      verdicts: [
        ...(reviewed.verdicts ?? []),
        {
          login,
          state: 'CHANGES_REQUESTED' as const,
          submittedAt: '2030-01-01T00:00:00Z',
          commitOid: reviewed.headOid,
        },
      ],
    });

    expect(publicationFingerprint(verdict('someone-else'), 'run-1', 'you')).not.toBe(base);
    expect(publicationFingerprint(verdict('you'), 'run-1', 'you')).toBe(base);

    // The same reviewer approving the same commit again is a new review: the forge's id says so.
    const approval = (id: string) => ({
      ...structuredClone(reviewed),
      verdicts: [
        {
          id,
          login: 'someone-else',
          state: 'APPROVED' as const,
          submittedAt: '2030-01-01T00:00:00Z',
          commitOid: reviewed.headOid,
        },
      ],
    });

    expect(publicationFingerprint(approval('second'), 'run-1', 'you')).not.toBe(
      publicationFingerprint(approval('first'), 'run-1', 'you'),
    );

    const other = structuredClone(reviewed);

    commentOn(other, `${postedReviewMarker('run-2')}\nChanges recommended.`);
    expect(publicationFingerprint(other, 'run-1', 'you')).not.toBe(base);

    if (reviewed.threads[0]?.comments[0]) {
      const edited = structuredClone(reviewed);

      edited.threads[0].comments[0].body += ' (edited)';
      expect(publicationFingerprint(edited, 'run-1', 'you')).not.toBe(base);
    }
  });

  it('counts a thread this post resolved as reviewed only while it stays resolved', () => {
    const reviewed = pr();
    const thread = reviewed.threads.find((candidate) => !candidate.isResolved);

    if (!thread) return;

    const base = publicationFingerprint(reviewed, 'run-1', 'you');
    const resolved = structuredClone(reviewed);

    resolved.threads.find((candidate) => candidate.id === thread.id)!.isResolved = true;
    expect(publicationFingerprint(resolved, 'run-1', 'you', new Set([thread.id]))).toBe(base);
    expect(publicationFingerprint(resolved, 'run-1', 'you')).not.toBe(base);
  });
});

describe('review evidence', () => {
  const reviewed = defaultScenario(Date.parse('2026-11-05T10:00:00Z')).world.pulls[0]
    .snapshot as PullRequestSnapshot;
  const measured = (changes: Partial<ReviewInputs> = {}): ReviewInputs => ({
    ...unverified(reviewed, 'merge-base'),
    inventory: 'verified',
    complete: true,
    ...changes,
  });

  it('is measured for a new run, and only ever taken down after', () => {
    const complete = measured();
    const incomplete = measured({
      complete: false,
      unreadable: [{ path: 'a.ts', side: 'after' }],
      unreadableCount: 1,
    });

    expect(evidence({ inputs: null, threadId: null }, complete, reviewed)).toEqual(complete);
    expect(evidence({ inputs: incomplete, threadId: 'thread' }, complete, reviewed)).toEqual(
      incomplete,
    );
    expect(evidence({ inputs: complete, threadId: 'thread' }, incomplete, reviewed)).toMatchObject({
      complete: false,
      unreadable: [{ path: 'a.ts', side: 'after' }],
    });
  });

  it('names the commits of an answer from before evidence was recorded, claiming nothing', () => {
    expect(evidence({ inputs: null, threadId: 'thread' }, measured(), reviewed)).toEqual({
      ...unverified(reviewed, 'merge-base'),
      complete: false,
    });
    expect(evidence({ inputs: null, threadId: 'thread' }, null, reviewed)).toBeNull();
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

    expect(overview.settings).toMatchObject({
      postFindings: false,
      approveFindings: false,
      resolveThreads: false,
    });

    // Saving agents and tasks never changes a posting switch, so a page holding older settings
    // cannot turn one back on.
    const agents = await app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers,
      payload: {
        account: 'you',
        settings: { ...overview.settings, postFindings: true, approveFindings: true },
      },
    });

    expect(agents.statusCode).toBe(200);
    expect(agents.json()).toMatchObject({ postFindings: false, approveFindings: false });

    // The switches are saved one at a time; the others keep their value.
    const posting = await app.inject({
      method: 'PUT',
      url: '/api/ai/automation',
      headers,
      payload: { account: 'you', changes: { postFindings: true } },
    });
    const approving = await app.inject({
      method: 'PUT',
      url: '/api/ai/automation',
      headers,
      payload: { account: 'you', changes: { approveFindings: true } },
    });

    expect(posting.statusCode).toBe(200);
    expect(approving.json()).toMatchObject({
      postFindings: true,
      approveFindings: true,
      resolveThreads: false,
    });

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers,
      payload: { account: 'you', settings: overview.settings },
    });

    expect(stale.json()).toMatchObject({ postFindings: true, approveFindings: true });

    const id = sync.list().items.find((item) => item.number === 1839)!.id;
    const started = await app.inject({
      method: 'POST',
      url: `/api/accounts/you/pulls/${id}/ai`,
      headers,
      payload: { task: 'full_review' },
    });

    expect(started.statusCode).toBe(200);

    const operations = async () =>
      (
        await app.inject({ method: 'GET', url: '/api/accounts/you/operations', headers })
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
