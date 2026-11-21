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
import { DiffService } from '@/diff/service.js';
import { SyncService } from '@/sync/service.js';
import { snapshot } from '@test/fixtures.js';
import { LAST_ACCOUNT, SELECTED_ACCOUNT, STATUS, WRITE_COOLDOWN } from '@/db/settings.js';

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

    // The selected account tracks nothing, and is served for itself.
    expect((await call('GET', `/api/accounts/${DEMO_SECOND_ACCOUNT}/pulls`)).json()).toEqual({
      account: DEMO_SECOND_ACCOUNT,
      items: [],
    });

    // The routes that named no account are gone.
    expect((await call('GET', '/api/pulls')).statusCode).toBe(404);

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

    // A body that names an account as well as the path is refused, changing nothing.
    const named = await call('PATCH', `/api/accounts/you/pulls/${pr.id}/triage`, {
      account: 'you',
      note: 'Late',
    });

    expect(named.statusCode).toBe(400);
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
    expect(store.settings.get(WRITE_COOLDOWN.of('you'))).toBe(retryAt);
    // The selected account's status, and the account restored on restart, are untouched.
    expect(service.status.retryAt).toBeNull();
    expect(store.settings.get(LAST_ACCOUNT)).toBe(DEMO_SECOND_ACCOUNT);

    // The next refresh of that account waits without asking the forge.
    const reads = fixture.reads.length;

    expect((await call('POST', `/api/accounts/you/pulls/${pr.id}/refresh`)).statusCode).toBe(429);
    expect(fixture.reads).toHaveLength(reads);
  });

  it('shows the cooldown of an account it switches to, met while that account was not in use', async () => {
    const { fixture, service, pr, call } = await switchedAway();
    const retryAt = new Date(Date.now() + 300_000).toISOString();

    vi.spyOn(fixture, 'snapshot').mockRejectedValueOnce(
      new GitHubError('Rate limited', retryAt, 429, 'rate_limit'),
    );
    expect((await call('POST', `/api/accounts/you/pulls/${pr.id}/refresh`)).statusCode).toBe(429);

    const status = await service.switchAccount(DEMO_SECOND_ACCOUNT, 'you');

    expect(status).toMatchObject({ account: { login: 'you' }, retryAt, nextSyncAt: retryAt });
    expect(service.status.retryAt).toBe(retryAt);
  });

  it("builds each account's diff as that account, never from another account's cache", async () => {
    const { fixture, pr, call } = await switchedAway();

    // Both accounts track the PR: the second one adds it by hand.
    const added = await call('POST', `/api/accounts/${DEMO_SECOND_ACCOUNT}/pulls/track`, {
      repository: pr.repository,
      number: pr.number,
    });

    expect(added.statusCode).toBe(200);

    const listed = () => fixture.fileReads.map(({ account }) => account);
    const before = listed().length;
    const second = await call('GET', `/api/accounts/${DEMO_SECOND_ACCOUNT}/pulls/${pr.id}/diff`);

    expect(second.json()).toMatchObject({ account: DEMO_SECOND_ACCOUNT });
    expect(listed().slice(before)).toEqual([DEMO_SECOND_ACCOUNT]);

    // The same PR and revision, cached for the second account, is read again, as `you`.
    const yours = await call('GET', `/api/accounts/you/pulls/${pr.id}/diff`);

    expect(yours.json()).toMatchObject({ account: 'you' });
    expect(listed().slice(before)).toEqual([DEMO_SECOND_ACCOUNT, 'you']);

    // And from then on comes from `you`'s own entry.
    await call('GET', `/api/accounts/you/pulls/${pr.id}/diff`);
    expect(listed().slice(before)).toEqual([DEMO_SECOND_ACCOUNT, 'you']);
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
      /** MRs discovery also returns, beyond the `count` open ones. */
      discovered: [] as string[],
      /** A deadline the `assigned` feed is rate limited with, if any. */
      feedLimit: null as string | null,
    };
    const api = {
      identity: vi.fn(async () => ({ login: state.signedIn })),
      teams: vi.fn(async () => []),
      capabilities: vi.fn(async () => ({ requestChanges: true })),
      discover: vi.fn(async (_login: string, source: string) => {
        if (source === 'assigned' && state.feedLimit)
          throw new GitHubError('Rate limited', state.feedLimit, 429, 'rate_limit');

        return source === 'requested' ? [...ids, ...state.discovered] : [];
      }),
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
      resolvePull: vi.fn(async () => ({ id: 'mr-5', state: 'OPEN' as const })),
      verifyAccount: vi.fn(async (account: string) => {
        state.checks += 1;
        await state.onCheck?.(state.checks);

        if (state.signedIn !== account) throw new AccountUnavailable(account, state.signedIn);
      }),
    } as unknown as GitHubApi;

    store.settings.set(SELECTED_ACCOUNT, ACCOUNT);

    const service = new SyncService(store, api);

    cleanups.push(() => store.close());

    const heads = () => ids.map((id) => store.snapshot(ACCOUNT, id)?.headOid ?? null);

    return {
      store,
      service,
      state,
      ids,
      heads,
      api: api as unknown as Record<string, ReturnType<typeof vi.fn>>,
    };
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

    // Discovery finds a new MR; mr-2 is reported merged, and glab signs in as someone else before
    // detection's writes.
    state.discovered = ['mr-9'];
    state.merged.add('mr-2');
    state.onCheck = (check) => {
      // The checks of this sync: after discovery (4), after detection (5).
      if (check === 5) state.signedIn = OTHER;
    };
    await service.sync();

    expect(store.snapshot(ACCOUNT, 'mr-2')?.state).toBe('OPEN');
    // This sync's discovery, checked before detection began, was saved.
    expect([...store.membership(ACCOUNT).keys()].sort()).toEqual([...ids, 'mr-9'].sort());
    expect(store.snapshot(ACCOUNT, 'mr-9')).toBeNull();
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

  it('caches a GitLab diff only once its last check passed', async () => {
    let signedIn = ACCOUNT;
    let checks = 0;
    const pullFiles = vi.fn(async () => [
      {
        path: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-a\n+b\n',
        sha: null,
      },
    ]);
    const api = {
      pullFiles,
      verifyAccount: vi.fn(async (account: string) => {
        checks += 1;
        // glab signs in as someone else while the first build reads.
        if (checks === 2) signedIn = OTHER;
        if (signedIn !== account) throw new AccountUnavailable(account, signedIn);
      }),
    } as unknown as GitHubApi;
    const diffs = new DiffService(api);
    const pr = snapshot({ id: 'mr-1', headOid: 'head-1', baseOid: 'base-1', files: [] });

    await expect(diffs.manifest(pr, 'full', null, ACCOUNT)).rejects.toBeInstanceOf(
      AccountUnavailable,
    );

    // The rejected build left nothing to serve: the next one reads again, and is kept.
    signedIn = ACCOUNT;
    await diffs.manifest(pr, 'full', null, ACCOUNT);
    expect(pullFiles).toHaveBeenCalledTimes(2);

    await diffs.manifest(pr, 'full', null, ACCOUNT);
    expect(pullFiles).toHaveBeenCalledTimes(2);
  });

  it('passes on a GitLab diff’s unconfirmed limit with no deadline, and a confirmed one as is', async () => {
    const retryAt = new Date(Date.now() + 300_000).toISOString();
    const limited = () => new GitHubError('Rate limited', retryAt, 429, 'rate_limit');
    let signedIn = ACCOUNT;
    const pullFiles = vi.fn(async (): Promise<unknown[]> => {
      throw limited();
    });
    const verifyAccount = vi.fn(async (account: string) => {
      if (signedIn !== account) throw new AccountUnavailable(account, signedIn);
    });
    const diffs = new DiffService({ pullFiles, verifyAccount } as unknown as GitHubApi);
    const pr = snapshot({ id: 'mr-1', headOid: 'head-1', baseOid: 'base-1', files: [] });

    // A check that is itself rate limited cannot say whose the limit is.
    verifyAccount.mockRejectedValueOnce(limited());
    await expect(diffs.manifest(pr, 'full', null, ACCOUNT)).rejects.toMatchObject({
      outcome: 'unknown',
      retryAt: null,
    });

    // A limit met while building, after glab became someone else: nobody's.
    pullFiles.mockImplementationOnce(async () => {
      signedIn = OTHER;
      throw limited();
    });
    await expect(diffs.manifest(pr, 'full', null, ACCOUNT)).rejects.toMatchObject({
      outcome: 'unknown',
      retryAt: null,
    });

    // Confirmed as the account: its limit, as the forge reported it.
    signedIn = ACCOUNT;
    await expect(diffs.manifest(pr, 'full', null, ACCOUNT)).rejects.toMatchObject({
      outcome: 'rate_limit',
      retryAt,
    });

    // A build that succeeds, then a closing check that is rate limited: no deadline, nothing kept.
    pullFiles.mockImplementation(async () => []);
    verifyAccount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(limited());
    await expect(diffs.manifest(pr, 'full', null, ACCOUNT)).rejects.toMatchObject({
      outcome: 'unknown',
      retryAt: null,
    });

    const reads = pullFiles.mock.calls.length;

    await diffs.manifest(pr, 'full', null, ACCOUNT);
    expect(pullFiles.mock.calls.length).toBe(reads + 1);
  });

  it('keeps the deadline of a checked phase when a later phase’s check fails', async () => {
    const { service, state } = gitlabSync(2);
    const retryAt = new Date(Date.now() + 300_000).toISOString();

    await service.sync();

    // Discovery meets a limit on one feed and is checked; detection's check then finds someone
    // else.
    state.feedLimit = retryAt;
    state.onCheck = (check) => {
      if (check === 5) state.signedIn = OTHER;
    };
    await service.sync();

    expect(service.status.error).toContain(`signed in as ${OTHER}`);
    expect(service.status.retryAt).toBe(retryAt);
  });

  it('saves a refresh’s rate limit for the account only while glab is still it', async () => {
    const { store, service, state, api } = gitlabSync(1);
    const retryAt = new Date(Date.now() + 300_000).toISOString();
    const limited = () => new GitHubError('Rate limited', retryAt, 429, 'rate_limit');

    await service.sync();

    // glab became someone else, whose limit this is: passed on with no deadline, so neither this
    // refresh nor a caller (the outbox) saves it for the account.
    api.snapshot.mockImplementationOnce(async () => {
      state.signedIn = OTHER;
      throw limited();
    });
    await expect(service.refresh('mr-1', ACCOUNT)).rejects.toMatchObject({
      outcome: 'unknown',
      retryAt: null,
    });
    expect(store.settings.get(WRITE_COOLDOWN.of(ACCOUNT))).toBeNull();

    // Nor is a limit met by the check itself, which cannot say whose it is.
    state.signedIn = ACCOUNT;
    api.verifyAccount.mockRejectedValueOnce(limited());
    await expect(service.refresh('mr-1', ACCOUNT)).rejects.toMatchObject({
      outcome: 'unknown',
      retryAt: null,
    });
    expect(store.settings.get(WRITE_COOLDOWN.of(ACCOUNT))).toBeNull();

    // Still the account: its limit is saved before the caller hears of it.
    state.signedIn = ACCOUNT;
    api.snapshot.mockImplementationOnce(async () => {
      throw limited();
    });
    await expect(service.refresh('mr-1', ACCOUNT)).rejects.toThrow('Rate limited');
    expect(store.settings.get(WRITE_COOLDOWN.of(ACCOUNT))).toBe(retryAt);
  });

  it('sends the last published status between publications, so a revision is one state', async () => {
    const { service, state } = gitlabSync(1);

    await service.sync();

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const atCheck = new Promise<void>((resolve) => {
      reached = resolve;
    });

    // Held after this sync's discovery, once it has published its start.
    state.onCheck = async (check) => {
      if (check !== 4) return;

      reached();
      await held;
    };

    const syncing = service.sync();

    await atCheck;

    const during = service.sentStatus;

    // Live state that has not been published yet is not sent.
    service.status.warnings.push('Not published yet');
    expect(service.sentStatus).toEqual(during);

    release();
    await syncing;
    expect(service.sentStatus.revision).toBeGreaterThan(during.revision!);
  });

  it('adds nothing by hand while glab is signed in as someone else, and says so with a 409', async () => {
    const { service, state, api } = gitlabSync(1);

    await service.sync();
    state.signedIn = OTHER;

    const app = await createApp(service, { sessionToken: 'test-session' });

    cleanups.push(() => app.close());

    const added = await app.inject({
      method: 'POST',
      url: `/api/accounts/${encodeURIComponent(ACCOUNT)}/pulls/track`,
      headers,
      payload: { repository: 'team/app', number: 5, gitlab: true },
    });

    expect(added.statusCode).toBe(409);
    expect(added.json()).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
    expect(api.resolvePull).not.toHaveBeenCalled();
  });

  it('never saves a limit met by a sync’s own check of glab as the account’s cooldown', async () => {
    const { store, service, state } = gitlabSync(1);

    await service.sync();

    // After this sync's discovery glab is someone else, and its check is rate limited.
    state.onCheck = (check) => {
      if (check !== 4) return;

      state.signedIn = OTHER;
      throw new GitHubError(
        'Rate limited',
        new Date(Date.now() + 300_000).toISOString(),
        429,
        'rate_limit',
      );
    };
    await service.sync();

    expect(service.status.retryAt).toBeNull();
    expect(store.settings.get(STATUS.of(ACCOUNT))?.retryAt).toBeNull();
  });
});

