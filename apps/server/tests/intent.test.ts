import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAction } from '@review-desk/shared/operations';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { GitHubError } from '@/github/errors.js';
import {
  intended,
  intentProblem,
  literal,
  matches,
  resolvedArgs,
  resultOf,
  storedSteps,
  type Intent,
  type StepIntent,
} from '@/operations/intent.js';
import type { GitHubApi } from '@/github/api.js';
import { OperationQueue } from '@/operations/queue.js';
import type { MutationStep, OperationRecord } from '@/operations/types.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/service.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

/** The demo, synced as `you`, with a paused outbox to queue actions on. */
async function setup() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const sync = new SyncService(store, github, new EventBus(), null);

  cleanups.push(() => store.close());
  await sync.sync();

  const reviews = new ReviewService(sync, github, new DiffService(github), sync.events);
  const queue = new OperationQueue(sync, { mutationIntervalMs: 0, retryDelaysMs: [1, 2, 3] });

  queue.open();
  cleanups.push(() => queue.close());
  await queue.pause();

  const pr = (number = 1839) =>
    sync.detail(sync.list().items.find((item) => item.number === number)!.id)!.snapshot;
  const review = (number = 1839, event: 'APPROVE' | 'COMMENT' = 'COMMENT') => {
    const pull = pr(number);
    const draft = reviews.drafts.draft('you', pull.id);
    const action: GitHubAction = {
      type: 'review',
      review: { account: 'you', body: 'Looks good.', event, expectedHeadOid: pull.headOid },
      draft: {
        body: 'Looks good.',
        event,
        comments: draft?.comments ?? [],
        githubReviewId: draft?.githubReviewId ?? pull.pendingReview?.id ?? null,
      },
    };

    return queue.enqueue('you', pull.id, randomUUID(), action).operation;
  };
  const enqueue = (action: GitHubAction, number = 1839) =>
    queue.enqueue('you', pr(number).id, randomUUID(), action).operation;
  const stored = (id: string) => store.operations.find('you', id)!;
  const settled = async (id: string, status: string) => {
    await expect
      .poll(() => queue.get('you', id).status, { timeout: 2500, interval: 20 })
      .toBe(status);

    return queue.get('you', id);
  };
  const comment = (body: string, number = 1839) =>
    reviews.addComment(pr(number).id, {
      account: 'you',
      path: pr(number).files[0].path,
      line: null,
      body,
    });

  return { store, github, sync, reviews, queue, pr, review, enqueue, stored, settled, comment };
}

/** The review service as its writes see it: its forge, and `write`, which declares them. */
interface Writing {
  github: GitHubApi;
  write(work: () => Promise<unknown>, writes: StepIntent[]): Promise<unknown>;
}

const writing = ReviewService.prototype as unknown as Writing;

/** The service's own `write`, to make a path declare or do something other than its own. */
const writeOf = () => writing.write;

