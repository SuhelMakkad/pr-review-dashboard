import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import { migrateDatabase, migrationsFolder } from '@/db/migrate.js';
import { Store } from '@/db/store.js';
import { snapshot } from '@test/fixtures.js';

const cleanups: (() => unknown)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function memoryStore() {
  const store = new Store(':memory:');

  cleanups.push(() => store.close());

  return store;
}

const pull = (id: string, state: PullRequestSnapshot['state']) => snapshot({ id, state });
const ids = (pulls: PullRequestSnapshot[]) => pulls.map((pr) => pr.id);

describe('open snapshots', () => {
  it('reads exactly the open rows, in the order every row is read in', () => {
    const store = memoryStore();

    // Saved out of order, across two accounts.
    for (const [id, state] of [
      ['pr-c', 'OPEN'],
      ['pr-a', 'MERGED'],
      ['pr-e', 'OPEN'],
      ['pr-b', 'OPEN'],
      ['pr-d', 'CLOSED'],
    ] as const)
      store.saveSnapshot('me', pull(id, state));

    store.saveSnapshot('other', pull('pr-0', 'OPEN'));
    store.saveSnapshot('other', pull('pr-f', 'OPEN'));
    // With statistics, SQLite may scan the table in the order rows were saved: the reads must not
    // depend on the plan it picks.
    store.db.$client.exec('ANALYZE');

    expect(ids(store.snapshots('me'))).toEqual(['pr-a', 'pr-b', 'pr-c', 'pr-d', 'pr-e']);
    expect(ids(store.openSnapshots('me'))).toEqual(['pr-b', 'pr-c', 'pr-e']);
    expect(store.openSnapshots('me')).toEqual(
      store.snapshots('me').filter((pr) => pr.state === 'OPEN'),
    );
    expect(ids(store.openSnapshots('other'))).toEqual(['pr-0', 'pr-f']);
  });

  it('follows the document when a PR closes, merges or reopens', () => {
    const store = memoryStore();

    store.saveSnapshot('me', pull('pr-1', 'OPEN'));
    store.saveSnapshot('me', pull('pr-1', 'MERGED'));
    expect(store.openSnapshots('me')).toEqual([]);

    store.saveSnapshot('me', pull('pr-1', 'OPEN'));
    expect(ids(store.openSnapshots('me'))).toEqual(['pr-1']);
  });

  it('reads through the state index, already in ID order', () => {
    const store = memoryStore();
    const plan = store.db.$client
      .prepare(
        'EXPLAIN QUERY PLAN SELECT "data" FROM "snapshots" WHERE ("snapshots"."account" = ? AND "snapshots"."state" = ?) ORDER BY "snapshots"."id" ASC',
      )
      .all('me', 'OPEN') as { detail: string }[];
    const details = plan.map((step) => step.detail).join('\n');

    expect(details).toContain('snapshots_by_state');
    // No separate sort: the index already holds each state's rows in ID order.
    expect(details).not.toContain('TEMP B-TREE');
  });

  it('migrates a database holding a malformed row, which the indexed read leaves out', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-open-'));
    const earlier = join(directory, 'earlier');
    const path = join(directory, 'state.sqlite');
    const newest = readdirSync(migrationsFolder)
      .filter((name) => /^\d/.test(name))
      .sort()
      .at(-1)!;

    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    // Every migration before this change, then rows written by that version.
    for (const name of readdirSync(migrationsFolder))
      if (name !== newest)
        cpSync(join(migrationsFolder, name), join(earlier, name), { recursive: true });

    const before = drizzle({ client: new DatabaseSync(path) });
    migrateDatabase(before, ':memory:', earlier);

    const insert = before.$client.prepare(
      'INSERT INTO snapshots (account, id, data) VALUES (?, ?, ?)',
    );

    insert.run('me', 'pr-1', JSON.stringify(pull('pr-1', 'OPEN')));
    insert.run('me', 'pr-2', JSON.stringify(pull('pr-2', 'CLOSED')));
    insert.run('me', 'pr-3', '{not json');
    before.$client.close();

    const store = new Store(path);

    cleanups.push(() => store.close());

    expect(ids(store.openSnapshots('me'))).toEqual(['pr-1']);
    // The malformed row is kept, and every other read of it decodes it as before.
    expect(store.db.$client.prepare('SELECT count(*) AS rows FROM snapshots').get()).toEqual({
      rows: 3,
    });
    expect(() => store.snapshots('me')).toThrow();
  });
});
