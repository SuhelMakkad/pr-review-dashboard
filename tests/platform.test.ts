import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { createApp } from '../server/app';
import { migrate, schemaVersion, type Migration } from '../server/db/legacy';
import { appliedMigrations, migrateDatabase, migrationsFolder } from '../server/db/migrate';
import { aiRuns } from '../server/db/schema';
import { Store } from '../server/db/store';
import { EventBus } from '../server/events';
import { parseIncludedResponse, redact, retryAtFromHeaders } from '../server/github';
import { FixtureGitHub } from '../server/demo/fixture-github';
import { defaultScenario } from '../server/demo/scenario';
import { SyncService } from '../server/sync';
import type { ServerEvent } from '../shared/events';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'review-desk-platform-'));

  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}

function demoService() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus());

  cleanups.push(() => store.close());

  return { service, fixture };
}

describe('database migrations', () => {
  const migrations = readMigrationFiles({ migrationsFolder }).map((migration) => migration.name);
  const baseline = migrations[0]!;
  const upgradeBackups = migrations.length > 1 ? [`backup-before-${migrations[1]}.sqlite`] : [];

  /** Tables, columns and indexes as SQLite reports them, ignoring Drizzle's own bookkeeping. */
  function describeSchema(db: DatabaseSync) {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
      )
      .all() as { name: string }[];

    return tables.map(({ name }) => ({
      name,
      columns: db
        .prepare(
          'SELECT name, lower(type) AS type, "notnull", dflt_value, pk FROM pragma_table_info(?)',
        )
        .all(name),
      indexes: (
        db
          .prepare('SELECT name, "unique", origin FROM pragma_index_list(?) ORDER BY name')
          .all(name) as { name: string }[]
      ).map((index) => ({
        ...index,
        columns: db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name),
      })),
    }));
  }

  function backups(directory: string) {
    return readdirSync(directory).filter((file) => file.startsWith('backup-'));
  }

  it('creates a fresh database from the Drizzle baseline', () => {
    const store = new Store(':memory:');

    cleanups.push(() => store.close());

    expect(appliedMigrations(store.db.$client)).toEqual(migrations);
    expect(store.db.select().from(aiRuns).all()).toEqual([]);
  });

  it('keeps the Drizzle baseline identical to the legacy version 5 schema', () => {
    const legacy = new DatabaseSync(':memory:');
    const baselineDb = drizzle({ client: new DatabaseSync(':memory:') });
    const folder = temporaryDirectory();

    cleanups.push(() => legacy.close());
    cleanups.push(() => baselineDb.$client.close());
    cpSync(join(migrationsFolder, baseline), join(folder, baseline), { recursive: true });
    migrateDatabase(baselineDb, ':memory:', folder);

    expect(migrate(legacy, ':memory:')).toBe(5);
    expect(describeSchema(baselineDb.$client)).toEqual(describeSchema(legacy));
  });

  it('adopts a version 5 database and backs it up once before applying later migrations', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'state.sqlite');
    const legacy = new DatabaseSync(path);

    migrate(legacy, path);
    legacy.prepare('INSERT INTO settings VALUES (?, ?)').run('lastAccount', JSON.stringify('me'));
    legacy
      .prepare('INSERT INTO triage VALUES (?, ?, ?)')
      .run('me', 'pr-1', JSON.stringify({ note: 'kept' }));
    legacy.close();

    for (let open = 0; open < 2; open += 1) {
      const store = new Store(path);

      expect(store.getSetting('lastAccount')).toBe('me');
      expect(store.triage('me', 'pr-1').note).toBe('kept');
      expect(appliedMigrations(store.db.$client)).toEqual(migrations);
      expect(schemaVersion(store.db.$client)).toBe(5);

      store.close();
    }

    expect(backups(directory)).toEqual(upgradeBackups);
  });

  it('upgrades an older database through the legacy steps, then adopts the baseline', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'state.sqlite');
    const legacy = new DatabaseSync(path);

    // A database exactly as Review Desk v1 created it.
    legacy.exec(`
      CREATE TABLE snapshots (account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (account, id));
      CREATE TABLE triage (account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (account, id));
      CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    legacy
      .prepare('INSERT INTO triage VALUES (?, ?, ?)')
      .run('me', 'pr-1', JSON.stringify({ note: 'kept' }));
    legacy.close();

    const store = new Store(path);

    cleanups.push(() => store.close());

    expect(store.triage('me', 'pr-1').note).toBe('kept');
    expect(appliedMigrations(store.db.$client)).toEqual(migrations);
    expect(schemaVersion(store.db.$client)).toBe(5);
    expect(store.db.select().from(aiRuns).all()).toEqual([]);
    expect(backups(directory).sort()).toEqual([...upgradeBackups, 'backup-v1.sqlite'].sort());
  });

  it('applies a new Drizzle migration to an adopted database, backing it up first', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'state.sqlite');
    const folder = join(directory, 'migrations');
    const legacy = new DatabaseSync(path);

    // Start from a database the bridge adopted, so Drizzle appends to the table it created.
    migrate(legacy, path);
    legacy.close();
    cpSync(migrationsFolder, folder, { recursive: true });
    new Store(path).close();

    expect(backups(directory)).toEqual(upgradeBackups);

    mkdirSync(join(folder, '29990101000000_extra'));
    writeFileSync(
      join(folder, '29990101000000_extra', 'migration.sql'),
      'CREATE TABLE `extra` (`id` text);',
    );

    const db = drizzle({ client: new DatabaseSync(path) });

    cleanups.push(() => db.$client.close());
    migrateDatabase(db, path, folder);

    expect(backups(directory).sort()).toEqual(
      [...upgradeBackups, 'backup-before-29990101000000_extra.sqlite'].sort(),
    );
    expect(appliedMigrations(db.$client)).toEqual([...migrations, '29990101000000_extra']);
    expect(db.$client.prepare('SELECT * FROM extra').all()).toEqual([]);
  });

  it('backs up an existing legacy database before upgrading and keeps its data', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'state.sqlite');
    const legacy = new DatabaseSync(path);

    legacy.exec(`
      CREATE TABLE snapshots (account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (account, id));
      CREATE TABLE triage (account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (account, id));
      CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    legacy
      .prepare('INSERT INTO triage VALUES (?, ?, ?)')
      .run('me', 'pr-1', JSON.stringify({ note: 'kept' }));

    const extra: Migration = {
      version: 2,
      name: 'test-table',
      up: (db) => db.exec('CREATE TABLE extra (id TEXT)'),
    };

    expect(migrate(legacy, path, [{ version: 1, name: 'initial', up: () => {} }, extra])).toBe(2);
    expect(readdirSync(directory)).toContain('backup-v1.sqlite');
    expect(legacy.prepare('SELECT data FROM triage').get()).toEqual({
      data: JSON.stringify({ note: 'kept' }),
    });

    legacy.close();
  });

  it('rolls back a failing legacy migration and leaves the version unchanged', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration = {
      version: 1,
      name: 'broken',
      up: (database) => {
        database.exec('CREATE TABLE half (id TEXT)');
        throw new Error('boom');
      },
    };

    expect(() => migrate(db, ':memory:', [broken])).toThrow(
      'Database migration 1 (broken) failed: boom',
    );
    expect(schemaVersion(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();

    db.close();
  });
});

