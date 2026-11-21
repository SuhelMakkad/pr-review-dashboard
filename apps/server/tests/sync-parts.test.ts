import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeCapabilities, SyncStatus } from '@review-desk/shared/types';
import { TestClock } from '@/clock.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { AccountState, initialStatus } from '@/sync/accounts.js';
import { SyncService } from '@/sync/service.js';
import { STATUS, WRITE_COOLDOWN } from '@/db/settings.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

/** An `AccountState` working as `you`, with every status it publishes. */
function accountState() {
  const store = new Store(':memory:');
  const events = new EventBus();
  const clock = new TestClock(Date.parse('2026-11-05T10:00:00Z'));
  const published: SyncStatus[] = [];

  store.saveStatus({ ...initialStatus(), account: { login: 'you' } });
  events.subscribe(({ event }) => {
    if (event.type === 'status') published.push(event.status);
  });
  cleanups.push(() => store.close());

  return { store, clock, published, state: new AccountState(store, events, null, clock) };
}

describe('AccountState', () => {
  it("publishes a sync's start at once, and what it found only when it ends", () => {
    const { clock, published, state } = accountState();

    state.beginSync();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ syncing: true, error: null, warnings: [] });

    state.setProfile({ login: 'you', avatarUrl: 'https://example.com/new.png' });
    state.warn('requested search incomplete');
    state.succeeded();
    state.setError('Something failed');

    // Nothing in between is published: the status sent is still the start's.
    expect(published).toHaveLength(1);
    expect(state.sentStatus).toMatchObject({ syncing: true, error: null, warnings: [] });

    const completedAt = new Date(clock.now()).toISOString();
    const login = state.finishSync({ retryAt: null, completedAt, intervalMs: 60_000 });

    expect(login).toBe('you');
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({
      account: { login: 'you', avatarUrl: 'https://example.com/new.png' },
      syncing: false,
      error: 'Something failed',
      warnings: ['requested search incomplete'],
      // A sync with a warning is not a successful one.
      lastSuccessfulSync: null,
      lastCompletedAt: completedAt,
      retryAt: null,
    });
    expect(Date.parse(published[1].nextSyncAt!)).toBeGreaterThan(clock.now());
  });

  it('ends a sync with the later of its own deadline and one a write met while it ran', () => {
    const { clock, state } = accountState();
    // Taken once: the test clock moves with real time.
    const start = clock.now();
    const [now, five, ten, twenty] = [0, 5, 10, 20].map((minutes) =>
      new Date(start + minutes * 60_000).toISOString(),
    );
    const finish = (retryAt: string | null) =>
      state.finishSync({ retryAt, completedAt: now, intervalMs: 60_000 });

    state.beginSync();
    state.deferUntil(ten);
    finish(five);

    expect(state.status).toMatchObject({ retryAt: ten, nextSyncAt: ten });

    state.beginSync();
    finish(twenty);

    expect(state.status).toMatchObject({ retryAt: twenty, nextSyncAt: twenty });
  });

  it("adopts another account's saved status at once, and returns its cooldown", () => {
    const { clock, published, store, state } = accountState();
    const until = new Date(clock.now() + 10 * 60_000).toISOString();

    store.settings.set(STATUS.of('other'), { ...initialStatus(), account: { login: 'other' } });
    store.settings.set(WRITE_COOLDOWN.of('other'), until);
    state.beginSync();

    expect(state.adoptIdentity({ login: 'other' })).toBe(until);
    expect(published.at(-1)).toMatchObject({
      account: { login: 'other' },
      syncing: true,
      retryAt: until,
      nextSyncAt: until,
    });

    // An account with no cooldown is adopted the same way, and nothing holds the sync back.
    expect(state.adoptIdentity({ login: 'someone' })).toBeNull();
    expect(published.at(-1)).toMatchObject({ account: { login: 'someone' }, retryAt: null });
  });

  it('puts a read on the status in use when it began, even if a cooldown replaces it meanwhile', () => {
    const { clock, state } = accountState();

    state.beginSync();

    const started = state.status;
    const target = state.readTarget();

    state.deferUntil(new Date(clock.now() + 60_000).toISOString());
    target.setTeams(['org/reviewers']);

    expect(started.teams).toEqual(['org/reviewers']);
    expect(state.status).not.toBe(started);
    expect(state.status.teams).toEqual([]);
  });
});

/** A demo service working as `you`, with the identity reads counted. */
function demo() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);
  const identify = fixture.identity.bind(fixture);
  const identity = vi.spyOn(fixture, 'identity');

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());

  return { service, fixture, identify, identity };
}

