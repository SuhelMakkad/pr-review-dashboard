import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '@review-desk/shared/events';
import type { GitHubAction } from '@review-desk/shared/operations';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { AccountUnavailable } from '@/forge/account.js';
import { GitHubError } from '@/github/errors.js';
import { OperationQueue } from '@/operations/queue.js';
import { DraftStore } from '@/db/drafts.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/service.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

const headers = {
  host: '127.0.0.1:4317',
  'x-review-desk': '1',
  'x-review-desk-session': 'test-session',
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The demo app, synced as `you`, who stays selected until `away()` switches to the second account. */
async function demo() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);
  const events: ServerEvent[] = [];

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();
  service.events.subscribe((stored) => void events.push(stored.event));

  const app = await createApp(service, { sessionToken: 'test-session', fixture, bootId: 'boot' });

  cleanups.push(() => app.close());

  const details = service.listFor('you').items.map((item) => service.detailFor('you', item.id)!);
  const pr = details.find((detail) => detail.snapshot.files.length > 0)!.snapshot;
  const other = details.find((detail) => detail.snapshot.id !== pr.id)!.snapshot;
  const threaded = details.find((detail) => detail.snapshot.threads.length >= 2)!.snapshot;
  // Writes are JSON, as the app sends them; reads carry no body.
  const call = (method: Method, url: string, payload?: unknown) =>
    method === 'GET'
      ? app.inject({ method, url, headers })
      : app.inject({
          method,
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: (payload ?? {}) as never,
        });
  const away = async () => {
    await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
    events.length = 0;
  };
  const drafts = new DraftStore(store);
  const reviewEvents = () =>
    events.filter((event) => event.type === 'draft.updated' || event.type === 'operation.updated');

  return {
    store,
    fixture,
    service,
    events,
    app,
    pr,
    other,
    threaded,
    call,
    away,
    drafts,
    reviewEvents,
  };
}

const scoped = (path: string) => `/api/accounts/you${path}`;

