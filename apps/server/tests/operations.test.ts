import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { GitHubAction } from '@review-desk/shared/operations';
import { Store } from '@/db/store.js';
import { githubOperations } from '@/db/schema.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { GitHubError } from '@/github/errors.js';
import { OperationQueue } from '@/operations/queue.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/service.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(path = ':memory:', fixture?: FixtureGitHub) {
  const store = new Store(path);
  const github =
    fixture ?? new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const sync = new SyncService(store, github, new EventBus());

  cleanups.push(() => store.close());
  await sync.sync();

  const reviews = new ReviewService(sync, github, new DiffService(github), sync.events);
  const queue = new OperationQueue(sync, { mutationIntervalMs: 0, retryDelaysMs: [1, 2, 3] });
  cleanups.push(() => queue.close());
  await queue.pause();

  const pr = (number = 1839) =>
    sync.detail(sync.list().items.find((item) => item.number === number)!.id)!.snapshot;
  const submit = async (body = 'Looks good.', id = randomUUID()) => {
    const pull = pr();
    const draft = reviews.drafts.draft('you', pull.id);
    const action: GitHubAction = {
      type: 'review',
      review: { account: 'you', body, event: 'APPROVE', expectedHeadOid: pull.headOid },
      draft: {
        body,
        event: 'APPROVE',
        comments: draft?.comments ?? [],
        githubReviewId: draft?.githubReviewId ?? pull.pendingReview?.id ?? null,
      },
    };

    return queue.enqueue('you', pull.id, id, action);
  };

  return { store, github, sync, reviews, queue, pr, submit };
}

const completed = async (queue: OperationQueue, id: string, status = 'succeeded') => {
  await expect
    .poll(() => ({ status: queue.get('you', id).status, error: queue.get('you', id).error }), {
      timeout: 2500,
      interval: 20,
    })
    .toMatchObject(status === 'succeeded' ? { status, error: null } : { status });

  return queue.get('you', id);
};

