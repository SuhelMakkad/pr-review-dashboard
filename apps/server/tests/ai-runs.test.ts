import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRunRow } from '@/db/ai-runs.js';
import { Store } from '@/db/store.js';

const cleanups: (() => unknown)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function memoryStore() {
  const store = new Store(':memory:');

  cleanups.push(() => store.close());

  return store;
}

/** The SQL statements `work` runs against the store, in order. */
function statements(store: Store, work: () => void): string[] {
  const client = store.db.$client;
  const prepare = client.prepare.bind(client);
  const seen: string[] = [];
  const spy = vi.spyOn(client, 'prepare').mockImplementation((sql: string) => {
    seen.push(sql);

    return prepare(sql);
  });

  try {
    work();
  } finally {
    spy.mockRestore();
  }

  return seen;
}

const at = '2026-11-21T10:00:00.000Z';

function run(id: string, overrides: Partial<AiRunRow> = {}) {
  return {
    id,
    account: 'you',
    prId: 'pr-1',
    task: 'full_review' as const,
    provider: 'codex' as const,
    effort: 'high' as const,
    headOid: 'a'.repeat(40),
    promptVersion: 1,
    cacheKey: `key-${id}`,
    status: 'done' as const,
    createdAt: at,
    ...overrides,
  };
}

describe('AI runs', () => {
  it('join the transaction they are called in, so a rollback takes back each write', () => {
    const store = memoryStore();

    store.aiRuns.insert(run('run-1', { status: 'running' }));

    expect(() =>
      store.transaction(() => {
        store.aiRuns.update('run-1', { status: 'done', finishedAt: at });
        store.autoReviewLog.record('you', 'pr-1:requested', 'pr-1', {
          status: 'started',
          runId: 'run-1',
          attempts: 0,
          error: null,
          headOid: null,
          restartAt: null,
          waitingSince: null,
          updatedAt: at,
        });

        throw new Error('The publication decision could not be saved.');
      }),
    ).toThrow('The publication decision could not be saved.');

    expect(store.aiRuns.get('run-1')?.status).toBe('running');
    expect(store.autoReviewLog.all('you')).toEqual([]);
  });

  it('list newest first, the later saved first among runs started at the same time', () => {
    const store = memoryStore();

    store.aiRuns.insert(run('old', { createdAt: '2026-11-20T10:00:00.000Z' }));
    store.aiRuns.insert(run('first'));
    store.aiRuns.insert(run('second'));
    store.aiRuns.insert(run('other-pr', { prId: 'pr-2' }));

    expect(store.aiRuns.forPull('you', 'pr-1').map((row) => row.id)).toEqual([
      'second',
      'first',
      'old',
    ]);
    expect(store.aiRuns.doneReviews('you', 'pr-1')[0].id).toBe('second');
  });

  it('leave an update with no changes unwritten', () => {
    const store = memoryStore();

    store.aiRuns.insert(run('run-1'));

    expect(statements(store, () => store.aiRuns.update('run-1', {}))).toEqual([]);
    expect(store.aiRuns.get('run-1')).toMatchObject({ status: 'done' });
  });
});

describe('the automatic review log', () => {
  it('primes every candidate across batches, and settles what was left from before', () => {
    const store = memoryStore();
    const entry = (status: 'failed' | 'waiting' | 'checking' | 'started') => ({
      status,
      runId: null,
      attempts: 1,
      error: null,
      headOid: 'b'.repeat(40),
      restartAt: at,
      waitingSince: null,
      updatedAt: at,
    });
    const candidates = Array.from({ length: 450 }, (_, index) => ({
      key: `pr-${index}:requested`,
      prId: `pr-${index}`,
    }));

    store.autoReviewLog.record('you', 'pr-0:requested', 'pr-0', entry('failed'));
    store.autoReviewLog.record('you', 'pr-449:requested', 'pr-449', entry('waiting'));
    store.autoReviewLog.record('you', 'old:requested', 'old', entry('checking'));
    store.autoReviewLog.record('other', 'pr-1:requested', 'pr-1', entry('failed'));

    const ran = statements(store, () =>
      store.autoReviewLog.prime('you', candidates, '2026-11-21T11:00:00.000Z'),
    ).map((sql) => sql.split(' ')[0]);

    // 200, 200 and 50: an insert and a re-priming update per batch, then the one settling update.
    expect(ran).toEqual(['insert', 'update', 'insert', 'update', 'insert', 'update', 'update']);

    const entries = new Map(store.autoReviewLog.all('you').map((row) => [row.key, row]));

    expect(entries.size).toBe(451);
    expect([...entries.values()].filter((row) => row.status === 'primed')).toHaveLength(450);
    expect(entries.get('pr-449:requested')).toMatchObject({
      status: 'primed',
      headOid: null,
      restartAt: null,
    });
    expect(entries.get('old:requested')?.status).toBe('started');
    // Another account's log is its own.
    expect(store.autoReviewLog.all('other')[0].status).toBe('failed');
  });
});