describe('drafts, review actions and Activity for an account not in use', () => {
  it('are read for the account in the path, whichever account is selected', async () => {
    const { pr, call, away } = await demo();

    expect(
      (await call('PUT', scoped(`/pulls/${pr.id}/draft`), { body: 'Kept for you' })).statusCode,
    ).toBe(200);
    await away();

    const draft = await call('GET', scoped(`/pulls/${pr.id}/draft`));

    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ prId: pr.id, body: 'Kept for you' });

    const operations = await call('GET', scoped('/operations'));

    expect(operations.statusCode).toBe(200);
    expect(operations.json()).toMatchObject({ items: [] });
    expect((await call('GET', '/api/accounts/nobody/operations')).json()).toMatchObject({
      code: 'UNKNOWN_ACCOUNT',
    });
  });

  it('refuses every write, naming both accounts, and changes or queues nothing', async () => {
    const { pr, threaded, call, away, drafts, reviewEvents } = await demo();
    const added = await call('POST', scoped(`/pulls/${pr.id}/draft/comments`), {
      path: pr.files[0].path,
      line: null,
      body: 'A note on the file',
    });

    expect(added.statusCode).toBe(200);
    await call('PUT', scoped(`/pulls/${pr.id}/draft`), { body: 'Summary' });

    const cid = added.json().id as string;
    const before = drafts.draft('you', pr.id);

    await away();

    const id = () => randomUUID();
    const thread = threaded.threads[0].id;
    const writes: [Method, string, object][] = [
      ['PUT', `/pulls/${pr.id}/draft`, { body: 'Changed' }],
      [
        'POST',
        `/pulls/${pr.id}/draft/comments`,
        { path: pr.files[0].path, line: null, body: 'More' },
      ],
      ['PATCH', `/pulls/${pr.id}/draft/comments/${cid}`, { body: 'Edited' }],
      ['DELETE', `/pulls/${pr.id}/draft/comments/${cid}`, {}],
      ['DELETE', `/pulls/${pr.id}/draft`, { operationId: id() }],
      [
        'POST',
        `/pulls/${pr.id}/review`,
        { event: 'COMMENT', body: 'Done', expectedHeadOid: pr.headOid, operationId: id() },
      ],
      [
        'POST',
        `/pulls/${pr.id}/comments`,
        { path: '', line: null, body: 'Now', expectedHeadOid: pr.headOid, operationId: id() },
      ],
      [
        'POST',
        `/pulls/${pr.id}/viewed`,
        { path: pr.files[0].path, viewed: true, operationId: id() },
      ],
      ['POST', `/pulls/${pr.id}/reviewers`, { logins: ['someone'], operationId: id() }],
      ['POST', `/threads/${thread}/replies`, { prId: threaded.id, body: 'Yes', operationId: id() }],
      [
        'POST',
        `/threads/${thread}/resolution`,
        { prId: threaded.id, resolved: true, operationId: id() },
      ],
      ['POST', `/operations/${id()}/retry`, {}],
      ['POST', `/operations/${id()}/check`, {}],
      ['POST', `/operations/${id()}/reopen`, {}],
      ['POST', `/operations/${id()}/restore`, { confirm: true }],
    ];

    for (const [method, path, payload] of writes) {
      const response = await call(method, scoped(path), payload);

      expect({ path, status: response.statusCode, body: response.json() }).toMatchObject({
        path,
        status: 409,
        body: {
          code: 'ACCOUNT_NOT_ACTIVE',
          account: 'you',
          selected: DEMO_SECOND_ACCOUNT,
          error: `You're using ${DEMO_SECOND_ACCOUNT} now. Switch back to you to do this.`,
        },
      });
    }

    expect(drafts.draft('you', pr.id)).toEqual(before);
    expect((await call('GET', scoped('/operations'))).json().items).toEqual([]);
    expect(reviewEvents()).toEqual([]);
  });

  it('replays an action accepted before the account routes, selected or not, and only that action', async () => {
    const { service, pr, call, away } = await demo();
    const operationId = randomUUID();
    const viewed = { path: pr.files[0].path, viewed: true, operationId };

    // Saved as the routes that named the account in their body saved it: the account in the request.
    const first = new OperationQueue(service).enqueue(
      'you',
      pr.id,
      operationId,
      { type: 'viewed', path: viewed.path, viewed: true },
      { account: 'you', path: viewed.path, viewed: true, operationId },
    );

    const again = await call('POST', scoped(`/pulls/${pr.id}/viewed`), viewed);

    expect(again.statusCode).toBe(202);
    expect(again.json().operation.id).toBe(first.operation.id);

    await away();

    const late = await call('POST', scoped(`/pulls/${pr.id}/viewed`), viewed);

    expect(late.statusCode).toBe(202);
    expect(late.json().operation.id).toBe(operationId);
    expect((await call('GET', scoped('/operations'))).json().items).toHaveLength(1);

    const reused = await call('POST', scoped(`/pulls/${pr.id}/viewed`), {
      ...viewed,
      viewed: false,
    });

    expect(reused.json()).toMatchObject({ code: 'OPERATION_CONFLICT' });

    // The path cannot name one account and the body another.
    expect(
      (await call('POST', scoped(`/pulls/${pr.id}/viewed`), { ...viewed, account: 'you' }))
        .statusCode,
    ).toBe(400);
  });

  it('treats an ID used on one thread as another thread’s conflict', async () => {
    const { threaded, call } = await demo();
    const [first, second] = threaded.threads;
    const reply = { prId: threaded.id, body: 'Agreed', operationId: randomUUID() };

    expect((await call('POST', scoped(`/threads/${first.id}/replies`), reply)).statusCode).toBe(
      202,
    );

    const elsewhere = await call('POST', scoped(`/threads/${second.id}/replies`), reply);

    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json()).toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it('checks the account again after looking for a thread, whatever the read did', async () => {
    const { service, pr, call, reviewEvents } = await demo();
    let release: (failure?: unknown) => void = () => {};
    const refresh = vi.spyOn(service, 'refresh').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          release = (failure) => (failure ? reject(failure) : resolve(null));
        }),
    );
    const reply = (operationId = randomUUID()) =>
      call('POST', scoped('/threads/thread-not-shown/replies'), {
        prId: pr.id,
        body: 'Late',
        operationId,
      });

    const reads = () => refresh.mock.calls.length;
    const away = async (count: number, failure?: unknown) => {
      const sent = reply();

      await vi.waitFor(() => expect(reads()).toBe(count));
      await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
      release(failure);

      const answer = (await sent).json();

      await service.switchAccount(DEMO_SECOND_ACCOUNT, 'you');

      return answer;
    };

    // The account changes while the read is on its way, whether the read then succeeds or fails:
    // the account not in use is the answer, and nothing is queued.
    expect(await away(1)).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect(await away(2, new AccountUnavailable('you', 'someone-else'))).toMatchObject({
      code: 'ACCOUNT_NOT_ACTIVE',
    });

    // A read that fails answers as a failed read does: the account unavailable, or rate limited
    // until when. One that succeeds without the thread is a 404.
    const failed = reply();

    await vi.waitFor(() => expect(reads()).toBe(3));
    release(new AccountUnavailable('you', 'someone-else'));

    const unavailable = await failed;

    expect([unavailable.statusCode, unavailable.json().code]).toEqual([409, 'ACCOUNT_UNAVAILABLE']);

    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const limited = reply();

    await vi.waitFor(() => expect(reads()).toBe(4));
    release(new GitHubError('Rate limited', retryAt, 429, 'rate_limit'));

    const cooling = await limited;

    expect(cooling.statusCode).toBe(429);
    expect(cooling.json()).toMatchObject({ code: 'RATE_LIMITED', retryAt });

    const missing = reply();

    await vi.waitFor(() => expect(reads()).toBe(5));
    release();
    expect((await missing).statusCode).toBe(404);
    expect((await call('GET', scoped('/operations'))).json().items).toEqual([]);
    expect(reviewEvents()).toEqual([]);

    // The same reply is accepted elsewhere while this one's read is on its way, and the read then
    // fails: the receipt is the answer.
    const operationId = randomUUID();
    const raced = reply(operationId);

    await vi.waitFor(() => expect(reads()).toBe(6));

    const accepted = new OperationQueue(service).enqueue(
      'you',
      pr.id,
      operationId,
      { type: 'reply', threadId: 'thread-not-shown', body: 'Late' },
      { account: 'you', prId: pr.id, body: 'Late', operationId },
    );

    release(new AccountUnavailable('you', 'someone-else'));

    const answer = await raced;

    expect(answer.statusCode).toBe(202);
    expect(answer.json().operation.id).toBe(accepted.operation.id);
  });

  it('refuses a comment or thread of another PR, changing nothing', async () => {
    const { pr, other, threaded, call, drafts, events, reviewEvents } = await demo();
    const added = await call('POST', scoped(`/pulls/${pr.id}/draft/comments`), {
      path: pr.files[0].path,
      line: null,
      body: 'On this PR',
    });
    const cid = added.json().id as string;
    const before = drafts.draft('you', pr.id);

    events.length = 0;

    const edit = await call('PATCH', scoped(`/pulls/${other.id}/draft/comments/${cid}`), {
      body: 'Moved',
    });
    const removal = await call('DELETE', scoped(`/pulls/${other.id}/draft/comments/${cid}`));

    expect([edit.statusCode, removal.statusCode]).toEqual([404, 404]);
    expect(drafts.draft('you', pr.id)).toEqual(before);

    const wrong = threaded.id === pr.id ? other : pr;
    const reply = await call('POST', scoped(`/threads/${threaded.threads[0].id}/replies`), {
      prId: wrong.id,
      body: 'Wrong PR',
      operationId: randomUUID(),
    });

    expect(reply.statusCode).toBe(404);
    expect((await call('GET', scoped('/operations'))).json().items).toEqual([]);
    expect(reviewEvents()).toEqual([]);
  });

  it('checks the account again right before saving a draft comment', async () => {
    const { pr, service, call, drafts } = await demo();
    let release: (() => void) | null = null;

    vi.spyOn(
      ReviewService.prototype as unknown as { assertCommentable: () => Promise<void> },
      'assertCommentable',
    ).mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));

    const added = call('POST', scoped(`/pulls/${pr.id}/draft/comments`), {
      path: pr.files[0].path,
      line: 3,
      body: 'Held',
    });

    // The diff check is on its way when the account changes.
    await vi.waitFor(() => expect(release).not.toBeNull());
    await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
    release!();

    expect((await added).json()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect(drafts.draft('you', pr.id)).toBeNull();
  });

  it('names the account on draft events', async () => {
    const { pr, call, events } = await demo();

    await call('PUT', scoped(`/pulls/${pr.id}/draft`), { body: 'Named' });

    expect(events).toContainEqual({ type: 'draft.updated', account: 'you', id: pr.id });
  });

  it('discards a local draft at once, and queues removing a pending review, replayed after a switch', async () => {
    const { pr, other, call, away, drafts } = await demo();

    await call('PUT', scoped(`/pulls/${pr.id}/draft`), { body: 'Only here' });

    const local = await call('DELETE', scoped(`/pulls/${pr.id}/draft`), {
      operationId: randomUUID(),
    });

    expect(local.statusCode).toBe(200);
    expect(local.json()).toEqual({ ok: true });
    expect(drafts.draft('you', pr.id)).toBeNull();

    drafts.saveMeta('you', other.id, { body: 'Pending', githubReviewId: 'PRR_pending' });

    const operationId = randomUUID();
    const remote = await call('DELETE', scoped(`/pulls/${other.id}/draft`), { operationId });

    expect(remote.statusCode).toBe(202);
    expect(remote.json().operation).toMatchObject({ id: operationId, action: { type: 'discard' } });

    await away();

    const replayed = await call('DELETE', scoped(`/pulls/${other.id}/draft`), { operationId });

    expect(replayed.statusCode).toBe(202);
    expect(replayed.json().operation.id).toBe(operationId);
  });
});