describe('a sync that finds the CLI signed in as another account', () => {
  it('publishes that account before the routes that follow it serve it', async () => {
    const store = new Store(':memory:');
    let login = 'first-me';
    let release = () => {};
    let reached = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atDiscovery = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const api = {
      identity: vi.fn(async () => ({ login })),
      teams: vi.fn(async () => []),
      discover: vi.fn(async () => {
        if (login === 'second-me') {
          reached();
          await held;
        }

        return [];
      }),
      detect: vi.fn(async () => ({ results: [], budget: null })),
      snapshot: vi.fn(),
    } as unknown as GitHubApi;
    const service = new SyncService(store, api);

    cleanups.push(() => store.close());
    await service.sync();
    expect(service.sentStatus.account?.login).toBe('first-me');

    // Nothing was picked in the app, so the sync follows the CLI, which now says second-me.
    login = 'second-me';

    const syncing = service.sync();

    await atDiscovery;

    expect(service.list().account).toBe('second-me');
    expect(service.sentStatus.account?.login).toBe('second-me');

    release();
    await syncing;
  });
});

describe('a sync that adopts an account under a cooldown', () => {
  it('shows the cooldown and reads nothing until it passes', async () => {
    const store = new Store(':memory:');
    let login = 'first-me';
    const discover = vi.fn(async () => []);
    const api = {
      identity: vi.fn(async () => ({ login })),
      teams: vi.fn(async () => []),
      discover,
      detect: vi.fn(async () => ({ results: [], budget: null })),
      snapshot: vi.fn(),
    } as unknown as GitHubApi;
    const service = new SyncService(store, api);
    const retryAt = new Date(Date.now() + 300_000).toISOString();

    cleanups.push(() => store.close());
    await service.sync();

    // second-me met a limit while first-me was in use (a refresh scoped to it).
    store.settings.set(WRITE_COOLDOWN.of('second-me'), retryAt);
    discover.mockClear();

    // Nothing was picked in the app, and the CLI now says second-me.
    login = 'second-me';
    await service.sync();

    expect(service.status).toMatchObject({
      account: { login: 'second-me' },
      retryAt,
      nextSyncAt: retryAt,
    });
    expect(service.sentStatus.retryAt).toBe(retryAt);
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('a sync whose save fails', () => {
  it('goes on to the next PR with the reader whose save failed', async () => {
    const store = new Store(':memory:');
    const ids = ['pr-1', 'pr-2', 'pr-3', 'pr-4'];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = {
      identity: vi.fn(async () => ({ login: 'octo' })),
      teams: vi.fn(async () => []),
      discover: vi.fn(async (_login: string, source: string) =>
        source === 'requested' ? ids : [],
      ),
      detect: vi.fn(async (list: string[]) => ({
        results: list.map((id) => ({ id, state: 'OPEN' as const, fingerprint: randomUUID() })),
        budget: null,
      })),
      snapshot: vi.fn(async (id: string, _login: string, sources: string[]) => {
        // The other two readers stay busy until the fourth PR is saved.
        if (id === 'pr-2' || id === 'pr-3') await held;

        return snapshot({ id, number: Number(id.slice(3)), sources: sources as never });
      }),
    } as unknown as GitHubApi;
    const service = new SyncService(store, api);
    const save = store.saveSnapshot.bind(store);

    cleanups.push(() => store.close());
    vi.spyOn(store, 'saveSnapshot').mockImplementation((account, pr) => {
      if (pr.id === 'pr-1') throw new Error('disk full');

      save(account, pr);
    });

    const syncing = service.sync();

    try {
      // Only the reader whose save of pr-1 failed is free to read and save pr-4.
      await vi.waitFor(() => expect(store.snapshot('octo', 'pr-4')).not.toBeNull(), {
        timeout: 2_000,
      });
    } finally {
      release();
      await syncing;
    }

    expect(store.snapshot('octo', 'pr-1')).toBeNull();
    expect(store.snapshot('octo', 'pr-2')).not.toBeNull();
    expect(service.status.warnings).toContainEqual(expect.stringContaining('disk full'));
  });
});
