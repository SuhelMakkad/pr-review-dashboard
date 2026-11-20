import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '@review-desk/shared/events';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { AccountUnavailable } from '@/forge/account.js';
import type { GitHubApi } from '@/github/api.js';
import { GitHubError } from '@/github/errors.js';
import { SELECTED_ACCOUNT_KEY, SyncService } from '@/sync/service.js';
import { snapshot } from '@test/fixtures.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

const headers = {
  host: '127.0.0.1:4317',
  'content-type': 'application/json',
  'x-review-desk': '1',
  'x-review-desk-session': 'test-session',
};

/** The demo, synced as `you`, then switched to the second account, which tracks nothing. */
async function switchedAway() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);
  const events: ServerEvent[] = [];

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();
  await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
  service.events.subscribe((stored) => void events.push(stored.event));

  const app = await createApp(service, {
    sessionToken: 'test-session',
    fixture,
    bootId: 'boot-scope',
  });

  cleanups.push(() => app.close());

  const pr = service.listFor('you').items[0];
  // Writes are JSON, as the app sends them; reads carry no body.
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const { 'content-type': type, ...plain } = headers;

    return method === 'GET'
      ? app.inject({ method, url, headers: plain })
      : app.inject({
          method,
          url,
          headers: { ...plain, 'content-type': type },
          payload: (payload ?? {}) as never,
        });
  };

  return { store, fixture, service, events, app, pr, call };
}

