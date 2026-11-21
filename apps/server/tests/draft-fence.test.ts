import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app.js';
import { DraftStore } from '@/db/drafts.js';
import { Store } from '@/db/store.js';
import { draftVersionsOf } from '@/db/versions.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
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

/** The demo, synced as `you`, served by the app. */
async function demo(store = new Store(':memory:')) {
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
  const call = (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    payload?: unknown,
  ) =>
    method === 'GET'
      ? app.inject({ method, url, headers })
      : app.inject({
          method,
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: (payload ?? {}) as never,
        });
  const draftUrl = `/api/accounts/you/pulls/${pr.id}/draft`;
  const save = (body: Record<string, unknown>) => call('PUT', draftUrl, body);
  const versions = () => draftVersionsOf(store, 'you', pr.id);

  return {
    store,
    fixture,
    service,
    app,
    pr,
    call,
    draftUrl,
    save,
    versions,
    drafts: new DraftStore(store),
  };
}

describe('draft versions', () => {
  it('raise the revision with every change, and the generation with each clear, lock and unlock', async () => {
    const { pr, drafts, versions } = await demo();
    const at = () => {
      const { revision, generation } = versions();

      return { revision, generation };
    };

    expect(at()).toEqual({ revision: 0, generation: 0 });

    drafts.saveMeta('you', pr.id, { body: 'A' });
    expect(at()).toEqual({ revision: 1, generation: 0 });

    const comment = drafts.addComment('you', pr.id, {
      path: 'README.md',
      line: null,
      side: 'RIGHT',
      startLine: null,
      startSide: null,
      subjectType: 'FILE',
      body: 'Note',
      origin: 'user',
      anchorOid: pr.headOid,
    });

    drafts.updateComment('you', comment.id, { body: 'Edited' });
    drafts.deleteComment('you', comment.id);
    expect(at()).toEqual({ revision: 4, generation: 0 });

    drafts.lock('you', pr.id, 'op-1');
    expect(at().generation).toBe(1);
    drafts.unlock('you', pr.id, 'op-1');
    expect(at().generation).toBe(2);
    // An unlock that releases nothing is no step.
    drafts.unlock('you', pr.id, 'op-1');
    expect(at().generation).toBe(2);

    const before = at().revision;

    drafts.clear('you', pr.id);

    // Kept across the clear, and raised by it.
    expect(at()).toEqual({ revision: before + 1, generation: 3 });
  });

  it('raise the observation with every snapshot committed, and travel with the draft', async () => {
    const { store, pr, call, draftUrl, versions } = await demo();
    const before = versions().observation;

    store.saveSnapshot('you', pr);
    expect(versions().observation).toBe(before + 1);

    const draft = (await call('GET', draftUrl)).json();

    expect(draft.versions).toEqual(versions());
  });
});

describe('the draft fence', () => {
  it('refuses a save on a draft that moved on, writing nothing, with the draft it moved to', async () => {
    const { call, draftUrl, save, versions } = await demo();

    await save({ body: 'A' });

    const { revision, generation } = versions();
    const stale = await save({ body: 'B', baseRevision: revision - 1 });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'DRAFT_REVISION_CONFLICT',
      revision,
      generation,
      draft: { body: 'A' },
    });
    expect((await call('GET', draftUrl)).json().body).toBe('A');

    const current = await save({ body: 'C', baseRevision: revision, baseGeneration: generation });

    expect(current.statusCode).toBe(200);
    expect(current.json().body).toBe('C');
  });

  it('refuses a late save made before a clear', async () => {
    const { call, draftUrl, save, versions } = await demo();

    await save({ body: 'Before' });

    const before = versions();

    expect((await call('DELETE', draftUrl, { operationId: randomUUID() })).statusCode).toBe(200);
    expect((await save({ body: 'Late', baseRevision: before.revision })).statusCode).toBe(409);
    expect((await call('GET', draftUrl)).json().body).toBe('');
  });

  it('refuses a line comment whose diff read outlives a discard', async () => {
    const { call, draftUrl, pr, versions } = await demo();
    const manifest = DiffService.prototype.manifest;
    let release = () => {};
    const reading = new Promise<void>((resolve) => (release = resolve));

    vi.spyOn(DiffService.prototype, 'manifest').mockImplementation(async function (
      this: DiffService,
      ...args: Parameters<DiffService['manifest']>
    ) {
      await reading;

      return manifest.apply(this, args);
    });

    const base = versions().revision;
    const file = pr.files[0];
    const adding = call('POST', `${draftUrl}/comments`, {
      path: file.path,
      line: 1,
      body: 'Waits on the diff',
      baseRevision: base,
    });

    // Meanwhile the draft is discarded.
    await vi.waitFor(() => expect(DiffService.prototype.manifest).toHaveBeenCalled());
    expect((await call('DELETE', draftUrl, { operationId: randomUUID() })).statusCode).toBe(200);
    release();

    const added = await adding;

    expect(added.statusCode).toBe(409);
    expect(added.json().code).toBe('DRAFT_REVISION_CONFLICT');
    expect((await call('GET', draftUrl)).json().comments).toEqual([]);
  });

  it('admits a submit only for the draft and pending review the user acted on', async () => {
    const { pr, call, drafts, save, versions } = await demo();
    const submitUrl = `/api/accounts/you/pulls/${pr.id}/review`;
    const submit = (fields: Record<string, unknown>) =>
      call('POST', submitUrl, {
        event: 'COMMENT',
        body: 'Done',
        expectedHeadOid: pr.headOid,
        operationId: randomUUID(),
        ...fields,
      });

    await save({ body: 'Draft' });

    const seen = versions().revision;

    await save({ body: 'Changed elsewhere' });

    const stale = await submit({ baseRevision: seen });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'DRAFT_REVISION_CONFLICT',
      draft: { body: 'Changed elsewhere' },
    });

    // The draft's own pending review stands over a forge that shows none: the draft says which.
    drafts.saveMeta('you', pr.id, { githubReviewId: 'R_local' });

    const none = await submit({ expectedPendingReviewId: null });

    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('PENDING_REVIEW_CHANGED');

    const read = (await call('GET', `/api/accounts/you/pulls/${pr.id}/draft`)).json();

    expect(read).toMatchObject({ githubReviewId: 'R_local', githubPendingReview: null });

    const local = await submit({
      baseRevision: read.versions.revision,
      expectedPendingReviewId: read.githubReviewId ?? read.githubPendingReview?.id ?? null,
    });

    expect(local.statusCode).toBe(202);
  });
});

