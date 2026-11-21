import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app.js';
import { DraftStore } from '@/db/drafts.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
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

/** The demo, synced as `you`, served by the app, with a draft on its first PR. */
async function demo() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();

  const app = await createApp(service, { sessionToken: 'test-session', fixture, bootId: 'boot' });

  cleanups.push(() => app.close());
  await app.ready();

  const pr = service
    .listFor('you')
    .items.map((item) => service.detailFor('you', item.id)!)[0].snapshot;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    method === 'GET'
      ? app.inject({ method, url, headers })
      : app.inject({
          method,
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: (payload ?? {}) as never,
        });
  const pulls = `/api/accounts/you/pulls/${pr.id}`;
  const epoch = async () => (await call('GET', '/api/accounts/you/receipt-epoch')).json().epoch;
  const abandon = async (id: string, type: 'review' | 'discard', at: number | null) =>
    call('POST', `${pulls}/commands/${id}/abandon`, { type, epoch: at });
  const submit = (operationId: string) =>
    call('POST', `${pulls}/review`, {
      operationId,
      event: 'COMMENT',
      body: 'Looks good.',
      expectedHeadOid: pr.headOid,
    });
  const discard = (operationId: string) => call('DELETE', `${pulls}/draft`, { operationId });
  const receipt = (id: string) => call('GET', `/api/accounts/you/operations/${id}/receipt`);

  new DraftStore(store).saveMeta('you', pr.id, { body: 'Mine' });

  return { store, pr, call, epoch, abandon, submit, discard, receipt };
}

describe('stopping a command', () => {
  it('decides one never received as not admitted, and refuses it after on every admission path', async () => {
    const { store, pr, epoch, abandon, submit, discard } = await demo();
    const review = randomUUID();
    const dropped = randomUUID();
    const at = await epoch();

    expect((await abandon(review, 'review', at)).json()).toEqual({ outcome: 'not-admitted' });
    expect((await abandon(dropped, 'discard', at)).json()).toEqual({ outcome: 'not-admitted' });

    const late = [await submit(review), await discard(dropped)];

    expect(late.map((answer) => [answer.statusCode, answer.json().code])).toEqual([
      [409, 'COMMAND_ABANDONED'],
      [409, 'COMMAND_ABANDONED'],
    ]);
    // Nothing was admitted, nor changed: the draft is as it was.
    expect(store.operations.find('you', review)).toBeUndefined();
    expect(store.operations.find('you', dropped)).toBeUndefined();
    expect(new DraftStore(store).draft('you', pr.id)?.body).toBe('Mine');
  });

  it('refuses a stopped id in the very turn that would admit it', async () => {
    const { store, epoch, abandon, submit, discard } = await demo();
    const review = randomUUID();
    const dropped = randomUUID();
    const at = await epoch();
    const find = store.abandoned.find.bind(store.abandoned);

    await abandon(review, 'review', at);
    await abandon(dropped, 'discard', at);

    // Each check before the admitting transaction misses it, as if it were stopped just after.
    vi.spyOn(store.abandoned, 'find').mockImplementationOnce(() => undefined);
    expect((await submit(review)).json().code).toBe('COMMAND_ABANDONED');

    vi.spyOn(store.abandoned, 'find')
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(find);
    expect((await discard(dropped)).json().code).toBe('COMMAND_ABANDONED');
    expect(store.operations.find('you', dropped)).toBeUndefined();
  });

  it('decides unknown when receipt history may have been lost since it was sent', async () => {
    const { store, epoch, abandon } = await demo();
    const at = await epoch();

    store.clearAccount('you');

    expect((await abandon(randomUUID(), 'review', at)).json()).toEqual({ outcome: 'unknown' });
    // A legacy id, sent before any epoch was read.
    expect((await abandon(randomUUID(), 'discard', null)).json()).toEqual({ outcome: 'unknown' });
  });

  it("answers an admitted command's receipt, and changes nothing about it", async () => {
    const { pr, epoch, abandon, submit } = await demo();
    const review = randomUUID();
    const at = await epoch();

    expect((await submit(review)).statusCode).toBe(202);

    const stopped = (await abandon(review, 'review', at)).json();

    expect(stopped).toMatchObject({
      outcome: 'admitted',
      receipt: { kind: 'forge', prId: pr.id, type: 'review' },
    });
    // Still the same action: a resend replays its receipt.
    expect((await submit(review)).json().operation.id).toBe(review);
    // Its id names a submit: a stop of it as a discard is for something else.
    expect((await abandon(review, 'discard', at)).json().code).toBe('OPERATION_CONFLICT');
  });

  it('answers a repeat as the first did, and refuses another PR or action under the id', async () => {
    const { store, pr, call, epoch, abandon } = await demo();
    const review = randomUUID();
    const at = await epoch();

    await abandon(review, 'review', at);
    store.clearAccount('you');

    // Decided not admitted while history was complete: so it stays, after the reset too.
    expect((await abandon(review, 'review', at)).json()).toEqual({ outcome: 'not-admitted' });
    expect((await abandon(review, 'discard', at)).json().code).toBe('OPERATION_CONFLICT');

    const other = (await call('GET', '/api/accounts/you/pulls'))
      .json()
      .items.find((item: { id: string }) => item.id !== pr.id);

    if (other)
      expect(
        (
          await call('POST', `/api/accounts/you/pulls/${other.id}/commands/${review}/abandon`, {
            type: 'review',
            epoch: at,
          })
        ).json().code,
      ).toBe('OPERATION_CONFLICT');
  });

  it("answers a stopped id's decision from the receipt route", async () => {
    const { pr, epoch, abandon, receipt } = await demo();
    const review = randomUUID();

    await abandon(review, 'review', await epoch());

    expect((await receipt(review)).json()).toEqual({
      kind: 'abandoned',
      prId: pr.id,
      type: 'review',
      decision: 'not-admitted',
    });
  });

  it('raises the epoch with each reset, and keeps stopped ids stopped across it', async () => {
    const { store, epoch, abandon, submit } = await demo();
    const review = randomUUID();

    expect(await epoch()).toBe(0);

    await abandon(review, 'review', 0);
    store.clearAccount('you');

    expect(await epoch()).toBe(1);

    expect((await submit(review)).json().code).toBe('COMMAND_ABANDONED');
  });
});