describe('routes that name an account', () => {
  it('serve the account in the path, whichever account is selected', async () => {
    const { service, pr, call } = await switchedAway();

    expect(service.status.account?.login).toBe(DEMO_SECOND_ACCOUNT);

    const pulls = await call('GET', '/api/accounts/you/pulls');

    expect(pulls.statusCode).toBe(200);
    expect(pulls.json()).toMatchObject({ account: 'you' });
    expect(pulls.json().items.length).toBeGreaterThan(0);
    expect((await call('GET', '/api/accounts/you/mine')).json()).toMatchObject({ account: 'you' });
    expect((await call('GET', `/api/accounts/you/pulls/${pr.id}`)).json()).toMatchObject({
      account: 'you',
      snapshot: { id: pr.id },
    });

    // The legacy routes stay with the selected account, which tracks nothing.
    expect((await call('GET', '/api/pulls')).json()).toEqual({
      account: DEMO_SECOND_ACCOUNT,
      items: [],
    });

    // An account this app never worked as is not served.
    const unknown = await call('GET', '/api/accounts/nobody/pulls');

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
  });

  it("triages and refreshes the named account's PR, read as that account", async () => {
    const { store, fixture, events, pr, call } = await switchedAway();

    const triaged = await call('PATCH', `/api/accounts/you/pulls/${pr.id}/triage`, {
      note: 'For you',
    });

    expect(triaged.statusCode).toBe(200);
    expect(store.triage('you', pr.id).note).toBe('For you');
    expect(store.triage(DEMO_SECOND_ACCOUNT, pr.id).note).toBe('');
    expect(events).toContainEqual({ type: 'triage.updated', account: 'you', id: pr.id });

    const refreshed = await call('POST', `/api/accounts/you/pulls/${pr.id}/refresh`);

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ account: 'you' });
    expect(fixture.reads.at(-1)).toEqual({ id: pr.id, account: 'you' });

    // The legacy route still refuses a write for an account that is not selected.
    const legacy = await call('PATCH', `/api/pulls/${pr.id}/triage`, {
      account: 'you',
      note: 'Late',
    });

    expect(legacy.statusCode).toBe(409);
    expect(store.triage('you', pr.id).note).toBe('For you');
  });

  it('keeps a rate limit on the account that hit it, before answering', async () => {
    const { store, fixture, service, pr, call } = await switchedAway();
    const retryAt = new Date(Date.now() + 300_000).toISOString();

    vi.spyOn(fixture, 'snapshot').mockRejectedValueOnce(
      new GitHubError('Rate limited', retryAt, 429, 'rate_limit'),
    );

    const limited = await call('POST', `/api/accounts/you/pulls/${pr.id}/refresh`);

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED', retryAt });
    expect(store.getSetting('github-write-retry:you')).toBe(retryAt);
    // The selected account's status, and the account restored on restart, are untouched.
    expect(service.status.retryAt).toBeNull();
    expect(store.getSetting('lastAccount')).toBe(DEMO_SECOND_ACCOUNT);

    // The next refresh of that account waits without asking the forge.
    const reads = fixture.reads.length;

    expect((await call('POST', `/api/accounts/you/pulls/${pr.id}/refresh`)).statusCode).toBe(429);
    expect(fixture.reads).toHaveLength(reads);
  });

  it("builds each account's diff as that account, never from another account's cache", async () => {
    const { fixture, pr, call } = await switchedAway();

    // Both accounts track the PR: the second one adds it by hand.
    const added = await call('POST', '/api/pulls/track', {
      account: DEMO_SECOND_ACCOUNT,
      repository: pr.repository,
      number: pr.number,
    });

    expect(added.statusCode).toBe(200);

    const listings = vi.spyOn(fixture, 'pullFiles');
    const second = await call('GET', `/api/accounts/${DEMO_SECOND_ACCOUNT}/pulls/${pr.id}/diff`);

    expect(second.json()).toMatchObject({ account: DEMO_SECOND_ACCOUNT });
    expect(listings).toHaveBeenCalledTimes(1);

    // The same PR and revision, cached for the second account, is read again for `you`.
    const yours = await call('GET', `/api/accounts/you/pulls/${pr.id}/diff`);

    expect(yours.json()).toMatchObject({ account: 'you' });
    expect(listings).toHaveBeenCalledTimes(2);

    // And from then on comes from `you`'s own entry.
    await call('GET', `/api/accounts/you/pulls/${pr.id}/diff`);
    expect(listings).toHaveBeenCalledTimes(2);
  });

  it('sends every status with the boot id and a revision that only grows', async () => {
    const { service, events, call } = await switchedAway();
    const first = (await call('GET', '/api/status')).json();

    expect(first).toMatchObject({ bootId: 'boot-scope', account: { login: DEMO_SECOND_ACCOUNT } });
    expect(first.revision).toEqual(expect.any(Number));

    await call('POST', '/api/sync');
    await service.sync();

    const later = (await call('GET', '/api/status')).json();
    const sent = events
      .filter((event) => event.type === 'status')
      .map((event) => (event.type === 'status' ? event.status.revision! : 0));

    expect(later.revision).toBeGreaterThan(first.revision);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).toEqual([...sent].sort((a, b) => a - b));
    expect(sent.at(-1)).toBe(later.revision);
  });
});