describe('step intent', () => {
  it('declares every write of a review before the first, the new pending review by its receipt', async () => {
    const { queue, github, review, stored, settled, comment } = await setup();

    await comment('First');
    await comment('Second');

    const operation = review();

    queue.resume();
    await settled(operation.id, 'succeeded');

    const intent = stored(operation.id).intent!;

    expect(intent.version).toBe(1);
    expect(intent.steps.map((step) => step.method)).toEqual([
      'addPendingReview',
      'addReviewThread',
      'addReviewThread',
      'submitReview',
    ]);
    // Each later write names the pending review through the step that made it.
    for (const step of intent.steps.slice(1)) expect(step.args[0]).toEqual(resultOf(0));
    expect(github.writes.map((write) => write.op)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'AddReviewThread',
      'SubmitReview',
    ]);

    // Activity's answer keeps its shape: the intent is the queue's own, as the steps are.
    expect(queue.get('you', operation.id)).not.toHaveProperty('intent');
    expect(queue.get('you', operation.id)).not.toHaveProperty('steps');
  });

  it('resumes from a saved pending-review receipt, asking for no second review', async () => {
    const { queue, github, review, stored, settled, comment } = await setup();
    const add = github.addPendingReview.bind(github);

    await comment('Saved before the stop');

    let stopping: Promise<void> | null = null;

    // The process stops right after the pending review's receipt is saved.
    vi.spyOn(github, 'addPendingReview').mockImplementationOnce(async (...args) => {
      const id = await add(...args);

      stopping = queue.pause();

      return id;
    });

    const operation = review();

    queue.resume();
    await vi.waitFor(() => expect(stopping).not.toBeNull());
    await stopping;

    // Stopped with the receipt saved and nothing after it.
    expect(stored(operation.id)).toMatchObject({
      status: 'queued',
      steps: [{ method: 'addPendingReview', uncertain: false }],
    });
    expect(stored(operation.id).steps[0].completedAt).toBeTruthy();

    queue.resume();
    await settled(operation.id, 'succeeded');

    expect(github.writes.map((write) => write.op)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'SubmitReview',
    ]);
  });

  it('leaves a pending review whose answer was lost unconfirmed, sending nothing again', async () => {
    const { queue, github, review, settled, comment } = await setup();

    await comment('After a lost answer');
    github.loseResponseNext = 'AddPendingReview';

    const operation = review();

    queue.resume();

    const held = await settled(operation.id, 'needs_attention');

    expect(held.error?.code).toBe('UNCONFIRMED');
    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview']);
  });

  it('refuses a retry that declares other writes than the first attempt did', async () => {
    const { store, queue, github, review, stored, settled } = await setup();

    github.failNext = 'SubmitReview';

    const operation = review();

    queue.resume();
    await settled(operation.id, 'needs_attention');

    // As if the first attempt had declared one write fewer than the action now works out.
    const row = stored(operation.id);

    store.operations.update({
      ...row,
      intent: { ...row.intent!, steps: row.intent!.steps.slice(0, -1) },
    });
    await queue.control('you', operation.id, 'retry');

    const held = await settled(operation.id, 'needs_attention');

    // Refused as it is declared again, before the submission is sent.
    expect(held.error?.code).toBe('CHECKPOINT_CONFLICT');
    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview']);
  });

  it('refuses a write other than the one declared, before sending it', async () => {
    const { queue, github, pr, enqueue, settled } = await setup();
    const original = writeOf();

    // The path declares one reply and makes another.
    vi.spyOn(writing, 'write').mockImplementation(function (this: Writing, work, writes) {
      return original.call(
        this,
        work,
        writes.map((write) => ({ ...write, args: [write.args[0], literal('Declared otherwise')] })),
      );
    });

    const thread = pr(2041).threads[0];
    const operation = enqueue({ type: 'reply', threadId: thread.id, body: 'Sent' }, 2041);

    queue.resume();

    const held = await settled(operation.id, 'needs_attention');

    expect(held.error?.code).toBe('CHECKPOINT_CONFLICT');
    expect(github.writes).toEqual([]);
  });

  it('refuses a write past the end of the declaration, before sending it', async () => {
    const { queue, github, review, settled } = await setup();
    const original = writeOf();

    // The path leaves its submission out of what it declares.
    vi.spyOn(writing, 'write').mockImplementation(function (this: Writing, work, writes) {
      return original.call(this, work, writes.slice(0, -1));
    });

    const operation = review();

    queue.resume();

    const held = await settled(operation.id, 'needs_attention');

    expect(held.error?.code).toBe('CHECKPOINT_CONFLICT');
    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview']);
  });

  it('refuses a write that was never declared', async () => {
    const { queue, github, pr, enqueue, settled } = await setup();

    // The path writes without declaring.
    vi.spyOn(writing, 'write').mockImplementation((work: () => Promise<unknown>) => work());

    const operation = enqueue(
      { type: 'reply', threadId: pr(2041).threads[0].id, body: 'Undeclared' },
      2041,
    );

    queue.resume();

    const held = await settled(operation.id, 'needs_attention');

    expect(held.error?.code).toBe('PLAN_MISSING');
    expect(github.writes).toEqual([]);
  });

  it('keeps a review that stopped short of its declared writes, and its draft', async () => {
    const { queue, github, reviews, pr, review, settled, comment } = await setup();
    const original = writeOf();

    await comment('Kept');

    // The path declares its writes, then returns as if done, sending none.
    vi.spyOn(writing, 'write').mockImplementation(function (this: Writing, _work, writes) {
      return original.call(this, async () => ({ reviewUrl: 'x', submittedComments: 1 }), writes);
    });

    const operation = review();

    queue.resume();

    const held = await settled(operation.id, 'needs_attention');

    expect(held.error?.code).toBe('PLAN_INCOMPLETE');
    expect(github.writes).toEqual([]);
    expect(reviews.draft('you', pr().id).comments.map((draft) => draft.body)).toEqual(['Kept']);
  });

  it('holds a review whose declared writes all went out but never submitted it', async () => {
    const { queue, github, pr, review, settled } = await setup();
    const original = writeOf();
    const pull = pr();

    // The path declares and sends only a pending review, then returns as if done.
    vi.spyOn(writing, 'write').mockImplementation(function (this: {
      github: { addPendingReview: (id: string, head: string) => Promise<string> };
    }) {
      return original.call(
        this,
        async () => {
          await this.github.addPendingReview(pull.id, pull.headOid);

          return { reviewUrl: 'x', submittedComments: 0 };
        },
        [intended('addPendingReview', literal(pull.id), literal(pull.headOid))],
      );
    });

    const operation = review();

    queue.resume();

    const held = await settled(operation.id, 'needs_attention');

    // Every declared write has its receipt, but the last is not one that ends a review.
    expect(held.error?.code).toBe('PLAN_INCOMPLETE');
    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview']);
  });

  it('settles a declared resolution the thread already has, with a receipt from that state', async () => {
    const { store, queue, github, sync, pr, enqueue, stored, settled } = await setup();
    const thread = pr(2041).threads.find((candidate) => !candidate.isResolved)!;
    const identity = github.identity.bind(github);
    let id = '';
    let failed = false;

    // The account check right before sending fails once, after the intent is saved: no step yet.
    vi.spyOn(github, 'identity').mockImplementation(async () => {
      if (!failed && store.operations.find('you', id)?.intent) {
        failed = true;
        throw new GitHubError('Unavailable', null, 503, 'unavailable');
      }

      return identity();
    });

    const operation = enqueue({ type: 'resolve', threadId: thread.id, resolved: true }, 2041);

    id = operation.id;

    queue.resume();
    await settled(operation.id, 'waiting');
    expect(stored(operation.id)).toMatchObject({ steps: [], intent: { version: 1 } });

    // Someone resolves it meanwhile.
    await github.setThreadResolved(thread.id, true);
    await sync.refresh(pr(2041).id);
    github.writes.length = 0;

    await settled(operation.id, 'succeeded');

    const [step] = stored(operation.id).steps;

    expect(step).toMatchObject({ method: 'setThreadResolved', args: [thread.id, true] });
    expect(step.completedAt).toBeTruthy();
    expect(step).not.toHaveProperty('acknowledged');
    expect(github.writes).toEqual([]);
  });

  it('settles a refused resolution at its own step once the thread has it', async () => {
    const { queue, github, sync, pr, enqueue, stored, settled } = await setup();
    const thread = pr(2041).threads.find((candidate) => !candidate.isResolved)!;

    github.failNext = 'ResolveThread';

    const operation = enqueue({ type: 'resolve', threadId: thread.id, resolved: true }, 2041);

    queue.resume();
    await settled(operation.id, 'needs_attention');
    expect(stored(operation.id).steps).toMatchObject([{ completedAt: null, uncertain: false }]);

    await github.setThreadResolved(thread.id, true);
    await sync.refresh(pr(2041).id);
    github.writes.length = 0;
    await queue.control('you', operation.id, 'retry');
    await settled(operation.id, 'succeeded');

    // Receipted at the refused step's index, not after it.
    expect(stored(operation.id).steps).toHaveLength(1);
    expect(stored(operation.id).steps[0].completedAt).toBeTruthy();
    expect(github.writes).toEqual([]);
  });

  it('settles a declared discard whose pending review is already gone', async () => {
    const { queue, github, sync, pr, enqueue, stored, settled } = await setup();
    const pull = pr();
    const reviewId = await github.addPendingReview(pull.id, pull.headOid);

    await sync.refresh(pull.id);
    github.failNext = 'DeleteReview';

    const operation = enqueue({ type: 'discard', reviewId });

    queue.resume();
    await settled(operation.id, 'needs_attention');

    // Deleted elsewhere before the retry.
    await github.deleteReview(reviewId);
    await sync.refresh(pull.id);
    github.writes.length = 0;
    await queue.control('you', operation.id, 'retry');
    await settled(operation.id, 'succeeded');

    expect(stored(operation.id).steps).toMatchObject([
      { method: 'deleteReview', args: [reviewId], uncertain: false },
    ]);
    expect(github.writes).toEqual([]);
  });
});

