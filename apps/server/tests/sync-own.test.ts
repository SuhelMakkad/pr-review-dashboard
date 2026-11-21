import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestClock } from '@/clock.js';
import { Store } from '@/db/store.js';
import { defaultScenario } from '@/demo/scenario.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { EventBus } from '@/events.js';
import { SyncService } from '@/sync/index.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const clock = new TestClock(Date.parse('2026-11-05T10:00:00Z'));
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const sync = new SyncService(store, github, new EventBus(), null, clock);

  cleanups.push(() => store.close());
  await sync.sync();

  const signal = new AbortController().signal;
  const stamp = (offsetMs: number) => new Date(clock.now() + offsetMs).toISOString();

  return { clock, store, github, sync, signal, stamp };
}

describe('a sync of its own', () => {
  it('reports its own run, with what its hook handed back', async () => {
    const { sync, signal } = await setup();
    const pass = Promise.resolve({ account: 'you', cutoff: 1 });

    sync.afterSync = async () => ({ pass });

    expect(await sync.syncOwn('you', signal)).toEqual({
      kind: 'synced',
      account: 'you',
      hooked: { pass },
    });
  });

  it('never joins a sync in progress: it waits, then runs its own', async () => {
    const { github, sync, signal } = await setup();
    const identity = vi.spyOn(github, 'identity');
    const running = sync.sync();
    const own = sync.syncOwn('you', signal);

    await running;

    expect(await own).toMatchObject({ kind: 'synced', account: 'you' });
    // Two syncs, each reading who the account is.
    expect(identity).toHaveBeenCalledTimes(2);
  });

  it('says it missed when its hook did not complete', async () => {
    const { sync, signal } = await setup();

    sync.afterSync = async () => {
      throw new Error('hook failed');
    };

    expect(await sync.syncOwn('you', signal)).toEqual({ kind: 'missed', account: 'you' });
  });

  it('says it missed when it failed before it knew whose sync it was', async () => {
    const { github, sync, signal } = await setup();

    vi.spyOn(github, 'identity').mockRejectedValueOnce(new Error('Connection refused'));

    expect(await sync.syncOwn('you', signal)).toEqual({ kind: 'missed', account: 'you' });
  });

  it('says it missed when its run failed as it finished, leaving nothing unhandled', async () => {
    const { store, sync, signal } = await setup();
    const save = store.saveStatus.bind(store);

    vi.spyOn(store, 'saveStatus').mockImplementation((status) => {
      if (new Error().stack?.includes('finishSync')) throw new Error('disk I/O error');

      save(status);
    });

    expect(await sync.syncOwn('you', signal)).toEqual({ kind: 'missed', account: 'you' });
    // A later sync is not held up by it.
    vi.restoreAllMocks();
    await sync.sync();
  });

  it('starts nothing for an account not in use', async () => {
    const { github, sync, signal } = await setup();
    const identity = vi.spyOn(github, 'identity');

    expect(await sync.syncOwn('someone-else', signal)).toEqual({ kind: 'inactive' });
    expect(identity).not.toHaveBeenCalled();
  });

  it('starts nothing once another account came into use while it waited', async () => {
    const { github, sync, signal } = await setup();
    const identity = vi.spyOn(github, 'identity');

    // The sync it waits for ends with another account in use, as a switch right after it would.
    sync.afterSync = async () => {
      sync.status = { ...sync.status, account: { ...sync.status.account!, login: 'someone-else' } };
    };

    const running = sync.sync();
    const own = sync.syncOwn('you', signal);

    await running;

    expect(await own).toEqual({ kind: 'inactive' });
    // The one sync it waited for, and none of its own.
    expect(identity).toHaveBeenCalledTimes(1);
  });

  it('starts nothing while its own account cools down', async () => {
    const { github, sync, signal, stamp } = await setup();
    const until = stamp(60_000);
    const identity = vi.spyOn(github, 'identity');

    sync.deferUntil(until, 'you');

    expect(await sync.syncOwn('you', signal)).toEqual({
      kind: 'cooling',
      until: sync.cooldown('you'),
    });
    expect(identity).not.toHaveBeenCalled();
  });

  it('starts nothing once aborted, even while it waits for the slot', async () => {
    const { github, sync } = await setup();
    const controller = new AbortController();
    const running = sync.sync();
    const own = sync.syncOwn('you', controller.signal);

    controller.abort();

    expect(await own).toEqual({ kind: 'aborted' });

    const identity = vi.spyOn(github, 'identity');

    await running;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(identity).not.toHaveBeenCalled();
  });

  it('starts nothing with a signal already aborted', async () => {
    const { github, sync } = await setup();
    const controller = new AbortController();
    const identity = vi.spyOn(github, 'identity');

    controller.abort();

    expect(await sync.syncOwn('you', controller.signal)).toEqual({ kind: 'aborted' });
    expect(identity).not.toHaveBeenCalled();
  });

  it('returns at once when aborted while it waits for the slot', async () => {
    const { sync } = await setup();
    const controller = new AbortController();
    let ended = false;

    // The sync it waits for takes a while to end.
    sync.afterSync = () => new Promise((resolve) => setTimeout(resolve, 100));

    const running = sync.sync().then(() => (ended = true));
    const own = sync.syncOwn('you', controller.signal);

    controller.abort();

    expect(await own).toEqual({ kind: 'aborted' });
    expect(ended).toBe(false);

    await running;
  });

  it('returns at once when aborted while its own sync runs, leaving that sync to finish', async () => {
    const { sync } = await setup();
    const controller = new AbortController();
    let hooked = false;

    sync.afterSync = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          hooked = true;
          resolve();
        }, 100),
      );

    const own = sync.syncOwn('you', controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    expect(await own).toEqual({ kind: 'aborted' });
    expect(hooked).toBe(false);

    // Its sync still ends as usual.
    await sync.sync();
    await vi.waitFor(() => expect(hooked).toBe(true));
  });

  it('starts nothing once stopped', async () => {
    const { github, sync, signal } = await setup();
    const identity = vi.spyOn(github, 'identity');

    await sync.stop();

    expect(await sync.syncOwn('you', signal)).toEqual({ kind: 'stopped' });
    expect(identity).not.toHaveBeenCalled();
  });

  it('still shares one run among callers that join it', async () => {
    const { sync } = await setup();
    const first = sync.sync();

    expect(sync.sync()).toBe(first);

    await first;
  });
});
