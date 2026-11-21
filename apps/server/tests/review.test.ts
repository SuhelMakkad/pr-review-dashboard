import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import type { GitHubApi } from '@/github/api.js';
import { EventBus } from '@/events.js';
import { ReviewError, ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/index.js';

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

async function setup() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events);

  stores.push(store);
  await sync.sync();

  const reviews = new ReviewService(sync, github, new DiffService(github), events);
  const pr = (number: number) => {
    const item = [...sync.list().items, ...sync.mine().items].find(
      (entry) => entry.number === number,
    )!;

    return sync.detail(item.id)!;
  };

  return { store, github, sync, reviews, pr };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof ReviewError ? error.code : String(error);
  }

  return 'ok';
};

const ops = (github: FixtureGitHub) => github.writes.map((write) => write.op);

describe('drafting', () => {
  it('takes line comments only from a confirmed diff of the revision the PR has', async () => {
    const { reviews, pr, github } = await setup();
    const detail = pr(1839);
    const path = detail.snapshot.files[0].path;
    const revision = { headOid: detail.snapshot.headOid, baseOid: detail.snapshot.baseOid ?? null };

    // Picked in a diff of another head than the PR has now.
    expect(
      await code(
        reviews.addComment(detail.snapshot.id, {
          account: 'you',
          path,
          line: 2,
          body: 'Picked in an older diff',
          revision: { ...revision, headOid: 'e'.repeat(40) },
        }),
      ),
    ).toBe('HEAD_MOVED');

    // A forge that keys diffs but has no record of this revision: its live diff is unconfirmed.
    const pullFiles = github.pullFiles.bind(github);

    github.traits = { ...github.traits, pinnedFiles: true };

    (github as GitHubApi).pinnedFiles = async (repository, number) => ({
      files: await pullFiles(repository, number),
      pinned: false,
    });

    expect(
      await code(
        reviews.addComment(detail.snapshot.id, {
          account: 'you',
          path,
          line: 2,
          body: 'On a line of an unconfirmed diff',
          revision,
        }),
      ),
    ).toBe('DIFF_UNCONFIRMED');

    // A whole-file comment has no lines to misplace.
    expect(
      await code(
        reviews.addComment(detail.snapshot.id, {
          account: 'you',
          path,
          line: null,
          body: 'On the whole file',
        }),
      ),
    ).toBe('ok');
    expect(reviews.draft('you', detail.snapshot.id).comments).toHaveLength(1);
  });

  it('keeps comments local until submit and rejects lines GitHub would refuse', async () => {
    const { reviews, pr, github } = await setup();
    const detail = pr(1839);
    const path = detail.snapshot.files[0].path;

    const comment = await reviews.addComment(detail.snapshot.id, {
      account: 'you',
      path,
      line: 2,
      body: 'Why this name?',
    });

    expect(comment).toMatchObject({
      path,
      line: 2,
      side: 'RIGHT',
      status: 'draft',
      anchorOid: detail.snapshot.headOid,
    });
    expect(
      await code(
        reviews.addComment(detail.snapshot.id, { account: 'you', path, line: 9999, body: 'Nope' }),
      ),
    ).toBe('NOT_COMMENTABLE');
    expect(reviews.draft('you', detail.snapshot.id).comments).toHaveLength(1);

    await reviews.updateComment('you', detail.snapshot.id, comment.id, 'Why this name, though?');
    expect(reviews.draft('you', detail.snapshot.id).comments[0].body).toBe(
      'Why this name, though?',
    );

    await reviews.deleteComment('you', detail.snapshot.id, comment.id);
    expect(reviews.draft('you', detail.snapshot.id).comments).toEqual([]);
    expect(github.writes).toEqual([]);
  });
});