describe('receipts that do not fit their intent', () => {
  /** A stored row for PR 2041, as a crash could have left it. */
  const crashed = (
    context: Awaited<ReturnType<typeof setup>>,
    fields: Partial<OperationRecord>,
  ): OperationRecord => {
    const pull = context.pr(2041);
    const row: OperationRecord = {
      id: randomUUID(),
      account: 'you',
      prId: pull.id,
      repository: pull.repository,
      number: pull.number,
      title: pull.title,
      prUrl: pull.url,
      action: {
        type: 'review',
        review: {
          account: 'you',
          body: 'Ship it.',
          event: 'APPROVE',
          expectedHeadOid: pull.headOid,
        },
        draft: { body: 'Ship it.', event: 'APPROVE', comments: [], githubReviewId: null },
      },
      status: 'checking',
      progress: '',
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      retryAt: null,
      dismissedAt: null,
      steps: [],
      attempts: 0,
      requestKey: randomUUID(),
      ...fields,
    };

    context.store.operations.insert(row);

    return row;
  };

  it('holds a row whose later write was sent before an unfinished one, reconciling nothing', async () => {
    const context = await setup();
    const { queue, github, sync, pr, stored, settled } = context;
    const [first, second] = pr(2041).threads.filter((thread) => !thread.isResolved);
    const now = new Date().toISOString();
    const step = (threadId: string, done: boolean): MutationStep => ({
      method: 'setThreadResolved',
      args: [threadId, true],
      startedAt: now,
      completedAt: done ? now : null,
      result: null,
      uncertain: !done,
    });

    // The first resolution's answer was lost, yet the second went out after it.
    await github.setThreadResolved(first.id, true);
    await sync.refresh(pr(2041).id);
    github.writes.length = 0;

    const row = crashed(context, {
      approvalThreadIds: [first.id, second.id],
      intent: {
        version: 1,
        steps: [
          intended('setThreadResolved', literal(first.id), literal(true)),
          intended('setThreadResolved', literal(second.id), literal(true)),
          intended('addPendingReview', literal(pr(2041).id), literal(pr(2041).headOid)),
          intended('submitReview', resultOf(2), literal('APPROVE'), literal('Ship it.')),
        ],
      },
      steps: [step(first.id, false), step(second.id, true)],
    });

    queue.resume();

    const held = await settled(row.id, 'needs_attention');

    expect(held.error?.code).toBe('CHECKPOINT_CONFLICT');
    // The lost step stays unfinished: reconciling it from the live thread would hide the order.
    expect(stored(row.id).steps[0]).toMatchObject({ uncertain: true, completedAt: null });
    expect(held.controls).not.toContain('check');
    expect(github.writes).toEqual([]);
  });

  it('takes no shortcut on a final receipt while declared writes are still to come', async () => {
    const context = await setup();
    const { queue, github, pr, stored, settled } = context;
    const pull = pr(1839);
    const reviewId = await github.addPendingReview(pull.id, pull.headOid);
    const now = new Date().toISOString();
    const done = (method: string, args: unknown[], result: unknown = null): MutationStep => ({
      method,
      args,
      startedAt: now,
      completedAt: now,
      result,
      uncertain: false,
      acknowledged: true,
    });

    github.writes.length = 0;

    // A submission receipted, with a declared write after it still to send.
    const row = crashed(context, {
      prId: pull.id,
      number: pull.number,
      status: 'queued',
      action: {
        type: 'review',
        review: { account: 'you', body: 'Ok', event: 'COMMENT', expectedHeadOid: pull.headOid },
        draft: { body: 'Ok', event: 'COMMENT', comments: [], githubReviewId: null },
      },
      intent: {
        version: 1,
        steps: [
          intended('addPendingReview', literal(pull.id), literal(pull.headOid)),
          intended('submitReview', resultOf(0), literal('COMMENT'), literal('Ok')),
          intended('replyToThread', literal('t-1'), literal('Later')),
        ],
      },
      steps: [
        done('addPendingReview', [pull.id, pull.headOid], reviewId),
        done('submitReview', [reviewId, 'COMMENT', 'Ok'], { url: pull.url }),
      ],
    });

    queue.resume();

    // Not done on its final receipt: run as declared again, the action declares otherwise.
    const held = await settled(row.id, 'needs_attention');

    expect(held.error?.code).toBe('CHECKPOINT_CONFLICT');
    expect(stored(row.id).status).toBe('needs_attention');
    expect(github.writes).toEqual([]);
  });

  it('survives a damaged step at startup, and shows the row in Activity', async () => {
    const context = await setup();
    const row = crashed(context, { status: 'running', steps: [null] as never });
    const queue = new OperationQueue(context.sync, { mutationIntervalMs: 0 });

    cleanups.push(() => queue.close());

    expect(() => queue.open()).not.toThrow();
    expect(context.store.operations.find('you', row.id)?.steps).toEqual([
      expect.objectContaining({ method: '', args: [] }),
    ]);
    expect(context.queue.get('you', row.id).controls).toEqual(expect.any(Array));
  });

  it('replays a row from before intents by position, as before', async () => {
    const context = await setup();
    const { queue, github, pr, stored, settled } = context;
    const pull = pr(1839);
    const reviewId = await github.addPendingReview(pull.id, pull.headOid);
    const now = new Date().toISOString();

    github.writes.length = 0;

    const row = crashed(context, {
      prId: pull.id,
      number: pull.number,
      status: 'queued',
      action: {
        type: 'review',
        review: { account: 'you', body: 'Old', event: 'COMMENT', expectedHeadOid: pull.headOid },
        draft: { body: 'Old', event: 'COMMENT', comments: [], githubReviewId: null },
      },
      steps: [
        {
          method: 'addPendingReview',
          args: [pull.id, pull.headOid],
          startedAt: now,
          completedAt: now,
          result: reviewId,
          uncertain: false,
          acknowledged: true,
        },
      ],
    });

    queue.resume();
    await settled(row.id, 'succeeded');

    expect(stored(row.id).intent).toBeUndefined();
    expect(github.writes.map((write) => write.op)).toEqual(['SubmitReview']);
  });
});

