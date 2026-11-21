import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cancel, Clock } from '@/clock.js';
import { WRITE_COOLDOWN } from '@/db/settings.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { GitHubError } from '@/github/errors.js';
import { log } from '@/log.js';
import { OperationQueue } from '@/operations/queue.js';
import { SyncService } from '@/sync/service.js';

interface Timer {
  ms: number;
  run: () => void;
  unref: boolean;
  done: boolean;
}

/** Wall time moved by hand, and timers that fire only when a test fires them. */
class RecordingClock implements Clock {
  wall = Date.parse('2026-11-05T10:00:00Z');
  readonly timers: Timer[] = [];

  now(): number {
    return this.wall;
  }

  after(ms: number, run: () => void, options?: { unref?: boolean }): Cancel {
    const timer = { ms, run, unref: Boolean(options?.unref), done: false };

    this.timers.push(timer);

    return () => {
      timer.done = true;
    };
  }

  every(): Cancel {
    return () => undefined;
  }

  /** The delays of the outbox's wakes still armed (its only unref'd timers). */
  wakes(): number[] {
    return this.timers.filter((timer) => timer.unref && !timer.done).map((timer) => timer.ms);
  }

  /** Fires the outbox's armed wake. */
  fire(): void {
    const armed = this.timers.filter((timer) => timer.unref && !timer.done);

    expect(armed).toHaveLength(1);

    armed[0].done = true;
    armed[0].run();
  }
}

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { retryDelaysMs?: number[] } = {}) {
  const clock = new RecordingClock();
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const sync = new SyncService(store, github, new EventBus(), null, clock);

  cleanups.push(() => store.close());
  await sync.sync();

  const queue = new OperationQueue(sync, {
    mutationIntervalMs: 0,
    retryDelaysMs: options.retryDelaysMs ?? [30_000, 30_000, 30_000],
  });

  queue.open();
  cleanups.push(() => queue.close());

  const pulls = sync.list().items;
  const prs = [pulls[0].id, pulls[1].id];
  const path = (prId: string) => sync.detail(prId)!.snapshot.files[0].path;
  const view = (prId = prs[0]) =>
    queue.enqueue('you', prId, randomUUID(), { type: 'viewed', path: path(prId), viewed: true })
      .operation;
  const status = (id: string) => queue.get('you', id).status;
  const sent = () => github.writes.length;

  return { clock, store, github, sync, queue, prs, view, status, sent };
}

/** Lets a fired wake's tick run to its end, which arms the next wake. */
async function ticked(clock: RecordingClock, done: () => boolean) {
  await vi.waitFor(() => expect(done()).toBe(true));
  // The tick's `finally` runs once what it awaited settles.
  await new Promise((resolve) => setTimeout(resolve, 0));

  return clock.wakes();
}

