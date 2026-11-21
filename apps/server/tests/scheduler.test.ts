import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduledWork } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { log } from '@/log.js';
import { registerSecret } from '@/redact.js';
import { Aborted, Defer, Scheduler, type Work } from '@/scheduler/scheduler.js';
import { RecordingClock } from '@test/fixtures/recording-clock.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A handler's runs: each one waits for the test to answer it. */
function handler() {
  const calls: {
    work: Work;
    signal: AbortSignal;
    answer: (next: string | null) => void;
    fail: (error: unknown) => void;
  }[] = [];
  const run = vi.fn(
    (work: Work, signal: AbortSignal) =>
      new Promise<{ next: string | null }>((resolve, reject) => {
        // Told to stop, as a real handler is: released, never left hanging.
        signal.addEventListener('abort', () => reject(new Aborted()), { once: true });
        calls.push({ work, signal, answer: (next) => resolve({ next }), fail: reject });
      }),
  );

  return { run, calls };
}

function setup(bootId = 'boot-1', shared?: { store: Store; clock: RecordingClock }) {
  const clock = shared?.clock ?? new RecordingClock();
  const store = shared?.store ?? new Store(':memory:');
  const scheduler = new Scheduler(store, clock, bootId);

  if (!shared) cleanups.push(() => store.close());

  cleanups.push(() => scheduler.close());

  const at = (offsetMs: number) => new Date(clock.wall + offsetMs).toISOString();
  const row = (kind = 'job', key = 'k') => store.scheduledWork.get(kind, key);
  const ask = (kind: string, key: string, offsetMs: number, notBefore?: number) =>
    store.transaction(() =>
      scheduler.request(kind, key, {
        account: 'you',
        at: at(offsetMs),
        notBefore: notBefore === undefined ? undefined : at(notBefore),
      }),
    );
  /** Lets a fired run's handler start, and a settled one's wake re-arm. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { clock, store, scheduler, at, row, ask, flush };
}

describe('the scheduler', () => {
  it('arms nothing with nothing asked for', () => {
    const { clock, scheduler } = setup();

    scheduler.register('job', { class: 'automation', ...handler() });
    scheduler.open();

    expect(clock.wakes()).toEqual([]);
  });

  it('keeps the earliest ask, and wakes for it', () => {
    const { clock, scheduler, ask, row, at } = setup();

    scheduler.register('job', { class: 'automation', ...handler() });
    scheduler.open();
    ask('job', 'k', 60_000);
    ask('job', 'k', 30_000);
    ask('job', 'k', 90_000);

    expect(row()).toMatchObject({
      requestedAt: at(30_000),
      notBefore: null,
      account: 'you',
      class: 'automation',
    });
    expect(clock.wakes()).toEqual([30_000]);
  });

  it('holds a request back to its gate, which a later request never lowers', () => {
    const { clock, scheduler, ask, row, at } = setup();

    scheduler.register('job', { class: 'automation', ...handler() });
    scheduler.open();
    ask('job', 'k', 0, 120_000);
    ask('job', 'k', 0, 10_000);

    expect(row()).toMatchObject({ requestedAt: at(0), notBefore: at(120_000) });
    expect(clock.wakes()).toEqual([120_000]);
  });

  it('never sleeps past five minutes, nor runs anything early', async () => {
    const { clock, scheduler, ask, flush } = setup();
    const { run } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 60 * 60_000);

    expect(clock.wakes()).toEqual([300_000]);

    clock.fire();
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(clock.wakes()).toEqual([300_000]);
  });

  it('runs work when due, then wakes for when it asks to run next', async () => {
    const { clock, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);

    expect(clock.wakes()).toEqual([100]);

    clock.fire();
    await flush();

    expect(calls.map((call) => call.work)).toEqual([{ kind: 'job', key: 'k', account: 'you' }]);
    expect(row()).toMatchObject({ claimedBy: 'boot-1' });
    expect(clock.wakes()).toEqual([]);

    calls[0].answer(at(45_000));
    await flush();

    expect(row()).toMatchObject({ requestedAt: at(45_000), claimedBy: null, attempts: 0 });
    expect(clock.wakes()).toEqual([45_000]);
  });

  it('forgets work that asks for nothing more', async () => {
    const { clock, scheduler, ask, row, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    calls[0].answer(null);
    await flush();

    expect(row()).toBeUndefined();
    expect(clock.wakes()).toEqual([]);
  });

  it('runs again for an ask made while it ran', async () => {
    const { clock, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    ask('job', 'k', 20_000);
    ask('job', 'k', 40_000);

    // The request it runs for stands; asks made meanwhile wait, the earliest winning.
    expect(row()).toMatchObject({ requestedAt: at(0), rearmAt: at(20_000) });
    expect(clock.wakes()).toEqual([]);

    calls[0].answer(null);
    await flush();

    expect(row()).toMatchObject({ requestedAt: at(20_000), rearmAt: null, claimedBy: null });
    expect(clock.wakes()).toEqual([20_000]);
  });

  it('runs one of a class at a time', async () => {
    const { clock, scheduler, ask, flush } = setup();
    const first = handler();
    const second = handler();

    scheduler.register('first', { class: 'automation', run: first.run });
    scheduler.register('second', { class: 'automation', run: second.run });
    scheduler.open();
    ask('first', 'k', 0);
    ask('second', 'k', 0);
    clock.fire();
    await flush();

    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
    // The class is full: nothing is armed for the other.
    expect(clock.wakes()).toEqual([]);

    first.calls[0].answer(null);
    await flush();

    expect(clock.wakes()).toEqual([100]);

    clock.fire();
    await flush();

    expect(second.run).toHaveBeenCalledTimes(1);
  });

  it('puts off deferred work to its time, without counting an attempt', async () => {
    const { clock, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    calls[0].fail(new Defer(at(90_000)));
    await flush();

    expect(row()).toMatchObject({
      requestedAt: at(0),
      notBefore: at(90_000),
      attempts: 0,
      claimedBy: null,
    });
    expect(clock.wakes()).toEqual([90_000]);
  });

  it('backs off after a failure, doubling, and keeps the error redacted', async () => {
    const { clock, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    registerSecret('ghp_scheduler_secret');
    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    calls[0].fail(new Error('token ghp_scheduler_secret was refused'));
    await flush();

    expect(row()).toMatchObject({ requestedAt: at(0), notBefore: at(30_000), attempts: 1 });
    expect(row()!.lastError).not.toContain('ghp_scheduler_secret');
    expect(clock.wakes()).toEqual([30_000]);

    clock.wall += 30_000;
    clock.fire();
    await flush();
    calls[1].fail(new Error('again'));
    await flush();

    // From the second failure: a minute.
    expect(row()).toMatchObject({ notBefore: at(60_000), attempts: 2 });

    clock.wall += 60_000;
    clock.fire();
    await flush();
    calls[2].answer(at(600_000));
    await flush();

    // Succeeded: its failures are behind it.
    expect(row()).toMatchObject({ attempts: 0, lastError: null, requestedAt: at(600_000) });
  });

  it('keeps a gate raised while it ran', async () => {
    const { clock, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    ask('job', 'k', 0, 600_000);
    calls[0].answer(null);
    await flush();

    // Asked again with a gate: it runs then, not before.
    expect(row()).toMatchObject({ requestedAt: at(0), notBefore: at(600_000) });

    clock.fire();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(clock.wakes()).toEqual([300_000]);
  });

  it('keeps a row only for its gate, arming nothing for it, until a request fills it', async () => {
    const { clock, store, scheduler, ask, row, at, flush } = setup();
    const gated = handler();
    const other = handler();
    const now = at(0);

    // Its request served, its gate still ahead.
    store.db
      .insert(scheduledWork)
      .values({
        kind: 'job',
        key: 'k',
        class: 'automation',
        notBefore: at(600_000),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    scheduler.register('job', { class: 'automation', run: gated.run });
    scheduler.register('other', { class: 'automation', run: other.run });
    scheduler.open();

    expect(row()).toMatchObject({ requestedAt: null, notBefore: at(600_000) });
    expect(clock.wakes()).toEqual([]);

    // It blocks nothing else in its class.
    ask('other', 'k', 0);
    clock.fire();
    await flush();

    expect(other.run).toHaveBeenCalledTimes(1);

    other.calls[0].answer(null);
    await flush();
    ask('job', 'k', 0);

    // Filled, its gate kept.
    expect(row()).toMatchObject({ requestedAt: at(0), notBefore: at(600_000) });
    expect(clock.wakes()).toEqual([300_000]);
    expect(gated.run).not.toHaveBeenCalled();
  });

  it('keeps the wake already armed, so a stream of asks cannot put off a due one', () => {
    const { clock, scheduler, ask } = setup();

    scheduler.register('job', { class: 'automation', ...handler() });
    scheduler.open();
    ask('job', 'a', 0);
    ask('job', 'b', 0);
    ask('job', 'c', 0);

    expect(clock.timers.filter((timer) => timer.unref)).toHaveLength(1);
    expect(clock.wakes()).toEqual([100]);
  });

  it('never lowers a gate raised while it ran, when the run defers to an earlier time', async () => {
    const { clock, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    ask('job', 'k', 0, 600_000);
    calls[0].fail(new Defer(at(60_000)));
    await flush();

    expect(row()).toMatchObject({ notBefore: at(600_000), attempts: 0 });
  });

  it('keeps a row for a gate raised while it ran, though nothing more is asked', async () => {
    const { clock, store, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    // Another writer raises the gate, asking for nothing.
    store.scheduledWork.update(row()!, { notBefore: at(600_000) });
    calls[0].answer(null);
    await flush();

    expect(row()).toMatchObject({ requestedAt: null, notBefore: at(600_000), claimedBy: null });
    expect(clock.wakes()).toEqual([]);
  });

  it('never settles over a row made again while it ran', async () => {
    const { clock, store, scheduler, ask, row, at, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    // Its account's data cleared, and the work asked for anew.
    store.scheduledWork.delete({ kind: 'job', key: 'k' });
    ask('job', 'k', 30_000);
    calls[0].answer(null);
    await flush();

    expect(row()).toMatchObject({ requestedAt: at(30_000), claimedBy: null });
    expect(clock.wakes()).toEqual([30_000]);
  });

  it('arms no retry once closed, when a stopped run cannot be settled', async () => {
    const { clock, store, scheduler, ask, row, flush } = setup();
    const { run } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();

    const fail = () => {
      throw new Error('disk I/O error');
    };

    vi.spyOn(store.scheduledWork, 'update').mockImplementation(fail);
    vi.spyOn(store.scheduledWork, 'delete').mockImplementation(fail);
    await scheduler.close();

    expect(row()).toMatchObject({ claimedBy: 'boot-1' });
    expect(clock.wakes()).toEqual([]);
  });

  it('releases work a process that is gone had claimed, with what was asked meanwhile', async () => {
    const { clock, store, scheduler, at, row, flush } = setup('boot-2');
    const { run } = handler();
    const now = at(0);

    store.db
      .insert(scheduledWork)
      .values({
        kind: 'job',
        key: 'k',
        account: 'you',
        class: 'automation',
        requestedAt: at(50_000),
        rearmAt: at(20_000),
        claimedBy: 'boot-1',
        claimedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    scheduler.register('job', { class: 'automation', run });
    scheduler.open();

    expect(row()).toMatchObject({ claimedBy: null, rearmAt: null, requestedAt: at(20_000) });
    expect(clock.wakes()).toEqual([20_000]);

    clock.wall += 20_000;
    clock.fire();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('drops rows kept only for a gate that has passed when it opens', () => {
    const { store, scheduler, at, row } = setup();
    const now = at(0);

    store.db
      .insert(scheduledWork)
      .values([
        {
          kind: 'job',
          key: 'past',
          class: 'automation',
          notBefore: at(-1),
          createdAt: now,
          updatedAt: now,
        },
        {
          kind: 'job',
          key: 'ahead',
          class: 'automation',
          notBefore: at(60_000),
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    scheduler.register('job', { class: 'automation', ...handler() });
    scheduler.open();

    expect(row('job', 'past')).toBeUndefined();
    expect(row('job', 'ahead')).toMatchObject({ requestedAt: null, notBefore: at(60_000) });
  });

  it('stops a run on close, releasing it as it was, and arms nothing', async () => {
    const { clock, scheduler, ask, row, at, flush } = setup();
    const run = vi.fn(
      (_: Work, signal: AbortSignal) =>
        new Promise<{ next: string | null }>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Aborted()));
        }),
    );

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    await scheduler.close();

    expect(row()).toMatchObject({
      requestedAt: at(0),
      claimedBy: null,
      attempts: 0,
      notBefore: null,
    });
    expect(clock.wakes()).toEqual([]);

    ask('job', 'k', 0);

    expect(clock.wakes()).toEqual([]);
  });

  it('looks again within a second when it cannot read what is due', () => {
    const { clock, store, scheduler, ask } = setup();
    const runnable = store.scheduledWork.runnable.bind(store.scheduledWork);
    let failed = false;

    scheduler.register('job', { class: 'automation', ...handler() });
    scheduler.open();
    vi.spyOn(store.scheduledWork, 'runnable').mockImplementation(() => {
      if (!failed) {
        failed = true;

        throw new Error('disk I/O error');
      }

      return runnable();
    });

    const warn = vi.spyOn(log, 'event');

    expect(() => ask('job', 'k', 0)).not.toThrow();
    expect(warn.mock.calls.filter(([, event]) => event === 'scheduler.wake-failed')).toHaveLength(
      1,
    );
    expect(clock.wakes()).toEqual([1000]);
  });

  it('retries a settlement whose write failed, never the work', async () => {
    const { clock, store, scheduler, ask, row, flush } = setup();
    const { run, calls } = handler();
    const update = store.scheduledWork.update.bind(store.scheduledWork);
    let failures = 1;

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();
    vi.spyOn(store.scheduledWork, 'update').mockImplementation((target, values) => {
      if (values.claimedBy === null && failures-- > 0) throw new Error('disk I/O error');

      update(target, values);
    });
    calls[0].fail(new Defer(new Date(clock.wall + 60_000).toISOString()));
    await flush();

    expect(row()).toMatchObject({ claimedBy: 'boot-1' });
    expect(clock.wakes()).toEqual([1000]);

    clock.fire();
    await flush();

    expect(row()).toMatchObject({ claimedBy: null });
    expect(run).toHaveBeenCalledTimes(1);
    expect(clock.wakes()).toEqual([60_000]);
  });

  it('leaves a settlement that keeps failing to the next start, never holding up close', async () => {
    const { clock, store, scheduler, ask, row, flush } = setup();
    const { run, calls } = handler();

    scheduler.register('job', { class: 'automation', run });
    scheduler.open();
    ask('job', 'k', 0);
    clock.fire();
    await flush();

    const fail = () => {
      throw new Error('disk I/O error');
    };
    const failing = [
      vi.spyOn(store.scheduledWork, 'update').mockImplementation(fail),
      vi.spyOn(store.scheduledWork, 'delete').mockImplementation(fail),
    ];

    calls[0].answer(null);
    await flush();

    expect(clock.wakes()).toEqual([1000]);

    await scheduler.close();

    expect(row()).toMatchObject({ claimedBy: 'boot-1' });
    // The retry was cancelled with the rest.
    expect(clock.wakes()).toEqual([]);

    for (const spy of failing) spy.mockRestore();

    const next = setup('boot-2', { store, clock });
    const again = handler();

    next.scheduler.register('job', { class: 'automation', run: again.run });
    next.scheduler.open();

    expect(row()).toMatchObject({ claimedBy: null });

    clock.fire();
    await flush();

    expect(again.run).toHaveBeenCalledTimes(1);
  });
});