/** A promise's settling, seen without awaiting it. */
function settled(promise: Promise<unknown>) {
  const seen = { settled: false };

  void promise.then(
    () => (seen.settled = true),
    () => (seen.settled = true),
  );

  return seen;
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SyncRunner', () => {
  it('keeps the capabilities it has when the forge cannot read them', async () => {
    const { service, fixture } = demo();
    const capabilities: ForgeCapabilities = { requestChanges: false };

    await service.sync();
    service.status.capabilities = capabilities;

    // The fixture has no reader for them.
    await service.sync();
    expect(service.status.capabilities).toEqual(capabilities);

    Object.assign(fixture, { capabilities: () => Promise.reject(new Error('offline')) });
    await service.sync();
    expect(service.status.capabilities).toEqual(capabilities);
  });

  it('starts the teams read in the same turn as the capabilities arrive', async () => {
    const { service, fixture, identify, identity } = demo();
    const seen = { assigned: false, turnPassed: false, teamsInSameTurn: false };

    await service.sync();

    Object.assign(fixture, {
      capabilities: () => Promise.resolve({ requestChanges: true } satisfies ForgeCapabilities),
    });
    // The status the sync starts with, which the capabilities are written to: a write queues a
    // microtask, which must not have run when the teams read starts.
    identity.mockImplementationOnce(async () => {
      const status = service.status;
      let value = status.capabilities;

      Object.defineProperty(status, 'capabilities', {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (next) => {
          value = next;
          seen.assigned = true;
          queueMicrotask(() => (seen.turnPassed = true));
        },
      });

      return identify();
    });

    const teams = fixture.teams.bind(fixture);

    vi.spyOn(fixture, 'teams').mockImplementation(() => {
      seen.teamsInSameTurn = seen.assigned && !seen.turnPassed;

      return teams();
    });

    await service.sync();

    expect(seen.teamsInSameTurn).toBe(true);
    expect(service.status.capabilities).toEqual({ requestChanges: true });
  });

  it('runs afterSync as a method of the service', async () => {
    const { service } = demo();
    let receiver: unknown;

    service.afterSync = async function (this: unknown) {
      receiver = this;
    };

    await service.sync();

    expect(receiver).toBe(service);
  });

  it('lets a sync join a pending switch, which fails once the sync before it changes the account', async () => {
    const { service, identify, identity } = demo();
    let release: (() => void) | undefined;

    // Runs before the service stops, so a failed assertion cannot leave the sync held.
    cleanups.push(() => release?.());

    identity.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));

      return identify();
    });

    const syncing = service.sync();

    await vi.waitFor(() => expect(release).toBeDefined());

    // No account is known yet, so switching from none is right when asked. It is stale once the
    // held sync identifies `you`, which the switch must see after waiting for it.
    expect(service.status.account).toBeNull();

    const switching = service.switchAccount(null, DEMO_SECOND_ACCOUNT);

    await tick();

    const joining = service.sync();
    const joined = settled(joining);

    // The switch holds the slot behind the held sync, and the sync waits with it.
    await tick();
    expect(joining).not.toBe(syncing);
    expect(joined.settled).toBe(false);

    release!();

    await expect(switching).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    await expect(joining).resolves.toBeUndefined();
    expect(service.status.account?.login).toBe('you');
    expect(identity).toHaveBeenCalledTimes(1);

    // The slot is free afterwards: the next sync runs.
    await service.sync();
    expect(identity).toHaveBeenCalledTimes(2);
  });

  it('lets a sync join a pending switch, then starts the new account’s sync itself', async () => {
    const { service, fixture, identity } = demo();
    const discover = fixture.discover.bind(fixture);
    let release: (() => void) | undefined;

    // Runs before the service stops, so a failed assertion cannot leave the sync held.
    cleanups.push(() => release?.());

    vi.spyOn(fixture, 'discover').mockImplementation(async (login, source) => {
      if (source === 'requested' && !release)
        await new Promise<void>((resolve) => (release = resolve));

      return discover(login, source);
    });

    const syncing = service.sync();

    await vi.waitFor(() => expect(release).toBeDefined());

    const switching = service.switchAccount('you', DEMO_SECOND_ACCOUNT);

    await tick();

    const joining = service.sync();
    const joined = settled(joining);

    await tick();
    expect(joining).not.toBe(syncing);
    expect(joined.settled).toBe(false);

    release!();

    await expect(switching).resolves.toMatchObject({ account: { login: DEMO_SECOND_ACCOUNT } });
    await expect(joining).resolves.toBeUndefined();

    // Nothing else asks for a sync: the switch starts the new account's own, once.
    expect(identity).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(service.status.syncing).toBe(false));
    expect(identity).toHaveBeenCalledTimes(2);
    expect(service.status.account?.login).toBe(DEMO_SECOND_ACCOUNT);
  });
});
