import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@review-desk/shared/events';
import { createApp } from '@/app.js';
import { DraftStore } from '@/db/drafts.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { OperationQueue } from '@/operations/queue.js';
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
  const pr = details[0].snapshot;
  const threaded = details.find((detail) => detail.snapshot.threads.length > 0)!.snapshot;
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    method === 'GET'
      ? app.inject({ method, url, headers })
      : app.inject({
          method,
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: (payload ?? {}) as never,
        });
  const discard = (prId: string, operationId: string) =>
    call('DELETE', `/api/accounts/you/pulls/${prId}/draft`, { operationId });

  return {
    store,
    fixture,
    service,
    events,
    pr,
    threaded,
    call,
    discard,
    drafts: new DraftStore(store),
  };
}

describe('local receipts', () => {
  it('clear a draft whose cached PR cannot be read, never reading it for the receipt', async () => {
    const { store, pr, call, discard, drafts } = await demo();

    await call('PUT', `/api/accounts/you/pulls/${pr.id}/draft`, { body: 'Kept' });
    store.db.$client
      .prepare('UPDATE snapshots SET data = ? WHERE account = ? AND id = ?')
      .run('{not json', 'you', pr.id);

    const local = await discard(pr.id, randomUUID());

    expect(local.statusCode).toBe(200);
    expect(drafts.draft('you', pr.id)).toBeNull();
  });

  it('refuse a receipt’s ID for a forge request with the very same content, and the reverse', async () => {
    const { service, threaded, call, discard } = await demo();
    const queue = new OperationQueue(service, { mutationIntervalMs: 0 });
    const id = randomUUID();
    // Exactly what the discard route keys its receipt on.
    const same = {
      prId: threaded.id,
      request: { account: 'you', operationId: id },
      type: 'discard' as const,
    };

    expect((await discard(threaded.id, id)).statusCode).toBe(200);
    expect(queue.replayedLocally('you', id, same)).toBe(true);
    expect(() => queue.replay('you', id, same)).toThrow(
      expect.objectContaining({ code: 'OPERATION_CONFLICT' }),
    );
    expect(() =>
      queue.enqueue('you', threaded.id, id, { type: 'discard', reviewId: 'PRR_x' }, same.request),
    ).toThrow(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));

    // A forge operation's ID is never written locally: the write does not even run.
    const forge = randomUUID();
    const write = vi.fn(() => true);

    expect(
      (
        await call('POST', `/api/accounts/you/threads/${threaded.threads[0].id}/replies`, {
          prId: threaded.id,
          body: 'Thanks',
          operationId: forge,
        })
      ).statusCode,
    ).toBe(202);
    expect(() =>
      queue.writeLocally(
        'you',
        threaded.id,
        forge,
        { type: 'discard', reviewId: '' },
        { account: 'you', operationId: forge },
        write,
      ),
    ).toThrow(expect.objectContaining({ code: 'OPERATION_CONFLICT' }));
    expect(write).not.toHaveBeenCalled();
  });

  it('never move the timeline of visible actions', async () => {
    const { store, service, threaded } = await demo();
    const queue = new OperationQueue(service, { mutationIntervalMs: 0 });
    const later = new Date(Date.now() + 24 * 3_600_000).toISOString();

    // A receipt timed a day ahead, as a clock set back afterwards would leave it.
    store.operations.insert({
      id: 'ahead',
      account: 'you',
      prId: threaded.id,
      kind: 'local',
      repository: '',
      number: 0,
      title: '',
      prUrl: '',
      action: { type: 'discard', reviewId: '' },
      status: 'succeeded',
      progress: 'Done here; nothing was sent.',
      createdAt: later,
      updatedAt: later,
      finishedAt: later,
      retryAt: null,
      dismissedAt: null,
      error: null,
      result: null,
      steps: [],
      attempts: 0,
      requestKey: 'ahead',
    });

    const { operation } = queue.enqueue(
      'you',
      threaded.id,
      randomUUID(),
      { type: 'reply', threadId: threaded.threads[0].id, body: 'Now' },
      { body: 'Now' },
    );

    expect(Date.parse(operation.createdAt)).toBeLessThan(Date.parse(later));
  });

  it('answer a retried local discard as the first time, even after the draft is made again', async () => {
    const { pr, call, discard, drafts } = await demo();
    const id = randomUUID();

    await call('PUT', `/api/accounts/you/pulls/${pr.id}/draft`, {
      body: 'Only here',
    });

    const first = await discard(pr.id, id);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect(drafts.draft('you', pr.id)).toBeNull();

    // A new draft since, with a pending review on the forge: the retry must not touch it.
    drafts.saveMeta('you', pr.id, { body: 'Made again', githubReviewId: 'PRR_new' });

    const retried = await discard(pr.id, id);

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true });
    expect(drafts.draft('you', pr.id)).toMatchObject({
      body: 'Made again',
      githubReviewId: 'PRR_new',
    });
    // Nothing was queued for the forge either.
    expect((await call('GET', '/api/accounts/you/operations')).json().items).toEqual([]);
  });

  it('share one ID space with forge operations, refused both ways', async () => {
    const { pr, threaded, call, discard } = await demo();
    const local = randomUUID();
    const forge = randomUUID();
    const reply = (operationId: string) =>
      call('POST', `/api/accounts/you/threads/${threaded.threads[0].id}/replies`, {
        prId: threaded.id,
        body: 'Thanks',
        operationId,
      });

    expect((await discard(pr.id, local)).statusCode).toBe(200);
    expect((await reply(local)).json()).toMatchObject({ code: 'OPERATION_CONFLICT' });

    expect((await reply(forge)).statusCode).toBe(202);

    const reused = await discard(pr.id, forge);

    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it('roll the discard back when its receipt cannot be saved, and announce nothing', async () => {
    const { store, pr, call, discard, drafts, events } = await demo();

    await call('PUT', `/api/accounts/you/pulls/${pr.id}/draft`, { body: 'Kept' });
    events.length = 0;
    vi.spyOn(store.operations, 'insert').mockImplementation(() => {
      throw new Error('Disk full');
    });

    expect((await discard(pr.id, randomUUID())).statusCode).toBe(500);
    expect(drafts.draft('you', pr.id)).toMatchObject({ body: 'Kept' });
    expect(events.filter((event) => event.type === 'draft.updated')).toEqual([]);
  });

  it('stay out of every Activity endpoint, and never take a visible row’s place on a page', async () => {
    const { threaded, call, discard } = await demo();
    const sent = randomUUID();

    expect(
      (
        await call('POST', `/api/accounts/you/threads/${threaded.threads[0].id}/replies`, {
          prId: threaded.id,
          body: 'Sent first',
          operationId: sent,
        })
      ).statusCode,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect(
        (await call('GET', `/api/accounts/you/operations/${sent}`)).json().operation.status,
      ).toBe('succeeded'),
    );

    // More receipts, all newer, than a page holds.
    const receipts = Array.from({ length: 52 }, () => randomUUID());

    for (const id of receipts) expect((await discard(threaded.id, id)).statusCode).toBe(200);

    const page = (await call('GET', '/api/accounts/you/operations')).json();

    expect(page.items.map((item: { id: string }) => item.id)).toEqual([sent]);
    expect(page.nextCursor).toBeNull();
    expect((await call('GET', `/api/accounts/you/operations/${receipts[0]}`)).statusCode).toBe(404);
    expect(
      (await call('POST', `/api/accounts/you/operations/${receipts[0]}/dismiss`)).statusCode,
    ).toBe(404);
  });

  it('are cleared by the demo reset', async () => {
    const { store, pr, call, discard } = await demo();
    const id = randomUUID();

    await discard(pr.id, id);
    expect(store.operations.find('you', id)).toMatchObject({ kind: 'local' });

    expect((await call('POST', '/api/dev/reset')).statusCode).toBe(200);
    expect(store.operations.find('you', id)).toBeUndefined();
  });
});