describe('the intent model', () => {
  const now = '2026-11-21T10:00:00.000Z';
  const done = (method: string, args: unknown[], result: unknown = null): MutationStep => ({
    method,
    args,
    startedAt: now,
    completedAt: now,
    result,
    uncertain: false,
  });
  const intent: Intent = {
    version: 1,
    steps: [
      intended('addPendingReview', literal('PR_1'), literal('head')),
      intended('submitReview', resultOf(0), literal('COMMENT'), literal('')),
    ],
  };

  it('resolves a reference from the stored result, and only once there is one', () => {
    expect(
      resolvedArgs(intent.steps[1], [done('addPendingReview', ['PR_1', 'head'], 'R_1')]),
    ).toEqual(['R_1', 'COMMENT', '']);
    expect(resolvedArgs(intent.steps[1], [])).toBeNull();
    expect(
      resolvedArgs(intent.steps[1], [
        { ...done('addPendingReview', ['PR_1', 'head']), completedAt: null, uncertain: true },
      ]),
    ).toBeNull();
  });

  it('accepts a completed prefix with one unfinished step last, and nothing else', () => {
    const pending = done('addPendingReview', ['PR_1', 'head'], 'R_1');

    expect(intentProblem(intent, [])).toBeNull();
    expect(intentProblem(intent, [pending])).toBeNull();
    expect(
      intentProblem(intent, [
        pending,
        { ...done('submitReview', ['R_1', 'COMMENT', '']), completedAt: null },
      ]),
    ).toBeNull();
    expect(
      intentProblem(intent, [
        { ...pending, completedAt: null },
        done('submitReview', ['R_1', 'COMMENT', '']),
      ]),
    ).toMatch(/unfinished/);
    expect(intentProblem(intent, [done('addPendingReview', ['PR_2', 'head'])])).toMatch(
      /not the write/,
    );
    expect(intentProblem(intent, storedSteps([null]))).toMatch(/missing/);
    expect(
      intentProblem(intent, [pending, done('submitReview', ['R_1', 'COMMENT', '']), pending]),
    ).toMatch(/more steps/);
  });

  it('keeps an undefined literal a literal once saved, matching the call it stands for', () => {
    const saved = JSON.parse(
      JSON.stringify(intended('submitReview', literal('R_1'), literal(undefined))),
    );

    expect(saved.args[1]).toEqual({ value: null });
    expect(resolvedArgs(saved, [])).toEqual(['R_1', null]);
    expect(matches(saved, 'submitReview', ['R_1', undefined], [])).toBe(true);
  });

  it('reads a damaged stored step as a placeholder at its index', () => {
    const steps = storedSteps([
      done('addPendingReview', ['PR_1', 'head']),
      null,
      { method: 'approveReview', args: null },
      { ...done('submitReview', []), uncertain: 'yes' },
    ]);

    expect(steps.map((step) => step.method)).toEqual(['addPendingReview', '', '', '']);
    expect(steps.every((step) => Array.isArray(step.args))).toBe(true);
    expect(storedSteps(undefined)).toEqual([]);
  });
});
