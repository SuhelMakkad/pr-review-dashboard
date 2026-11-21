import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
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
    const seen: string[] = [];
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const service = new SyncService(store, fixture, new EventBus(), fixture);
    const app = await createApp(service, {
      sessionToken: 'test-session',
      ...(demo ? { fixture } : {}),
      onRoute: ({ method, url }) => {
        for (const one of [method].flat()) if (one !== 'HEAD') seen.push(`${one} ${url}`);
      },
    });

    await app.ready();
    await app.close();
    service.stop();
    store.close();

    return seen.filter((route) => route.includes(' /api/')).sort();
  }

  const declared = (entries: Record<string, { method: string; path: string }>) =>
    Object.values(entries).map((route) => `${route.method} ${route.path}`);

  it('serves exactly the routes it declares, without the demo controls', async () => {
    expect(await registered(false)).toEqual(declared(routes).sort());
  });

  it('adds only the demo controls in demo mode', async () => {
    expect(await registered(true)).toEqual([...declared(routes), ...declared(devRoutes)].sort());
  });
});
