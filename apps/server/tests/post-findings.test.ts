import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { aiRuns } from '@/db/schema.js';
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

/** Someone else comments on the PR in the conversation, as GitHub would list it. */
function commentOn(
  snapshot: Pick<PullRequestSnapshot, 'conversation' | 'url' | 'updatedAt'>,
  body: string,
) {
  const now = new Date().toISOString();

  snapshot.conversation.push({
    id: `comment-${snapshot.conversation.length + 1}`,
    author: { login: 'someone-else' },
    body,
    createdAt: now,
    updatedAt: now,
    url: `${snapshot.url}#issuecomment-${snapshot.conversation.length + 1}`,
  });
  snapshot.updatedAt = now;
}

describe('what an automatic post rests on', () => {
  it('saves the decision with the run: a failed save leaves it unposted and resumable', async () => {
    const { queue, runner, store, setPosting, review, settled, postings, posted, github } =
      await setup();

    setPosting(true);
    vi.spyOn(queue, 'enqueueAutomatic').mockImplementationOnce(() => {
      throw new Error('The disk is full.');
    });

    const failed = await review();

    expect(failed).toMatchObject({ status: 'failed', publication: null });
    expect(failed.request).not.toBeNull();
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

    change(context);
    queue.resume();

    expect((await posted(run.id, 'cancelled')).progress).toBe(`Not posted: ${reason}`);
    expect(github.writes).toEqual([]);
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

  it('waits for you before an approval queued before inputs were checked', async () => {
    const { queue, review, posted, github } = await setup();
    const run = await review();

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
    expect(compare).toHaveBeenCalledWith(expect.any(String), 'main', run.headOid);
    expect(github.writes.map((write) => write.op)).toEqual(['ApproveReview']);
  });

  it('reads settings saved before approving and resolving had their own switches as on', async () => {
    const { store, runner } = await setup();

    store.setSetting('ai-settings', { postFindings: true });
    expect(runner.settings()).toMatchObject({ approveFindings: true, resolveThreads: true });

    store.setSetting('ai-settings', { postFindings: false });
    expect(runner.settings()).toMatchObject({ approveFindings: false, resolveThreads: false });
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
    const base = publicationFingerprint(reviewed, 'run-1');
    const touched = structuredClone(reviewed);

    for (const thread of touched.threads)
      for (const comment of thread.comments) comment.updatedAt = '2030-01-01T00:00:00Z';

    expect(publicationFingerprint(touched, 'run-1')).toBe(base);

    const own = structuredClone(reviewed);

    commentOn(own, `${postedReviewMarker('run-1')}\nNo blocking findings.`);
    expect(publicationFingerprint(own, 'run-1')).toBe(base);

    const other = structuredClone(reviewed);

    commentOn(other, `${postedReviewMarker('run-2')}\nChanges recommended.`);
    expect(publicationFingerprint(other, 'run-1')).not.toBe(base);

    if (reviewed.threads[0]?.comments[0]) {
      const edited = structuredClone(reviewed);

      edited.threads[0].comments[0].body += ' (edited)';
      expect(publicationFingerprint(edited, 'run-1')).not.toBe(base);
    }
  });

  it('counts a thread this post resolved as reviewed only while it stays resolved', () => {
    const reviewed = pr();
    const thread = reviewed.threads.find((candidate) => !candidate.isResolved);

    if (!thread) return;

    const base = publicationFingerprint(reviewed, 'run-1');
    const resolved = structuredClone(reviewed);

    resolved.threads.find((candidate) => candidate.id === thread.id)!.isResolved = true;
    expect(publicationFingerprint(resolved, 'run-1', new Set([thread.id]))).toBe(base);
    expect(publicationFingerprint(resolved, 'run-1')).not.toBe(base);
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

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers,
      payload: {
        account: 'you',
        settings: { ...overview.settings, postFindings: true, approveFindings: true },
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ postFindings: true, approveFindings: true });

    // A window opened before the settings existed does not turn them off.
    const {
      postFindings: _left,
      approveFindings: _approve,
      resolveThreads: _resolve,
      ...older
    } = overview.settings;
    const resaved = await app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers,
      payload: { account: 'you', settings: older },
    });

    expect(resaved.json()).toMatchObject({ postFindings: true, approveFindings: true });

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
