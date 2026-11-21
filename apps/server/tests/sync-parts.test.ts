import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeCapabilities, SyncStatus } from '@review-desk/shared/types';
import { TestClock } from '@/clock.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { AccountState, initialStatus } from '@/sync/accounts.js';
import { SyncService } from '@/sync/service.js';

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

    store.setSetting('status:other', { ...initialStatus(), account: { login: 'other' } });
    store.setSetting('github-write-retry:other', until);
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

  it('puts a read on the status in use when it began, even if a cooldown replaces it meanwhile', async () => {
    const { clock, state } = accountState();
    let answer: ((teams: string[]) => void) | undefined;

    state.beginSync();

    const started = state.status;
    const reading = state.readTeams(() => new Promise((resolve) => (answer = resolve)));

    state.deferUntil(new Date(clock.now() + 60_000).toISOString());
    answer!(['org/reviewers']);
    await reading;

    expect(started.teams).toEqual(['org/reviewers']);
    expect(state.status).not.toBe(started);
    expect(state.status.teams).toEqual([]);
  });

  it('keeps the capabilities it has when the forge cannot read them', async () => {
    const { state } = accountState();
    const capabilities: ForgeCapabilities = { requestChanges: false };

    state.status.capabilities = capabilities;

    await state.readCapabilities(undefined);
    expect(state.status.capabilities).toBe(capabilities);

    await state.readCapabilities(() => Promise.reject(new Error('offline')));
    expect(state.status.capabilities).toBe(capabilities);
  });
});

/** A demo service whose first `requested` search waits until `release` is called. */
function heldSync() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);
  const discover = fixture.discover.bind(fixture);
  const identity = vi.spyOn(fixture, 'identity');
  const held = { release: undefined as (() => void) | undefined };

  vi.spyOn(fixture, 'discover').mockImplementation(async (login, source) => {
    if (source === 'requested' && !held.release)
      await new Promise<void>((resolve) => (held.release = resolve));

    return discover(login, source);
  });
  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());

  return { service, identity, held };
}

describe('SyncRunner', () => {
  it('lets a sync join a pending switch, which fails if the account changed meanwhile', async () => {
    const { service, identity, held } = heldSync();
    const syncing = service.sync();

    await vi.waitFor(() => expect(held.release).toBeDefined());

    // `null` was the account before the held sync identified `you`.
    const switching = service.switchAccount(null, DEMO_SECOND_ACCOUNT);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const joining = service.sync();

    // The switch holds the slot, so the sync joins it rather than the held sync or a new run.
    expect(joining).not.toBe(syncing);

    held.release!();

    await expect(switching).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    await expect(joining).resolves.toBeUndefined();
    expect(service.status.account?.login).toBe('you');
    expect(identity).toHaveBeenCalledTimes(1);

    // The slot is free afterwards: the next sync runs.
    await service.sync();
    expect(identity).toHaveBeenCalledTimes(2);
  });

  it('lets a sync join a pending switch, then runs the new account’s sync once', async () => {
    const { service, identity, held } = heldSync();
    const syncing = service.sync();

    await vi.waitFor(() => expect(held.release).toBeDefined());

    const switching = service.switchAccount('you', DEMO_SECOND_ACCOUNT);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const joining = service.sync();

    expect(joining).not.toBe(syncing);

    held.release!();

    await expect(switching).resolves.toMatchObject({ account: { login: DEMO_SECOND_ACCOUNT } });
    await expect(joining).resolves.toBeUndefined();

    // The switch started the new account's sync; this joins it.
    await service.sync();

    expect(identity).toHaveBeenCalledTimes(2);
    expect(service.status.account?.login).toBe(DEMO_SECOND_ACCOUNT);
    expect(service.status.syncing).toBe(false);
  });
});