describe('local security', () => {
  const host = { host: '127.0.0.1:4317' };
  const write = { ...host, 'content-type': 'application/json', 'x-review-desk': '1' };

  it('requires the per-launch session token for every write', async () => {
    const { service } = demoService();

    await service.sync();

    const app = await createApp(service, { sessionToken: 'secret-session-token' });

    cleanups.push(() => app.close());

    const payload = { account: 'you', note: 'hello' };
    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/pulls/${service.list().items[0].id}/triage`,
      headers: write,
      payload,
    });
    const wrong = await app.inject({
      method: 'PATCH',
      url: `/api/pulls/${service.list().items[0].id}/triage`,
      headers: { ...write, 'x-review-desk-session': 'secret-session-tokeX' },
      payload,
    });
    const right = await app.inject({
      method: 'PATCH',
      url: `/api/pulls/${service.list().items[0].id}/triage`,
      headers: { ...write, 'x-review-desk-session': 'secret-session-token' },
      payload,
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('SESSION_EXPIRED');
    expect(wrong.statusCode).toBe(401);
    expect(right.statusCode).toBe(200);
  });

  it('sends anti-framing and content-security headers, and never caches API responses', async () => {
    const { service } = demoService();
    const app = await createApp(service);

    cleanups.push(() => app.close());

    const response = await app.inject({ method: 'GET', url: '/api/status', headers: host });

    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('serves a templated index with session meta tags, hashes inline scripts, and canonicalises localhost', async () => {
    const webRoot = temporaryDirectory();

    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(
      join(webRoot, 'index.html'),
      '<!doctype html><html><head><script>document.documentElement.dataset.theme = "dark";</script></head><body></body></html>',
    );
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');

    const { service } = demoService();
    const app = await createApp(service, {
      webRoot,
      sessionToken: 'token-in-meta-tag',
      bootId: 'boot-1',
    });

    cleanups.push(() => app.close());

    const page = await app.inject({ method: 'GET', url: '/inbox/attention', headers: host });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<meta name="review-desk-session" content="token-in-meta-tag" />');
    expect(page.body).toContain('<meta name="review-desk-boot" content="boot-1" />');
    expect(page.headers['content-security-policy']).toMatch(
      /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/assets/app.js', headers: host })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/index.html', headers: host })).body).toContain(
      'token-in-meta-tag',
    );

    const redirect = await app.inject({
      method: 'GET',
      url: '/inbox/attention?q=1',
      headers: { host: 'localhost:4317' },
    });

    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe('http://127.0.0.1:4317/inbox/attention?q=1');
  });
});

describe('live events', () => {
  it('replays buffered events after a known id and asks for a resync when the gap is too old', () => {
    const bus = new EventBus(3);

    for (let index = 0; index < 5; index++)
      bus.emit({ type: 'pulls.changed', ids: [`pr-${index}`] });

    expect(bus.since(4)?.map((stored) => stored.id)).toEqual([5]);
    expect(bus.since(2)?.map((stored) => stored.id)).toEqual([3, 4, 5]);
    expect(bus.since(1)).toBeNull();
    expect(bus.since(5)).toEqual([]);
  });

  it('streams hello, live events and replays over SSE', async () => {
    const { service } = demoService();
    const port = 4391;
    const app = await createApp(service, { ports: [port], bootId: 'boot-sse' });

    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port });

    const read = async (headers: Record<string, string> = {}) => {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers,
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';

      const next = async (count: number) => {
        while ((text.match(/\n\n/g) ?? []).length < count) {
          const { value } = await reader.read();

          text += decoder.decode(value);
        }

        return text
          .split('\n\n')
          .filter((frame) => frame.includes('data: '))
          .map((frame) => ({
            id: /^id: (.*)$/m.exec(frame)?.[1] ?? null,
            event: JSON.parse(/^data: (.*)$/m.exec(frame)![1]) as ServerEvent,
          }));
      };

      return { response, next, close: () => controller.abort() };
    };

    const stream = await read();

    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.response.headers.get('x-frame-options')).toBe('DENY');

    const [hello] = await stream.next(2);

    expect(hello.event).toMatchObject({ type: 'hello', bootId: 'boot-sse', demo: false });

    service.events.emit({ type: 'triage.updated', id: 'pr-1' });

    const frames = await stream.next(3);
    const live = frames.at(-1)!;

    expect(live.event).toEqual({ type: 'triage.updated', id: 'pr-1' });
    expect(live.id).toMatch(/^boot-sse:\d+$/);
    stream.close();

    service.events.emit({ type: 'triage.updated', id: 'pr-2' });

    const replay = await read({ 'last-event-id': live.id! });
    const replayed = await replay.next(3);

    expect(replayed.at(-1)!.event).toEqual({ type: 'triage.updated', id: 'pr-2' });
    replay.close();

    const foreign = await read({ 'last-event-id': 'another-boot:7' });

    expect((await foreign.next(3)).at(-1)!.event).toEqual({ type: 'resync' });
    foreign.close();
  });
});

describe('GitHub transport helpers', () => {
  it('parses gh --include output, including error statuses', () => {
    const parsed = parseIncludedResponse(
      'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\nX-RateLimit-Remaining: 10\r\n\r\n{"message":"Not Found"}',
    );

    expect(parsed).toEqual({
      status: 404,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '10' },
      body: '{"message":"Not Found"}',
    });
    expect(parseIncludedResponse('gh: not logged in')).toBeNull();
  });

  it('derives retry times from Retry-After and exhausted rate-limit headers', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');

    expect(retryAtFromHeaders({ 'retry-after': '60' }, now)).toBe('2026-11-05T10:01:00.000Z');
    expect(
      retryAtFromHeaders(
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120) },
        now,
      ),
    ).toBe('2026-11-05T10:02:00.000Z');
    expect(retryAtFromHeaders({ 'x-ratelimit-remaining': '12' }, now)).toBeNull();
  });

  it('redacts tokens, credentials, private keys and the home directory', () => {
    const text = [
      'pat github_pat_11ABCDEFG_abcdef',
      'linear lin_api_abcdef123456',
      'Authorization: Bearer abcdefghijklmnop',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
      `${process.env.HOME}/code/project`,
    ].join(' | ');
    const result = redact(text);

    expect(result).not.toMatch(/github_pat_|lin_api_|abcdefghijklmnop|MIIE/);
    expect(result).toContain('Authorization: [redacted]');
    expect(result).toContain('~/code/project');
  });
});

describe('demo mode', () => {
  it('syncs the default scenario into every queue', async () => {
    const { service } = demoService();

    await service.sync();

    const queues = service.list().items.reduce<Record<string, number>>((counts, item) => {
      counts[item.queue] = (counts[item.queue] ?? 0) + 1;

      return counts;
    }, {});

    expect(service.status.account?.login).toBe('you');
    expect(queues).toEqual({ attention: 4, waiting: 1, caught_up: 2 });
  });

  it('advances the scripted scenario and surfaces the new reply', async () => {
    const { service, fixture } = demoService();

    await service.sync();

    const before = service.list().items.find((item) => item.number === 2041)!.unreadReplyKeys
      .length;

    expect(fixture.advance()).toMatch(/new reply/);
    await service.sync();

    expect(service.list().items.find((item) => item.number === 2041)!.unreadReplyKeys).toHaveLength(
      before + 1,
    );
  });
});
