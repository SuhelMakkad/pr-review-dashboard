import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { devRoutes, routes } from '@review-desk/shared/contract';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { allDocuments } from '@/github/queries.js';
import { SyncService } from '@/sync/service.js';

// GitHub's published schema (https://docs.github.com/public/fpt/schema.docs.graphql).
const schema = buildSchema(
  readFileSync(new URL('../../../tests/schema/github.graphql', import.meta.url), 'utf8'),
);

describe('GitHub GraphQL contract', () => {
  it.each(Object.entries(allDocuments()))(
    '%s is valid against the GitHub schema',
    (_name, document) => {
      const errors = validate(schema, parse(document)).map((error) => error.message);

      expect(errors).toEqual([]);
    },
  );
});

describe('the HTTP contract', () => {
  /** Every route an app registers, as `METHOD path`, but Fastify's own `HEAD` copies of `GET`s. */
  async function registered(demo: boolean) {
    const seen: { route: string; handler: unknown }[] = [];
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const service = new SyncService(store, fixture, new EventBus(), fixture);
    const app = await createApp(service, {
      sessionToken: 'test-session',
      ...(demo ? { fixture } : {}),
      onRoute: ({ method, url, handler }) => {
        for (const one of [method].flat()) seen.push({ route: `${one} ${url}`, handler });
      },
    });

    await app.ready();
    await app.close();
    service.stop();
    store.close();

    return generatedHeadsLeftOut(seen);
  }

  /**
   * Fastify adds a `HEAD` for each `GET`, with that `GET`'s own handler: only those are left out.
   * A `HEAD` registered with a handler of its own is compared like any other route.
   */
  function generatedHeadsLeftOut(seen: { route: string; handler: unknown }[]) {
    const gets = new Map(
      seen
        .filter(({ route }) => route.startsWith('GET '))
        .map(({ route, handler }) => [route.slice(4), handler]),
    );

    return seen
      .filter(({ route }) => route.includes(' /api/'))
      .filter(
        ({ route, handler }) =>
          !(route.startsWith('HEAD ') && gets.get(route.slice(5)) === handler),
      )
      .map(({ route }) => route)
      .sort();
  }

  it('compares a HEAD registered with its own handler', () => {
    const get = () => undefined;
    const head = () => undefined;

    expect(
      generatedHeadsLeftOut([
        { route: 'GET /api/status', handler: get },
        { route: 'HEAD /api/status', handler: get },
        { route: 'GET /api/sync', handler: get },
        { route: 'HEAD /api/sync', handler: head },
      ]),
    ).toEqual(['GET /api/status', 'GET /api/sync', 'HEAD /api/sync']);
  });

  const declared = (entries: Record<string, { method: string; path: string }>) =>
    Object.values(entries).map((route) => `${route.method} ${route.path}`);

  it('serves exactly the routes it declares, without the demo controls', async () => {
    expect(await registered(false)).toEqual(declared(routes).sort());
  });

  it('adds only the demo controls in demo mode', async () => {
    expect(await registered(true)).toEqual([...declared(routes), ...declared(devRoutes)].sort());
  });
});

describe('queued actions on the wire', () => {
  // The order of the parsed request is the outbox fingerprint's, and must never change: an action
  // accepted before is replayed by it. The account comes first, then the fields as declared.
  const operationId = 'op-12345678';
  const oid = '0123456789abcdef';

  it.each([
    [routes.discard, { operationId }, ['account', 'operationId']],
    [
      routes.submit,
      { event: 'COMMENT', body: '', expectedHeadOid: oid, operationId },
      ['account', 'event', 'body', 'expectedHeadOid', 'operationId'],
    ],
    [
      routes.commentNow,
      { path: '', line: null, body: 'Now', operationId, expectedHeadOid: oid },
      ['account', 'path', 'line', 'body', 'operationId', 'expectedHeadOid'],
    ],
    [
      routes.viewed,
      { path: 'a.ts', viewed: true, operationId },
      ['account', 'path', 'viewed', 'operationId'],
    ],
    [routes.reviewers, { operationId, logins: ['ann'] }, ['account', 'operationId', 'logins']],
    [
      routes.reply,
      { prId: 'p1', body: 'Yes', operationId },
      ['account', 'prId', 'body', 'operationId'],
    ],
    [
      routes.resolve,
      { prId: 'p1', resolved: true, operationId },
      ['account', 'prId', 'resolved', 'operationId'],
    ],
  ] as const)('%#: keeps its fields in order', (route, body, keys) => {
    const parsed = (route.body as { canonical: z.ZodType }).canonical.parse({
      ...body,
      account: 'me',
    }) as object;

    expect(Object.keys(parsed)).toEqual(keys);
  });
});

describe('routes that take an empty body', () => {
  it('take a JSON null as empty, as they always did', async () => {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const service = new SyncService(store, fixture, new EventBus(), fixture);

    await service.sync();

    const app = await createApp(service, { sessionToken: 'test-session' });
    const send = (method: 'POST' | 'DELETE', url: string) =>
      app.inject({
        method,
        url,
        headers: {
          host: '127.0.0.1:4317',
          'content-type': 'application/json',
          'x-review-desk': '1',
          'x-review-desk-session': 'test-session',
        },
        payload: 'null',
      });

    try {
      // Each reaches its handler, which answers for what it finds.
      expect((await send('DELETE', '/api/accounts/you/pulls/none/track')).statusCode).not.toBe(400);
      expect((await send('POST', '/api/accounts/you/operations/none/dismiss')).statusCode).toBe(
        404,
      );
      expect((await send('POST', '/api/accounts/you/insights/backfill')).statusCode).toBe(202);
    } finally {
      await app.close();
      service.stop();
      store.close();
    }
  });
});
