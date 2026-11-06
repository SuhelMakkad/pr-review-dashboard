import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../apps/server/src/app';
import { Store } from '../apps/server/src/db/store';
import { FixtureGitHub } from '../apps/server/src/demo/fixture-github';
import { defaultScenario } from '../apps/server/src/demo/scenario';
import { EventBus } from '../apps/server/src/events';
import { registerSecret } from '../apps/server/src/github/errors';
import { FixtureLinear, LinearApi, LinearService } from '../apps/server/src/linear/service';
import { SyncService } from '../apps/server/src/sync/index';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

async function demo() {
  const store = new Store(':memory:');
  const sync = new SyncService(
    store,
    new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z'))),
    new EventBus(),
  );

  cleanups.push(() => store.close());
  await sync.sync();

  return {
    store,
    sync,
    pr: (number: number) =>
      sync.detail(sync.list().items.find((item) => item.number === number)!.id)!.snapshot,
  };
}

describe('Linear context', () => {
  it('looks up the tickets a PR references and caches them', async () => {
    const { pr } = await demo();
    const source = new FixtureLinear();
    const issues = vi.spyOn(source, 'issues');
    const linear = new LinearService(source);
    const first = await linear.ticketsFor(pr(2041));

    expect(first.identifiers).toEqual(['DEMO-101']);
    expect(first.issues[0]).toMatchObject({
      identifier: 'DEMO-101',
      state: { name: 'In Progress' },
      assignee: 'Alex',
    });

    await linear.ticketsFor(pr(2041));
    expect(issues).toHaveBeenCalledTimes(1);
    expect(await linear.status()).toMatchObject({
      configured: true,
      connected: true,
      workspace: 'Acme',
      teamKeys: ['DEMO'],
    });
  });

  it('shows identifiers without fetching when Linear is not connected', async () => {
    const { pr } = await demo();
    const linear = new LinearService(new FixtureLinear(false));

    expect(await linear.ticketsFor(pr(2041))).toEqual({
      identifiers: ['DEMO-101'],
      issues: [],
      error: null,
    });
    expect((await linear.status()).setupCommand).toBe(
      'security add-generic-password -U -s review-desk.linear -a api-key -w',
    );
  });
});

describe('secrets never leave the server', () => {
  it('keeps the session token and the Linear key out of every response and event', async () => {
    const canary = 'lin_api_CANARY0123456789abcdef';
    const token = 'session-token-canary-0123456789';
    const keySource = {
      read: async () => {
        registerSecret(canary);

        return canary;
      },
    };

    // Linear echoes the credential back in its error, the worst case for leaking it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('linear.app')) {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  message: `Authentication failed for ${String((init?.headers as Record<string, string>).Authorization)}`,
                },
              ],
            }),
            {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }

        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const { sync, pr } = await demo();
    const app = await createApp(sync, {
      sessionToken: token,
      linear: new LinearApi(keySource),
      bootId: 'boot-canary',
    });

    cleanups.push(() => app.close());

    const host = { host: '127.0.0.1:4317' };
    const id = pr(2041).id;
    const paths = [
      '/api/status',
      '/api/pulls',
      '/api/mine',
      `/api/pulls/${id}`,
      `/api/pulls/${id}/diff?mode=full`,
      `/api/pulls/${id}/draft?account=you`,
      `/api/pulls/${id}/tickets`,
      `/api/pulls/${id}/ai?account=you`,
      '/api/ai',
      '/api/linear/status',
    ];
    const bodies: string[] = [];

    for (const path of paths) {
      const response = await app.inject({ method: 'GET', url: path, headers: host });

      bodies.push(
        `${path} ${response.statusCode} ${response.body} ${JSON.stringify(response.headers)}`,
      );
    }

    sync.events.emit({ type: 'status', status: sync.status });
    bodies.push(JSON.stringify(sync.events.since(0)));

    const everything = bodies.join('\n');

    expect(everything).toContain('Authentication failed for [redacted]');
    expect(everything).not.toContain(canary);
    expect(everything).not.toContain(token);
  });
});
