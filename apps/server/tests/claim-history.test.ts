import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app.js';
import { parseAttemptId } from '@/db/claim-ids.js';
import { migrateDatabase, migrationsFolder } from '@/db/migrate.js';
import { CLAIM_RETENTION_MS } from '@/db/draft-writes.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { SyncService } from '@/sync/service.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const headers = {
  host: '127.0.0.1:4317',
  'x-review-desk': '1',
  'x-review-desk-session': 'test-session',
};

/** The demo, synced as `you`, served by the app: on a database file at `path`, if given. */
async function demo(path = ':memory:') {
  const store = new Store(path);
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();

  const app = await createApp(service, { sessionToken: 'test-session', fixture, bootId: 'boot' });

  cleanups.push(() => app.close());
  await app.ready();

  const [first, second] = service
    .listFor('you')
    .items.map((item) => service.detailFor('you', item.id)!.snapshot);
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    method === 'GET'
      ? app.inject({ method, url, headers })
      : app.inject({
          method,
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: (payload ?? {}) as never,
        });
  const pulls = (id = first!.id) => `/api/accounts/you/pulls/${id}`;
  /** A sealed id, made as the web makes one, from the checkpoint the server issues now. */
  const sealed = async () => {
    const { checkpoint, seal } = (await call('GET', '/api/accounts/you/claim-checkpoint')).json();

    return `ck1-${checkpoint}-${seal}-${randomUUID()}`;
  };
  const save = (writeId: string, id = first!.id) =>
    call('PUT', `${pulls(id)}/draft`, {
      body: 'Mine',
      writeId,
      baseRevision: 0,
      baseGeneration: 0,
    });
  const lookup = (attemptId: string, query = '', id = first!.id) =>
    call('GET', `${pulls(id)}/draft/attempts/${attemptId}${query}`);
  const abandon = (attemptId: string, kind: 'write' | 'start' = 'write', id = first!.id) =>
    call('POST', `${pulls(id)}/draft/attempts/${attemptId}/abandon`, { kind });
  /** A settled claim from long ago, then pruning: the watermark passes every checkpoint so far. */
  const pruneOld = () => {
    const id = randomUUID();

    store.draftWrites.claim({
      account: 'you',
      id,
      prId: first!.id,
      kind: 'write',
      fingerprint: 'f',
      baseRevision: 0,
      baseGeneration: 0,
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    store.draftWrites.settle('you', id, 'refused', { status: 409, body: {} });
    store.transaction(() =>
      store.draftWrites.prune(new Date(Date.now() - CLAIM_RETENTION_MS).toISOString()),
    );
  };

  return { store, first: first!, second: second!, call, sealed, save, lookup, abandon, pruneOld };
}

describe('the claim history', () => {
  it('admits a sealed id no pruning has reached, and proves a miss of one', async () => {
    const { sealed, save, lookup } = await demo();
    const kept = await sealed();
    const missing = await sealed();

    expect((await save(kept)).statusCode).toBe(200);
    expect((await lookup(kept)).json()).toMatchObject({ attempt: { state: 'committed' } });
    expect((await lookup(missing, '?base=0&generation=0')).json()).toEqual({
      arrived: false,
      fenced: true,
      provable: true,
    });
    // A bare id has no checkpoint: a miss of it proves nothing.
    expect((await lookup(randomUUID())).json()).toMatchObject({ provable: false });
  });

  it('refuses an id out of shape on every route, never as a bare id', async () => {
    const { store, sealed, save, lookup, abandon } = await demo();
    const good = await sealed();
    // Sealed by its prefix, yet not in a sealed id's parts: never read as a bare id either.
    const malformed = [good.replace(/-[0-9a-f-]{36}$/, '-not-a-uuid-at-all'), 'ck1-abcdefgh'];

    for (const id of malformed) {
      for (const answer of [await save(id), await lookup(id), await abandon(id)])
        expect([answer.statusCode, answer.json().code]).toEqual([400, 'INVALID_ATTEMPT_ID']);

      expect(store.draftWrites.find('you', id)).toBeUndefined();
    }

    // Not an attempt id at all (a write's body refuses it as well): no stop is recorded of it.
    for (const id of ['short', 'has_underscore'])
      for (const answer of [await lookup(id), await abandon(id)]) {
        expect([answer.statusCode, answer.json().code]).toEqual([400, 'INVALID_ATTEMPT_ID']);
        expect(store.draftWrites.find('you', id)).toBeUndefined();
      }
  });

  it('never admits, nor proves missing, a sealed id this process did not seal', async () => {
    const { store, sealed, save, lookup, abandon } = await demo();
    const forged = (await sealed()).replace(/-([0-9a-f]{16})-/, '-0000000000000000-');
    const refused = await save(forged);

    expect([refused.statusCode, refused.json().code]).toEqual([409, 'WRITE_HISTORY_GAP']);
    expect(store.draftWrites.find('you', forged)).toBeUndefined();
    expect((await lookup(forged)).json()).toMatchObject({ arrived: false, provable: false });
    expect((await abandon(forged)).json()).toEqual({ outcome: 'unknown' });
  });

  it('seals a checkpoint for its account alone', async () => {
    const { store, sealed } = await demo();
    const id = await sealed();
    const secret = store.draftWrites.secret();

    expect(parseAttemptId(id, 'you', secret)).toEqual({
      kind: 'sealed',
      checkpoint: store.draftWrites.checkpoint(),
    });
    expect(parseAttemptId(id, 'them', secret)).toEqual({ kind: 'foreign' });
    expect(parseAttemptId(randomUUID(), 'you', secret)).toEqual({ kind: 'bare' });
  });

  it("answers an earlier process's ids it received, and proves nothing of those it did not", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-claims-'));
    const path = join(directory, 'state.sqlite');

    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    const before = await demo(path);
    const kept = await before.sealed();
    const unsent = await before.sealed();

    expect((await before.save(kept)).statusCode).toBe(200);

    // Restarted on the same database.
    for (const cleanup of cleanups.splice(1).reverse()) await cleanup();

    const after = await demo(path);

    expect((await after.lookup(kept)).json()).toMatchObject({ attempt: { state: 'committed' } });
    expect((await after.save(kept)).statusCode).toBe(200);
    expect((await after.lookup(unsent)).json()).toMatchObject({ arrived: false, provable: false });
    expect((await after.save(unsent)).json().code).toBe('WRITE_HISTORY_GAP');
    // Sealed by this process: provable, and admitted.
    expect((await after.lookup(await after.sealed())).json()).toMatchObject({ provable: true });
  });

  it('never proves missing an id received by a database since put back from a backup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-claims-'));
    const path = join(directory, 'state.sqlite');
    const backup = join(directory, 'backup.sqlite');

    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    await demo(path);

    // Backed up, as the README says: stopped, then copied.
    for (const cleanup of cleanups.splice(1).reverse()) await cleanup();
    cpSync(path, backup);

    const running = await demo(path);
    const received = await running.sealed();
    const stopped = await running.sealed();

    // One received after the backup, one stopped after it: what the backup cannot know.
    expect((await running.save(received)).statusCode).toBe(200);
    expect((await running.abandon(stopped)).json()).toEqual({ outcome: 'not-admitted' });

    for (const cleanup of cleanups.splice(1).reverse()) await cleanup();

    // Put back, and started again: neither is known now, and neither is admitted afresh.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
    cpSync(backup, path);

    const restored = await demo(path);

    for (const id of [received, stopped]) {
      expect((await restored.lookup(id)).json()).toMatchObject({ arrived: false, provable: false });
      expect((await restored.save(id)).json().code).toBe('WRITE_HISTORY_GAP');
      expect((await restored.abandon(id)).json()).toEqual({ outcome: 'unknown' });
    }
  });

  it('never admits afresh a sealed id from before pruning reached it, while a bare id keeps its admission', async () => {
    const { store, sealed, save, lookup, pruneOld } = await demo();
    const before = await sealed();

    pruneOld();

    const refused = await save(before);

    expect([refused.statusCode, refused.json().code]).toEqual([409, 'WRITE_HISTORY_GAP']);
    expect(store.draftWrites.find('you', before)).toBeUndefined();
    expect((await lookup(before)).json()).toMatchObject({ provable: false });
    // One made after: provable again.
    expect((await lookup(await sealed())).json()).toMatchObject({ provable: true });
    expect((await save(randomUUID())).statusCode).toBe(200);
  });

  it('keeps its checkpoint past every claim being pruned', async () => {
    const { store, sealed, save } = await demo();

    await save(await sealed());

    const last = store.draftWrites.checkpoint();

    store.transaction(() => store.draftWrites.prune(new Date(Date.now() + 1000).toISOString()));

    expect(store.draftWrites.checkpoint()).toBe(last);
    expect(store.draftWrites.watermarkOf('you')).toBe(last);
  });

  it('never lowers the watermark when an older claim settles and is pruned later', async () => {
    const { store, first } = await demo();
    const claim = (id: string) =>
      store.draftWrites.claim({
        account: 'you',
        id,
        prId: first.id,
        kind: 'write',
        fingerprint: 'f',
        baseRevision: 0,
        baseGeneration: 0,
        createdAt: '2000-01-01T00:00:00.000Z',
      });
    const prune = () =>
      store.transaction(() => store.draftWrites.prune('2001-01-01T00:00:00.000Z'));

    claim('older');
    claim('newer');
    store.draftWrites.settle('you', 'newer', 'refused', { status: 409, body: {} });
    prune();

    const high = store.draftWrites.find('you', 'older')!.seq! + 1;

    expect(store.draftWrites.watermarkOf('you')).toBe(high);

    store.draftWrites.settle('you', 'older', 'refused', { status: 409, body: {} });
    prune();

    expect(store.draftWrites.find('you', 'older')).toBeUndefined();
    expect(store.draftWrites.watermarkOf('you')).toBe(high);
  });

  it('answers a found claim only for its own PR and kind', async () => {
    const { second, sealed, save, lookup } = await demo();
    const id = await sealed();

    await save(id);

    expect((await lookup(id, '', second.id)).json().code).toBe('WRITE_ID_CONFLICT');
    expect((await lookup(id, '?kind=start')).json().code).toBe('WRITE_ID_CONFLICT');
    expect((await lookup(id, '?kind=write')).json()).toMatchObject({
      attempt: { state: 'committed' },
    });
  });
});