describe('the outbox sleeps until an action is due', () => {
  it('arms nothing while no action waits', async () => {
    const { clock } = await setup();

    expect(clock.wakes()).toEqual([]);
  });

  it('wakes 100 ms after an action is queued, sends it, then arms nothing', async () => {
    const { clock, view, status, sent } = await setup();
    const action = view();

    expect(clock.wakes()).toEqual([100]);
    expect(sent()).toBe(0);

    clock.fire();

    expect(await ticked(clock, () => status(action.id) === 'succeeded')).toEqual([]);
    expect(sent()).toBe(1);
  });

  it('sleeps until a failed action is retried, and no longer', async () => {
    const { clock, github, queue, view, status } = await setup();

    vi.spyOn(github, 'identity').mockRejectedValueOnce(new GitHubError('Connection refused'));

    const action = view();

    clock.fire();

    expect(await ticked(clock, () => queue.get('you', action.id).retryAt !== null)).toEqual([
      30_000,
    ]);
    expect(['queued', 'waiting']).toContain(status(action.id));
  });

  it('sleeps until the hold on sending ends, and re-arms when a status brings it closer', async () => {
    const { clock, sync, store, view } = await setup();

    sync.deferUntil(new Date(clock.wall + 60_000).toISOString(), 'you');
    view();

    expect(clock.wakes()).toEqual([60_000]);

    store.settings.set(WRITE_COOLDOWN.of('you'), new Date(clock.wall + 10_000).toISOString());
    sync.status = { ...sync.status, retryAt: null };
    sync.events.emit({ type: 'status', status: sync.status });

    expect(clock.wakes()).toEqual([10_000]);
  });

  it('never sleeps past five minutes, sends nothing early, and sends once the hold ends', async () => {
    const { clock, sync, queue, view, status, sent } = await setup();

    sync.deferUntil(new Date(clock.wall + 60 * 60_000).toISOString(), 'you');

    const action = view();

    expect(clock.wakes()).toEqual([300_000]);

    const before = queue.get('you', action.id);

    clock.fire();

    expect(await ticked(clock, () => clock.wakes().length > 0)).toEqual([300_000]);
    expect(sent()).toBe(0);
    // Untouched: not tried, not failed, not put off.
    expect(queue.get('you', action.id)).toEqual(before);

    clock.wall += 60 * 60_000;
    clock.fire();

    expect(await ticked(clock, () => status(action.id) === 'succeeded')).toEqual([]);
    expect(sent()).toBe(1);
  });

  it('keeps the wake already armed, so a stream of actions cannot put off a due one', async () => {
    const { clock, prs, view } = await setup();

    view(prs[0]);
    view(prs[1]);

    expect(clock.timers.filter((timer) => timer.unref)).toHaveLength(1);
    expect(clock.wakes()).toEqual([100]);
  });

  it('wakes sooner for an action queued while it sleeps for a later one', async () => {
    const { clock, sync, prs, view } = await setup();

    sync.deferUntil(new Date(clock.wall + 60 * 60_000).toISOString(), 'you');
    view(prs[0]);

    expect(clock.wakes()).toEqual([300_000]);

    // The hold ends early, by wall time, without a status of its own.
    clock.wall += 2 * 60 * 60_000;
    view(prs[1]);

    // Compared by elapsed time: the five-minute wake, though its wall time is past, gives way.
    expect(clock.wakes()).toEqual([100]);
  });

  it('wakes at once when a status lifts the hold', async () => {
    const { clock, sync, store, view } = await setup();

    sync.deferUntil(new Date(clock.wall + 60 * 60_000).toISOString(), 'you');
    view();

    expect(clock.wakes()).toEqual([300_000]);

    store.settings.delete(WRITE_COOLDOWN.of('you'));
    sync.status = { ...sync.status, retryAt: null };
    sync.events.emit({ type: 'status', status: sync.status });

    expect(clock.wakes()).toEqual([100]);
  });

  it('sends another PR past one held by an action needing your attention', async () => {
    const { clock, store, queue, prs, view, status } = await setup();

    await queue.pause();

    const held = view(prs[0]);
    const behind = view(prs[0]);
    const other = view(prs[1]);

    // Edited behind the outbox's back, so it is woken by hand.
    store.operations.update({
      ...store.operations.find('you', held.id)!,
      status: 'needs_attention',
    });
    queue.resume();

    expect(clock.wakes()).toEqual([100]);

    clock.fire();

    expect(await ticked(clock, () => status(other.id) === 'succeeded')).toEqual([]);
    expect(status(behind.id)).toBe('queued');
  });

  it('arms nothing during a tick, and wakes for what was queued meanwhile once it ends', async () => {
    const { clock, github, prs, view, status } = await setup();

    github.writeDelayMs = 50;

    const first = view(prs[0]);

    clock.fire();
    await vi.waitFor(() => expect(status(first.id)).toBe('running'));

    const second = view(prs[1]);

    // Its own saves and this action's enqueue wake nothing while the tick runs.
    expect(clock.wakes()).toEqual([]);
    expect(await ticked(clock, () => status(first.id) === 'succeeded')).toEqual([100]);
    expect(status(second.id)).toBe('queued');
  });

  it('arms nothing while paused or held, and wakes on release', async () => {
    const { clock, queue, view } = await setup();

    await queue.pause();
    view();

    expect(clock.wakes()).toEqual([]);

    queue.resume();

    expect(clock.wakes()).toEqual([100]);

    const release = await queue.hold();

    expect(clock.wakes()).toEqual([]);

    view();

    expect(clock.wakes()).toEqual([]);

    release();

    expect(clock.wakes()).toEqual([100]);
  });

  it('sends nothing when paused between the wake firing and its tick', async () => {
    const { clock, queue, view, status, sent } = await setup();
    const action = view();
    const tick = vi.spyOn(queue as unknown as { tick(): Promise<void> }, 'tick');

    clock.fire();
    // Before the tick's microtask runs.
    await queue.pause();

    expect(tick).not.toHaveBeenCalled();

    expect(status(action.id)).toBe('queued');
    expect(sent()).toBe(0);
    expect(clock.wakes()).toEqual([]);

    queue.resume();
    clock.fire();

    expect(await ticked(clock, () => status(action.id) === 'succeeded')).toEqual([]);
    expect(sent()).toBe(1);
  });

  it('never fails an enqueue when it cannot read what is due, and sends the action once', async () => {
    const { clock, store, view, status, sent } = await setup();
    const active = store.operations.active.bind(store.operations);
    let failed = false;

    vi.spyOn(store.operations, 'active').mockImplementation((account) => {
      if (!failed && new Error().stack?.includes('nextDelay')) {
        failed = true;

        throw new Error('disk I/O error');
      }

      return active(account);
    });

    const warn = vi.spyOn(log, 'event');
    const action = view();

    expect(failed).toBe(true);
    expect(action.status).toBe('queued');
    expect(warn.mock.calls.filter(([, event]) => event === 'outbox.wake-failed')).toEqual([
      ['warn', 'outbox.wake-failed', {}],
    ]);
    // Looked at again within a second, with nothing else to wake it.
    expect(clock.wakes()).toEqual([1000]);

    clock.fire();

    expect(await ticked(clock, () => status(action.id) === 'succeeded')).toEqual([]);
    expect(sent()).toBe(1);
  });

  it('stops sleeping once its only action is cancelled', async () => {
    const { clock, sync, queue, view } = await setup();

    sync.deferUntil(new Date(clock.wall + 60 * 60_000).toISOString(), 'you');

    const action = view();

    expect(clock.wakes()).toEqual([300_000]);

    await queue.control('you', action.id, 'cancel');

    expect(clock.wakes()).toEqual([]);
  });

  it('wakes for a row saved in a transaction only once it commits', async () => {
    const { clock, sync, store, queue, view } = await setup();

    sync.deferUntil(new Date(clock.wall + 60 * 60_000).toISOString(), 'you');

    const action = view();
    const save = (queue as unknown as { save(row: unknown): unknown }).save.bind(queue);

    store.settings.delete(WRITE_COOLDOWN.of('you'));
    sync.status = { ...sync.status, retryAt: null };
    store.transaction(() => {
      save(store.operations.find('you', action.id));

      expect(clock.wakes()).toEqual([300_000]);
    });

    expect(clock.wakes()).toEqual([100]);
  });

  it('stops listening for status changes once closed', async () => {
    const { sync, queue } = await setup();
    const before = sync.events.subscriberCount;

    await queue.close();

    expect(sync.events.subscriberCount).toBe(before - 1);
  });
});