describe('submitting a review', () => {
  it('resolves every open thread before approving and leaves resolved threads alone', async () => {
    const { reviews, pr, github, sync } = await setup();
    const snapshot = pr(2041).snapshot;
    const remote = github.scenario.world.pulls.find((pull) => pull.snapshot.id === snapshot.id)!;

    remote.snapshot.threads.push({
      ...snapshot.threads[0],
      id: 'already-resolved',
      isResolved: true,
    });

    await reviews.submit(snapshot.id, {
      account: 'you',
      event: 'APPROVE',
      body: 'The suggestions have been addressed.',
      expectedHeadOid: snapshot.headOid,
    });

    expect(ops(github)).toEqual([
      'ResolveThread',
      'ResolveThread',
      'AddPendingReview',
      'SubmitReview',
    ]);
    expect(github.writes.slice(0, 2).map((write) => write.details.threadId)).toEqual(
      snapshot.threads.map((thread) => thread.id),
    );
    expect(sync.detail(snapshot.id)!.snapshot.threads.every((thread) => thread.isResolved)).toBe(
      true,
    );
  });

  it.each(['COMMENT', 'REQUEST_CHANGES'] as const)(
    'leaves open threads unresolved for %s',
    async (event) => {
      const { reviews, pr, github, sync } = await setup();
      const snapshot = pr(2041).snapshot;

      await reviews.submit(snapshot.id, {
        account: 'you',
        event,
        body: 'Follow-up feedback.',
        expectedHeadOid: snapshot.headOid,
      });

      expect(ops(github)).toEqual(['AddPendingReview', 'SubmitReview']);
      expect(sync.detail(snapshot.id)!.snapshot.threads.some((thread) => !thread.isResolved)).toBe(
        true,
      );
    },
  );

  it('sends one pending review with every comment, then a single submit', async () => {
    const { reviews, pr, github, sync } = await setup();
    const detail = pr(1839);
    const id = detail.snapshot.id;
    const path = detail.snapshot.files[0].path;

    await reviews.addComment(id, { account: 'you', path, line: 2, body: 'First' });
    await reviews.addComment(id, {
      account: 'you',
      path,
      line: null,
      body: 'About the whole file',
    });

    const result = await reviews.submit(id, {
      account: 'you',
      event: 'APPROVE',
      body: 'Ship it',
      expectedHeadOid: detail.snapshot.headOid,
    });

    expect(result.submittedComments).toBe(2);
    expect(ops(github)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'AddReviewThread',
      'SubmitReview',
    ]);
    expect(github.writes[2].details).toMatchObject({ subjectType: 'FILE' });
    expect(reviews.draft('you', id).comments).toEqual([]);
    expect(sync.detail(id)!.item.latestReview?.state).toBe('APPROVED');
    expect(sync.detail(id)!.item.queue).toBe('caught_up');
  });

  it('resumes after a failure without duplicating comments', async () => {
    const { reviews, pr, github } = await setup();
    const detail = pr(1839);
    const id = detail.snapshot.id;
    const path = detail.snapshot.files[0].path;
    const request = {
      account: 'you',
      event: 'COMMENT' as const,
      body: '',
      expectedHeadOid: detail.snapshot.headOid,
    };

    await reviews.addComment(id, { account: 'you', path, line: 2, body: 'One' });
    await reviews.addComment(id, { account: 'you', path, line: 3, body: 'Two' });
    github.failNext = 'SubmitReview';

    expect(await code(reviews.submit(id, request))).toBe('GITHUB_ERROR');
    expect(reviews.draft('you', id).comments.map((comment) => comment.status)).toEqual([
      'pushed',
      'pushed',
    ]);

    await reviews.submit(id, request);

    expect(ops(github)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'AddReviewThread',
      'SubmitReview',
    ]);
  });

  it('refuses a moved head unless confirmed, then re-anchors or flags comments', async () => {
    const { reviews, pr, github, sync } = await setup();
    const detail = pr(1839);
    const id = detail.snapshot.id;
    const path = 'src/scheduling/CalendarSettings.tsx';
    const oldHead = detail.snapshot.headOid;

    await reviews.addComment(id, { account: 'you', path, line: 10, body: 'Unchanged line' });
    await reviews.addComment(id, { account: 'you', path, line: 4, body: 'This line will change' });

    // Push a commit that inserts two lines at the top and rewrites line 4.
    const world = github.scenario.world;
    const pull = world.pulls.find((candidate) => candidate.snapshot.id === id)!;
    const newHead = createHash('sha1').update('pushed-after-draft').digest('hex');
    const current = world.repos.blob(pull.snapshot.repository, oldHead, path)!.text!;
    const lines = current.split('\n');

    lines[3] = 'export const step4 = () => "rewritten";';
    world.repos.derive(pull.snapshot.repository, newHead, oldHead, {
      [path]: ['// header', '// header', ...lines].join('\n'),
    });
    pull.snapshot.headOid = newHead;

    const request = {
      account: 'you',
      event: 'COMMENT' as const,
      body: '',
      expectedHeadOid: oldHead,
    };

    expect(await code(reviews.submit(id, request))).toBe('HEAD_MOVED');
    expect(await code(reviews.submit(id, { ...request, allowNewHead: true }))).toBe(
      'STALE_COMMENTS',
    );

    const comments = reviews.draft('you', id).comments;

    expect(comments.find((comment) => comment.body === 'Unchanged line')).toMatchObject({
      line: 12,
      anchorOid: newHead,
      status: 'draft',
    });
    expect(comments.find((comment) => comment.body === 'This line will change')?.status).toBe(
      'stale',
    );
    expect(github.writes).toEqual([]);

    await reviews.deleteComment(
      'you',
      id,
      comments.find((comment) => comment.status === 'stale')!.id,
    );
    await reviews.submit(id, { ...request, expectedHeadOid: sync.detail(id)!.snapshot.headOid });

    expect(ops(github)).toEqual(['AddPendingReview', 'AddReviewThread', 'SubmitReview']);
    expect(github.writes[1].details).toMatchObject({ line: 12 });
  });

  it('refuses to write when the GitHub CLI switched accounts', async () => {
    const { reviews, pr, github } = await setup();
    const detail = pr(1839);

    vi.spyOn(github, 'identity').mockResolvedValue({ login: 'someone-else' });

    expect(
      await code(
        reviews.submit(detail.snapshot.id, {
          account: 'you',
          event: 'APPROVE',
          body: '',
          expectedHeadOid: detail.snapshot.headOid,
        }),
      ),
    ).toBe('ACCOUNT_CHANGED');
    expect(github.writes).toEqual([]);
  });
});