describe('stopping an attempt', () => {
  it('stops a missing one for good: decided not admitted when provable, and refusing it after', async () => {
    const { second, sealed, save, lookup, abandon } = await demo();
    const id = await sealed();

    expect((await abandon(id)).json()).toEqual({ outcome: 'not-admitted' });

    const late = await save(id);

    expect([late.statusCode, late.json().code, late.json().decision]).toEqual([
      409,
      'WRITE_ABANDONED',
      'not-admitted',
    ]);
    expect((await lookup(id)).json()).toMatchObject({
      attempt: { state: 'refused', result: { body: { decision: 'not-admitted' } } },
    });
    expect((await abandon(id)).json()).toEqual({ outcome: 'not-admitted' });
    // Its stop is for this PR and kind only.
    expect((await abandon(id, 'start')).json().code).toBe('WRITE_ID_CONFLICT');
    expect((await save(id, second.id)).json().code).toBe('WRITE_ID_CONFLICT');
  });

  it('decides unknown when the history cannot prove it, for a bare id or one pruning reached', async () => {
    const { sealed, abandon, pruneOld } = await demo();
    const before = await sealed();

    expect((await abandon(randomUUID())).json()).toEqual({ outcome: 'unknown' });

    pruneOld();

    expect((await abandon(before)).json()).toEqual({ outcome: 'unknown' });
  });

  it('answers the state of one it finds, changing nothing', async () => {
    const { store, first, sealed, save, abandon } = await demo();
    const committed = await sealed();
    const pending = await sealed();

    await save(committed);
    store.draftWrites.claim({
      account: 'you',
      id: pending,
      prId: first.id,
      kind: 'write',
      fingerprint: 'f',
      baseRevision: 0,
      baseGeneration: 0,
      createdAt: new Date().toISOString(),
    });

    expect((await abandon(committed)).json()).toMatchObject({
      outcome: 'committed',
      attempt: { state: 'committed' },
    });
    expect((await abandon(pending)).json()).toEqual({ outcome: 'pending' });
    expect(store.draftWrites.find('you', pending)?.state).toBe('pending');
  });

  it('keeps its markers through pruning and a reset', async () => {
    const { store, sealed, abandon } = await demo();
    const id = await sealed();

    await abandon(id);
    store.transaction(() => store.draftWrites.prune(new Date(Date.now() + 1000).toISOString()));
    store.clearAccount('you');

    expect(store.draftWrites.find('you', id)?.fingerprint).toBe('abandoned');
  });
});