describe('Activity commands for an account not in use', () => {
  /** An outbox that sends nothing until resumed, for `you`, with a second account to switch to. */
  async function outbox() {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const sync = new SyncService(store, fixture, new EventBus(), fixture);

    cleanups.push(() => store.close());
    cleanups.push(() => sync.stop());
    await sync.sync();

    const queue = new OperationQueue(sync, { mutationIntervalMs: 0, retryDelaysMs: [1, 2, 3] });

    queue.open();
    cleanups.push(() => queue.close());
    await queue.pause();

    const prs = sync.listFor('you').items.map((item) => sync.detailFor('you', item.id)!.snapshot);
    // Each on its own PR: a queued review holds its PR's draft.
    const review = (index: number, expectedHeadOid = prs[index].headOid) => {
      const action: GitHubAction = {
        type: 'review',
        review: { account: 'you', body: 'Done', event: 'COMMENT', expectedHeadOid },
        draft: { body: 'Done', event: 'COMMENT', comments: [], githubReviewId: null },
      };

      return queue.enqueue('you', prs[index].id, randomUUID(), action).operation.id;
    };

    return { sync, queue, review };
  }

  it("stops or hides another account's actions, and refuses the commands that send", async () => {
    const { sync, queue, review } = await outbox();
    const stuck = review(0, '0000000000000000000000000000000000000000');

    // One stops on its head before the switch; the other stays queued across it.
    queue.resume();
    await vi.waitFor(() => expect(queue.get('you', stuck).status).toBe('needs_attention'));
    await queue.pause();

    const waiting = review(1);

    await sync.switchAccount('you', DEMO_SECOND_ACCOUNT);

    for (const command of ['retry', 'check', 'reopen', 'restore'] as const)
      await expect(queue.control('you', stuck, command, true)).rejects.toMatchObject({
        code: 'ACCOUNT_NOT_ACTIVE',
      });

    await queue.control('you', stuck, 'dismiss');
    expect(queue.get('you', stuck).dismissedAt).not.toBeNull();

    expect(queue.get('you', waiting).status).toBe('queued');
    await queue.control('you', waiting, 'cancel');
    expect(queue.get('you', waiting).status).toBe('cancelled');
  });
});