describe('durable GitHub operations', () => {
  it('keeps confirmed final receipts successful even when the PR changed before recovery', async () => {
    const { queue, store, github, pr, submit } = await setup();
    const { operation } = await submit();
    const row = store.db
      .select()
      .from(githubOperations)
      .where(eq(githubOperations.id, operation.id))
      .get()!;
    const timestamp = new Date().toISOString();
    const result = { id: 'confirmed-review', url: `${pr().url}#confirmed-review` };
    store.db
      .update(githubOperations)
      .set({
        data: {
          ...row.data,
          steps: [
            {
              method: 'submitReview',
              args: ['confirmed-review', 'APPROVE', 'Looks good.'],
              startedAt: timestamp,
              completedAt: timestamp,
              result,
              uncertain: false,
            },
          ],
        },
      })
      .where(eq(githubOperations.id, operation.id))
      .run();
    github.scenario.world.pulls.find((pull) => pull.snapshot.id === pr().id)!.snapshot.headOid =
      'new-head-after-success';

    queue.resume();
    const recovered = await completed(queue, operation.id);
    expect(recovered.result?.url).toBe(result.url);
    expect(github.writes).toEqual([]);
  });

  it('keeps unsettled actions visible while paginating completed history', async () => {
    const { queue, store, pr } = await setup();

    for (let index = 0; index < 52; index++) {
      const { operation } = queue.enqueue('you', pr().id, randomUUID(), {
        type: 'viewed',
        path: `file-${index}`,
        viewed: true,
      });
      const row = store.db
        .select()
        .from(githubOperations)
        .where(eq(githubOperations.id, operation.id))
        .get()!;
      store.db
        .update(githubOperations)
        .set({ status: 'succeeded', data: { ...row.data, status: 'succeeded' } })
        .where(eq(githubOperations.id, operation.id))
        .run();
    }

    queue.enqueue('you', pr().id, randomUUID(), {
      type: 'viewed',
      path: 'still-queued',
      viewed: true,
    });
    const first = queue.list('you');
    const next = queue.list('you', first.nextCursor!);

    expect(first.items.filter((operation) => operation.status === 'succeeded')).toHaveLength(50);
    expect(first.items.filter((operation) => operation.status === 'queued')).toHaveLength(1);
    expect(next.items).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map((operation) => operation.id)).size).toBe(53);
  });

  it('stops before the next mutation if the CLI account changes during a review', async () => {
    const { queue, github, submit } = await setup();
    const write = github.addPendingReview.bind(github);
    vi.spyOn(github, 'addPendingReview').mockImplementation(async (...args) => {
      const id = await write(...args);
      vi.spyOn(github, 'identity').mockResolvedValue({ login: 'another-account' });

      return id;
    });

    const { operation } = await submit();
    queue.resume();
    const result = await completed(queue, operation.id, 'needs_attention');
    expect(result.error?.code).toBe('ACCOUNT_CHANGED');
    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview']);
  });

  it('labels replies attached to a GitHub pending review as pending rather than posted', async () => {
    const { queue, github, sync, pr } = await setup();
    const pull = pr(2041);
    await github.addPendingReview(pull.id, pull.headOid);
    await sync.refresh(pull.id);

    const { operation } = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'reply',
      threadId: pull.threads[0].id,
      body: 'Still pending on GitHub',
    });
    queue.resume();
    const result = await completed(queue, operation.id);

    expect(result.result?.pending).toBe(true);
    expect(result.progress).toContain('pending review');
    expect(
      github.scenario.world.pulls
        .find((candidate) => candidate.snapshot.id === pull.id)
        ?.snapshot.threads[0].comments.some(
          (comment) => comment.body === 'Still pending on GitHub',
        ),
    ).toBe(false);
  });

  it('cleans up a partial pending review and restores its exact local draft after confirmation', async () => {
    const { queue, github, reviews, pr, submit } = await setup();
    const pull = pr();
    await reviews.addComment(pull.id, {
      account: 'you',
      path: pull.files[0].path,
      line: null,
      body: 'Preserved file comment',
    });
    github.failNext = 'SubmitReview';
    const { operation } = await submit('Preserved summary');
    queue.resume();
    await completed(queue, operation.id, 'needs_attention');

    const restored = await queue.control('you', operation.id, 'restore');
    await completed(queue, restored.operation.id);
    expect(reviews.draft('you', pull.id)).toMatchObject({
      body: 'Preserved summary',
      activeOperationId: null,
      comments: [{ body: 'Preserved file comment', status: 'draft' }],
    });
    expect(queue.get('you', restored.operation.id).savedPendingReview?.comments[0].body).toBe(
      'Preserved file comment',
    );
    expect(github.writes.map((write) => write.op)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'DeleteReview',
    ]);
  });

  it('offers verified pending-review cleanup after an accepted comment loses its response', async () => {
    const { queue, github, reviews, pr, submit } = await setup();
    await reviews.addComment(pr().id, {
      account: 'you',
      path: pr().files[0].path,
      line: null,
      body: 'Recover this uncertain comment',
    });
    github.loseResponseNext = 'AddReviewThread';
    const { operation } = await submit();
    queue.resume();
    const uncertain = await completed(queue, operation.id, 'needs_attention');
    expect(uncertain.error?.code).toBe('UNCONFIRMED');
    expect(uncertain.controls).not.toContain('retry');
    expect(uncertain.controls).toContain('restore');

    const cleanup = await queue.control('you', operation.id, 'restore');
    await completed(queue, cleanup.operation.id);
    expect(reviews.draft('you', pr().id).comments[0]).toMatchObject({
      body: 'Recover this uncertain comment',
      status: 'draft',
    });
    expect(github.writes.map((write) => write.op)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'DeleteReview',
    ]);
  });
  it('saves input and locks the draft before any GitHub mutation, including direct AI draft writes', async () => {
    const { reviews, queue, github, pr, submit } = await setup();
    const pull = pr();
    await reviews.addComment(pull.id, {
      account: 'you',
      path: pull.files[0].path,
      line: 2,
      body: 'Original feedback',
    });

    const receipt = await submit();
    expect(receipt.operation.status).toBe('queued');
    expect(github.writes).toEqual([]);
    expect(reviews.draft('you', pull.id).activeOperationId).toBe(receipt.operation.id);
    expect(() => reviews.drafts.saveMeta('you', pull.id, { body: 'AI replacement' })).toThrow(
      'saved in Activity',
    );
    await expect(
      reviews.addComment(pull.id, {
        account: 'you',
        path: pull.files[0].path,
        line: 3,
        body: 'Later feedback',
      }),
    ).rejects.toThrow('saved in Activity');

    queue.resume();
    await completed(queue, receipt.operation.id);
    expect(github.writes.find((write) => write.op === 'AddReviewThread')?.details.body).toBe(
      'Original feedback',
    );
    expect(reviews.draft('you', pull.id).activeOperationId).toBeNull();
  });

  it('returns the same operation for an identical ID and rejects conflicting reuse or a second submission', async () => {
    const { queue, pr, submit } = await setup();
    const id = randomUUID();
    const first = await submit('Original', id);

    expect((await submit('Original', id)).operation.id).toBe(first.operation.id);
    await expect(submit('Different', id)).rejects.toThrow('different content');
    await expect(submit('Second operation')).rejects.toThrow('saved in Activity');
    expect(queue.list('you').items).toHaveLength(1);
    expect(() => queue.get('another-account', id)).toThrow('account changed');
    expect(pr().id).toBeTruthy();
  });

  it('cancels during preflight without sending or overwriting edits made after cancellation', async () => {
    const { reviews, queue, github, pr, submit } = await setup();
    const receipt = await submit();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identity = github.identity.bind(github);
    vi.spyOn(github, 'identity').mockImplementation(async () => {
      await gate;
      return identity();
    });

    queue.resume();
    await completed(queue, receipt.operation.id, 'running');
    await queue.control('you', receipt.operation.id, 'cancel');
    await reviews.saveDraft('you', pr().id, { body: 'New unsent edits' });
    release();
    await queue.pause();

    expect(github.writes).toEqual([]);
    expect(reviews.draft('you', pr().id).body).toBe('New unsent edits');
    expect(queue.get('you', receipt.operation.id).status).toBe('cancelled');
  });

  it('resumes only remaining review steps after a known rejection', async () => {
    const { reviews, queue, github, pr, submit } = await setup();
    const pull = pr();
    for (const [index, body] of ['One', 'Two'].entries()) {
      await reviews.addComment(pull.id, {
        account: 'you',
        path: pull.files[0].path,
        line: index + 2,
        body,
      });
    }

    const write = github.addReviewThread.bind(github);
    let reject = true;
    vi.spyOn(github, 'addReviewThread').mockImplementation(async (id, comment) => {
      if (comment.body === 'Two' && reject) {
        reject = false;
        throw new GitHubError('Invalid comment', null, 422, 'rejected');
      }
      return write(id, comment);
    });

    const { operation } = await submit();
    queue.resume();
    await completed(queue, operation.id, 'needs_attention');
    await queue.control('you', operation.id, 'retry');
    await completed(queue, operation.id);

    expect(github.writes.map((write) => write.op)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'AddReviewThread',
      'SubmitReview',
    ]);
  });

  it('reconciles an accepted submission with a lost response without posting it again', async () => {
    const { queue, github, submit } = await setup();
    const write = github.submitReview.bind(github);
    vi.spyOn(github, 'submitReview').mockImplementation(async (...args) => {
      await write(...args);
      throw new GitHubError('Connection lost after GitHub accepted the review');
    });

    const { operation } = await submit();
    queue.resume();
    await completed(queue, operation.id);

    expect(github.writes.filter((write) => write.op === 'SubmitReview')).toHaveLength(1);
    expect(queue.get('you', operation.id).result?.url).toContain('pullrequestreview');
  });

  it('keeps uncertain replies unconfirmed and never blindly retries them', async () => {
    const { queue, github, pr } = await setup();
    const pull = pr(2041);
    const write = github.replyToThread.bind(github);
    vi.spyOn(github, 'replyToThread').mockImplementation(async (...args) => {
      await write(...args);
      throw new GitHubError('Response lost');
    });

    const { operation } = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'reply',
      threadId: pull.threads[0].id,
      body: 'Exactly one reply',
    });
    queue.resume();
    const failed = await completed(queue, operation.id, 'needs_attention');

    expect(failed.error?.code).toBe('UNCONFIRMED');
    expect(failed.controls).not.toContain('retry');
    await queue.control('you', operation.id, 'check');
    await completed(queue, operation.id, 'needs_attention');
    expect(github.writes.filter((write) => write.op === 'ReplyToThread')).toHaveLength(1);
    await expect(queue.control('you', operation.id, 'reopen')).rejects.toThrow('confirm');
    await queue.control('you', operation.id, 'reopen', true);
  });

  it('pauses for new commits and preserves the draft until explicit recovery', async () => {
    const { queue, github, reviews, pr, submit } = await setup();
    const { operation } = await submit();
    github.scenario.world.pulls.find((pull) => pull.snapshot.id === pr().id)!.snapshot.headOid =
      'changed-head-oid';
    queue.resume();
    const paused = await completed(queue, operation.id, 'needs_attention');

    expect(paused.error?.code).toBe('HEAD_MOVED');
    expect(github.writes).toEqual([]);
    expect(paused.controls).not.toContain('retry');
    await queue.control('you', operation.id, 'reopen');
    expect(reviews.draft('you', pr().id).body).toBe('Looks good.');
    expect(reviews.draft('you', pr().id).activeOperationId).toBeNull();
  });

  it('blocks dependent work on one PR while allowing another PR to proceed', async () => {
    const { queue, github, pr } = await setup();
    const pull = pr(2041);
    github.failNext = 'ReplyToThread';
    const failed = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'reply',
      threadId: pull.threads[0].id,
      body: 'Rejected reply',
    });
    const dependent = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'resolve',
      threadId: pull.threads[0].id,
      resolved: true,
    });
    const independent = queue.enqueue('you', pr().id, randomUUID(), {
      type: 'comment',
      expectedHeadOid: pr().headOid,
      comment: { account: 'you', path: '', line: null, body: 'Independent comment' },
    });

    queue.resume();
    await completed(queue, failed.operation.id, 'needs_attention');
    await completed(queue, independent.operation.id);
    expect(queue.get('you', dependent.operation.id).status).toBe('queued');
    expect(github.writes.map((write) => write.op)).toEqual(['AddComment']);
  });

  it('coalesces unsent viewed updates without coalescing content actions', async () => {
    const { queue, github, pr } = await setup();
    const pull = pr();
    const first = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'viewed',
      path: pull.files[0].path,
      viewed: true,
    });
    const second = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'viewed',
      path: pull.files[0].path,
      viewed: false,
    });

    expect(queue.get('you', first.operation.id).status).toBe('cancelled');
    queue.resume();
    await completed(queue, second.operation.id);
    expect(github.writes.map((write) => write.op)).toEqual(['UnmarkFileViewed']);
  });

  it('limits automatic retries to three and retains exhausted actions', async () => {
    const { queue, github, pr } = await setup();
    const identity = vi
      .spyOn(github, 'identity')
      .mockRejectedValue(new GitHubError('Connection refused during the account check'));
    const { operation } = queue.enqueue('you', pr().id, randomUUID(), {
      type: 'viewed',
      path: pr().files[0].path,
      viewed: true,
    });

    queue.resume();
    await completed(queue, operation.id, 'needs_attention');
    expect(identity).toHaveBeenCalledTimes(4);
    expect(github.writes).toEqual([]);
  });

  it('honors rate-limit timing before sending another action', async () => {
    const { queue, github, sync, pr } = await setup();
    const identity = github.identity.bind(github);
    const retryAt = new Date(Date.now() + 350).toISOString();
    const probe = vi
      .spyOn(github, 'identity')
      .mockRejectedValueOnce(new GitHubError('Rate limited', retryAt, 429, 'rate_limit'))
      .mockImplementation(identity);
    const { operation } = queue.enqueue('you', pr().id, randomUUID(), {
      type: 'viewed',
      path: pr().files[0].path,
      viewed: true,
    });

    queue.resume();
    await completed(queue, operation.id, 'waiting');
    expect(queue.get('you', operation.id).retryAt).toBe(retryAt);
    await sync.sync();
    await expect(sync.refresh(pr().id)).rejects.toThrow('rate limited');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(github.writes).toEqual([]);
    await completed(queue, operation.id);
  });

  it('does not downgrade a confirmed write when the subsequent cache refresh fails', async () => {
    const { queue, github, sync, pr } = await setup();
    const refresh = sync.refresh.bind(sync);
    let calls = 0;
    vi.spyOn(sync, 'refresh').mockImplementation(async (...args) => {
      if (++calls > 1) throw new Error('Refresh unavailable');
      return refresh(...args);
    });
    const { operation } = queue.enqueue('you', pr().id, randomUUID(), {
      type: 'viewed',
      path: pr().files[0].path,
      viewed: true,
    });

    queue.resume();
    await completed(queue, operation.id);
    expect(github.writes).toHaveLength(1);
  });

  it('resumes saved queued work after reopening an on-disk database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-operations-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.sqlite');
    const first = await setup(path);
    const { operation } = await first.submit();
    await first.queue.close();

    const second = await setup(path, first.github);
    second.queue.resume();
    await completed(second.queue, operation.id);
    expect(first.github.writes.filter((write) => write.op === 'SubmitReview')).toHaveLength(1);
  });

  it('checks persisted interrupted mutations instead of repeating them after restart', async () => {
    const { queue, sync, github, store, pr } = await setup();
    const pull = pr(2041);
    const { operation } = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'reply',
      threadId: pull.threads[0].id,
      body: 'Interrupted',
    });
    const row = store.db
      .select()
      .from(githubOperations)
      .where(eq(githubOperations.id, operation.id))
      .get()!;
    store.db
      .update(githubOperations)
      .set({
        status: 'running',
        data: {
          ...row.data,
          status: 'running',
          steps: [
            {
              method: 'replyToThread',
              args: [pull.threads[0].id, 'Interrupted'],
              startedAt: new Date().toISOString(),
              completedAt: null,
              result: null,
              uncertain: true,
            },
          ],
        },
      })
      .where(eq(githubOperations.id, operation.id))
      .run();
    await queue.close();

    const restarted = new OperationQueue(sync, { mutationIntervalMs: 0 });
    cleanups.push(() => restarted.close());
    await completed(restarted, operation.id, 'needs_attention');
    expect(github.writes).toEqual([]);
  });
});