describe('the ledger migration', () => {
  it('numbers the claims made before it in the order they were made, and starts the ledger after them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-claims-'));
    const earlier = join(directory, 'earlier');
    const path = join(directory, 'state.sqlite');
    // The migration this covers: every one before it builds the database it upgrades.
    const covered = '20261121162042_claim_history';

    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    for (const name of readdirSync(migrationsFolder))
      if (!/^\d/.test(name) || name < covered)
        cpSync(join(migrationsFolder, name), join(earlier, name), { recursive: true });

    const before = drizzle({ client: new DatabaseSync(path) });

    migrateDatabase(before, ':memory:', earlier);

    const insert = before.$client.prepare(
      `INSERT INTO draft_writes (account, id, pr_id, kind, fingerprint, state, result, created_at)
        VALUES (?, ?, 'pr', 'write', 'f', 'committed', '{}', ?)`,
    );
    const now = Date.now();
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

    // Out of order, with two made at the same moment: those go by account, then id.
    insert.run('you', 'c', at(1));
    insert.run('you', 'b', at(5));
    insert.run('them', 'z', at(5));
    insert.run('you', 'a', at(9));
    before.$client.close();

    const store = new Store(path);

    cleanups.push(() => store.close());

    const seqs = store.db.$client
      .prepare('SELECT account, id, seq FROM draft_writes ORDER BY seq')
      .all();

    expect(seqs).toEqual([
      { account: 'you', id: 'a', seq: 1 },
      { account: 'them', id: 'z', seq: 2 },
      { account: 'you', id: 'b', seq: 3 },
      { account: 'you', id: 'c', seq: 4 },
    ]);
    expect(store.draftWrites.checkpoint()).toBe(4);
    expect(store.draftWrites.watermarkOf('you')).toBe(0);

    store.draftWrites.claim({
      account: 'you',
      id: 'd',
      prId: 'pr',
      kind: 'write',
      fingerprint: 'f',
      baseRevision: 0,
      baseGeneration: 0,
      createdAt: new Date().toISOString(),
    });

    expect(store.draftWrites.find('you', 'd')?.seq).toBe(5);
  });
});