describe('the claim ledger', () => {
  it('answers a retry of a committed write from its receipt, after the draft moved on', async () => {
    const { call, draftUrl, save, versions } = await demo();
    const writeId = randomUUID();
    const base = versions().revision;
    const first = await save({ body: 'Mine', writeId, baseRevision: base });

    expect(first.statusCode).toBe(200);
    expect(first.json().attempt).toEqual({ id: writeId, state: 'committed', revision: base + 1 });
    expect(first.json().body).toBe('Mine');

    await save({ body: 'Later' });

    // Its response was lost: the retry answers exactly as the commit did, with the revision it
    // made and the draft as it left it, never with the draft as it is now.
    const retry = await save({ body: 'Mine', writeId, baseRevision: base });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await call('GET', draftUrl)).json().body).toBe('Later');
  });

  it('answers a retry while its original is on its way as pending, then settles it', async () => {
    const { call, draftUrl, pr, versions } = await demo();
    const manifest = DiffService.prototype.manifest;
    let release = () => {};
    const reading = new Promise<void>((resolve) => (release = resolve));

    vi.spyOn(DiffService.prototype, 'manifest').mockImplementation(async function (
      this: DiffService,
      ...args: Parameters<DiffService['manifest']>
    ) {
      await reading;

      return manifest.apply(this, args);
    });

    const writeId = randomUUID();
    const request = {
      path: pr.files[0].path,
      line: null,
      body: 'Once',
      writeId,
      baseRevision: versions().revision,
    };
    const original = call('POST', `${draftUrl}/comments`, { ...request, line: 1 });

    await vi.waitFor(() => expect(DiffService.prototype.manifest).toHaveBeenCalled());

    const retry = await call('POST', `${draftUrl}/comments`, { ...request, line: 1 });

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ pending: true, attempt: { id: writeId, state: 'pending' } });

    release();
    expect((await original).statusCode).toBe(200);

    const lookup = (await call('GET', `${draftUrl}/attempts/${writeId}`)).json();

    expect(lookup.attempt).toMatchObject({ id: writeId, state: 'committed' });
    expect((await call('GET', draftUrl)).json().comments).toHaveLength(1);
  });

  it('never commits a claimed write an account reset interrupted while it awaited', async () => {
    const { store, call, draftUrl, pr } = await demo();
    const manifest = DiffService.prototype.manifest;
    let release = () => {};
    const reading = new Promise<void>((resolve) => (release = resolve));

    vi.spyOn(DiffService.prototype, 'manifest').mockImplementation(async function (
      this: DiffService,
      ...args: Parameters<DiffService['manifest']>
    ) {
      await reading;

      return manifest.apply(this, args);
    });

    const writeId = randomUUID();
    // No base: only its claim can stop it.
    const adding = call('POST', `${draftUrl}/comments`, {
      path: pr.files[0].path,
      line: 1,
      body: 'Across a reset',
      writeId,
    });

    await vi.waitFor(() => expect(DiffService.prototype.manifest).toHaveBeenCalled());
    // As a reset records it, the PR itself still there: only the claim stands in the way.
    store.draftWrites.interrupt({ account: 'you', prIds: [pr.id] });
    release();

    const added = await adding;

    expect(added.statusCode).toBe(409);
    expect(added.json()).toMatchObject({
      code: 'INTERRUPTED',
      attempt: { id: writeId, state: 'refused' },
    });
    expect(store.draftWrites.find('you', writeId)?.state).toBe('refused');
    expect(new DraftStore(store).comments('you', pr.id)).toEqual([]);
  });

  it('refuses a write id reused for another request, and answers a refusal as recorded', async () => {
    const { save, versions } = await demo();
    const writeId = randomUUID();

    await save({ body: 'One', writeId });
    expect((await save({ body: 'Two', writeId })).json().code).toBe('WRITE_ID_CONFLICT');

    // Refused by the fence: a retry is refused the same way, from the record.
    const refusedId = randomUUID();
    const stale = { body: 'Stale', writeId: refusedId, baseRevision: versions().revision + 5 };

    expect((await save(stale)).json()).toMatchObject({
      code: 'DRAFT_REVISION_CONFLICT',
      attempt: { id: refusedId, state: 'refused' },
    });
    expect((await save(stale)).json()).toMatchObject({
      code: 'DRAFT_REVISION_CONFLICT',
      attempt: { id: refusedId, state: 'refused' },
    });
  });

  it('says whether an attempt that never arrived could still commit at its base', async () => {
    const { call, draftUrl, save, versions } = await demo();
    const base = versions().revision;
    const lookup = async (query: string) =>
      (await call('GET', `${draftUrl}/attempts/${randomUUID()}?${query}`)).json();

    expect(await lookup(`base=${base}`)).toEqual({ arrived: false, fenced: false });
    // A base the draft has not reached yet could still be met: never fenced.
    expect(await lookup(`base=${base + 1}`)).toEqual({ arrived: false, fenced: false });

    await save({ body: 'Moved on' });

    expect(await lookup(`base=${base}`)).toEqual({ arrived: false, fenced: true });

    // A generation the draft has moved past is fenced too, its revision aside.
    expect((await call('DELETE', draftUrl, { operationId: randomUUID() })).statusCode).toBe(200);

    const now = versions();

    expect(await lookup(`base=${now.revision}&generation=${now.generation - 1}`)).toEqual({
      arrived: false,
      fenced: true,
    });
    expect(await lookup(`base=${now.revision}&generation=${now.generation}`)).toEqual({
      arrived: false,
      fenced: false,
    });
  });

  it('settles a claim its process left pending as interrupted before serving, and prunes old ones', async () => {
    const store = new Store(':memory:');
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();

    store.draftWrites.claim({
      account: 'you',
      id: 'left-pending',
      prId: 'PR_x',
      kind: 'write',
      fingerprint: 'f',
      baseRevision: 0,
      baseGeneration: 0,
      createdAt: new Date().toISOString(),
    });
    store.draftWrites.claim({
      account: 'you',
      id: 'long-settled',
      prId: 'PR_x',
      kind: 'write',
      fingerprint: 'f',
      baseRevision: 0,
      baseGeneration: 0,
      createdAt: old,
    });
    store.draftWrites.settle('you', 'long-settled', 'committed', { revision: 1, body: null });

    await demo(store);

    expect(store.draftWrites.find('you', 'left-pending')).toMatchObject({
      state: 'refused',
      result: { body: { code: 'INTERRUPTED' } },
    });
    expect(store.draftWrites.find('you', 'long-settled')).toBeUndefined();
  });

  it("fences every draft an account's reset clears, a pending first write's included", async () => {
    const { store } = await demo();

    store.draftWrites.claim({
      account: 'you',
      id: 'first-write',
      prId: 'PR_no_draft',
      kind: 'write',
      fingerprint: 'f',
      baseRevision: 0,
      baseGeneration: 0,
      createdAt: new Date().toISOString(),
    });
    store.clearAccount('you');

    expect(draftVersionsOf(store, 'you', 'PR_no_draft')).toMatchObject({
      revision: 1,
      generation: 1,
    });
    expect(store.draftWrites.find('you', 'first-write')?.state).toBe('refused');
  });
});

describe('the operation receipt', () => {
  it("answers a local discard's outcome and the draft it left, and nothing for an unknown id", async () => {
    const { call, draftUrl, save, versions } = await demo();
    const operationId = randomUUID();

    await save({ body: 'Gone soon' });
    expect((await call('DELETE', draftUrl, { operationId })).statusCode).toBe(200);

    const receipt = await call('GET', `/api/accounts/you/operations/${operationId}/receipt`);
    const { revision, generation } = versions();

    expect(receipt.json()).toEqual({
      kind: 'local',
      status: 'succeeded',
      draft: { revision, generation },
    });
    expect(
      (await call('GET', `/api/accounts/you/operations/${randomUUID()}/receipt`)).statusCode,
    ).toBe(404);
  });
});