describe('thread and file actions', () => {
  it('replies, resolves and marks files viewed, reflecting each on the PR', async () => {
    const { reviews, pr, github, sync } = await setup();
    const detail = pr(2041);
    const id = detail.snapshot.id;
    const thread = detail.snapshot.threads[0];

    const reply = await reviews.reply('you', id, thread.id, 'Thanks, looks right now.');

    expect(reply.pending).toBe(false);
    expect(sync.detail(id)!.snapshot.threads[0].comments.at(-1)?.body).toBe(
      'Thanks, looks right now.',
    );

    await reviews.resolve('you', id, thread.id, true);
    expect(sync.detail(id)!.snapshot.threads[0].isResolved).toBe(true);

    await reviews.setViewed('you', id, 'src/facts/backfill.ts', true);
    expect(
      sync.detail(id)!.snapshot.files.find((file) => file.path === 'src/facts/backfill.ts')
        ?.viewerViewedState,
    ).toBe('VIEWED');
    expect(ops(github)).toEqual(['ReplyToThread', 'ResolveThread', 'MarkFileViewed']);
  });

  it('does not bring back a PR removed while a viewed-file write was in flight', async () => {
    const { github, sync, reviews } = await setup();
    const { snapshot } = await sync.track('you', 'acme/api', 2066);

    let release!: () => void;
    const written = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });

    vi.spyOn(github, 'setFileViewed').mockImplementationOnce(() => written);

    const viewing = reviews.setViewed('you', snapshot.id, 'src/summaries/cache.ts', true);

    await vi.waitFor(() => expect(github.setFileViewed).toHaveBeenCalled());
    sync.untrack('you', snapshot.id);
    release();
    await viewing;

    expect(sync.detail(snapshot.id)).toBeNull();
  });

  it('posts a single comment immediately, or to the conversation', async () => {
    const { reviews, pr, github } = await setup();
    const detail = pr(1839);
    const path = detail.snapshot.files[0].path;

    await reviews.commentNow(detail.snapshot.id, {
      account: 'you',
      path,
      line: 2,
      body: 'Quick note',
    });
    await reviews.commentNow(detail.snapshot.id, {
      account: 'you',
      path: '',
      line: null,
      body: 'Overall looks good',
    });

    expect(ops(github)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'SubmitReview',
      'AddComment',
    ]);
  });

  it('rate-limits bursts of writes', async () => {
    const { reviews, pr } = await setup();
    const detail = pr(2041);
    const results: string[] = [];

    for (let index = 0; index < 21; index++) {
      results.push(
        await code(
          reviews.setViewed('you', detail.snapshot.id, 'src/facts/backfill.ts', index % 2 === 0),
        ),
      );
    }

    expect(results.filter((result) => result === 'ok')).toHaveLength(20);
    expect(results.at(-1)).toBe('RATE_LIMITED');
  });
});

describe('author actions', () => {
  it('re-requests reviewers on your own PR only', async () => {
    const { reviews, pr, github, sync } = await setup();
    const own = pr(3001);

    await reviews.requestReviewers('you', own.snapshot.id, ['mara']);

    expect(ops(github)).toEqual(['RequestReviews']);
    expect(
      sync.detail(own.snapshot.id)!.snapshot.reviewRequests.map((reviewer) => reviewer.login),
    ).toContain('mara');
    expect(await code(reviews.requestReviewers('you', pr(1839).snapshot.id, ['mara']))).toBe(
      'NOT_AUTHOR',
    );
  });
});