describe('GitLab syncs, written only between two checks of glab’s sign-in', () => {
  const ACCOUNT = 'rev@git.example.com';
  const OTHER = 'ana@git.example.com';

  /**
   * A GitLab account with `count` open MRs. `signedIn` is who glab is signed in as; `onCheck` runs
   * at each identity check (numbered from 1), and may change `signedIn` or hold the check.
   */
  function gitlabSync(count: number) {
    const store = new Store(':memory:');
    const ids = Array.from({ length: count }, (_, index) => `mr-${index + 1}`);
    const state = {
      signedIn: ACCOUNT,
      head: 'head-1',
      merged: new Set<string>(),
      checks: 0,
      onCheck: null as null | ((check: number) => Promise<void> | void),
      onSnapshot: null as null | ((id: string) => void),
    };
    const api = {
      identity: vi.fn(async () => ({ login: state.signedIn })),
      teams: vi.fn(async () => []),
      capabilities: vi.fn(async () => ({ requestChanges: true })),
      discover: vi.fn(async (_login: string, source: string) =>
        source === 'requested' ? ids : [],
      ),
      detect: vi.fn(async (list: string[]) => ({
        results: list.map((id) => ({
          id,
          state: state.merged.has(id) ? ('MERGED' as const) : ('OPEN' as const),
          fingerprint: randomUUID(),
        })),
        budget: null,
      })),
      snapshot: vi.fn(async (id: string, _login: string, sources: string[]) => {
        state.onSnapshot?.(id);

        return snapshot({
          id,
          number: Number(id.slice(3)),
          url: `https://git.example.com/team/app/-/merge_requests/${id.slice(3)}`,
          headOid: state.head,
          sources: sources as never,
        });
      }),
      verifyAccount: vi.fn(async (account: string) => {
        state.checks += 1;
        await state.onCheck?.(state.checks);

        if (state.signedIn !== account) throw new AccountUnavailable(account, state.signedIn);
      }),
    } as unknown as GitHubApi;

    store.setSetting(SELECTED_ACCOUNT_KEY, ACCOUNT);

    const service = new SyncService(store, api);

    cleanups.push(() => store.close());

    const heads = () => ids.map((id) => store.snapshot(ACCOUNT, id)?.headOid ?? null);

    return { store, service, state, ids, heads };
  }

  it('saves each batch of snapshots only after glab is still the account', async () => {
    const { service, state, heads } = gitlabSync(25);

    await service.sync();
    expect(heads()).toEqual(Array(25).fill('head-1'));

    // New commits everywhere; glab signs in as someone else while the second batch is read.
    let reads = 0;

    state.head = 'head-2';
    state.onSnapshot = () => {
      reads += 1;
      if (reads === 21) state.signedIn = OTHER;
    };
    await service.sync();

    // The first batch was checked and saved; the second, read partly as someone else, was not.
    const saved = heads();

    expect(saved.filter((head) => head === 'head-2')).toHaveLength(20);
    expect(saved.filter((head) => head === 'head-1')).toHaveLength(5);
    expect(service.status.error).toContain(`signed in as ${OTHER}`);
    expect(service.status.account?.login).toBe(ACCOUNT);
  });

  it('writes nothing from a detection during which glab changed, keeping earlier phases', async () => {
    const { store, service, state, ids } = gitlabSync(3);

    await service.sync();

    // mr-2 is reported merged, and glab signs in as someone else before detection's writes.
    state.merged.add('mr-2');
    state.onCheck = (check) => {
      // The checks of this sync: after discovery (4), after detection (5).
      if (check === 5) state.signedIn = OTHER;
    };
    await service.sync();

    expect(store.snapshot(ACCOUNT, 'mr-2')?.state).toBe('OPEN');
    // Discovery, checked before detection began, was saved.
    expect([...store.membership(ACCOUNT).keys()].sort()).toEqual(ids);
    expect(service.status.error).toContain(`signed in as ${OTHER}`);
  });

  it('never syncs as someone other than the chosen account', async () => {
    const { store, service, state } = gitlabSync(2);

    state.signedIn = OTHER;
    await service.sync();

    expect(store.snapshots(ACCOUNT)).toEqual([]);
    expect(store.snapshots(OTHER)).toEqual([]);
    expect(service.status.error).toContain(`signed in as ${OTHER}`);
  });

  it('lets a refresh that started later win over a batch held at its final check', async () => {
    const { store, service, state } = gitlabSync(1);

    await service.sync();

    // The next sync's batch is held at its final check (after discovery, detection: the 6th).
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const atCheck = new Promise<void>((resolve) => {
      reached = resolve;
    });

    state.onCheck = async (check) => {
      if (check !== 6) return;

      reached();
      await held;
    };

    const syncing = service.sync();

    await atCheck;

    // Meanwhile a refresh reads the newer head and saves it.
    state.head = 'head-newer';
    await service.refresh('mr-1', ACCOUNT);
    expect(store.snapshot(ACCOUNT, 'mr-1')?.headOid).toBe('head-newer');

    release();
    await syncing;

    // The held batch's read began before the refresh's, so it is older and is not saved.
    expect(store.snapshot(ACCOUNT, 'mr-1')?.headOid).toBe('head-newer');
  });
});
