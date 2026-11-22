import { afterEach, describe, expect, it, vi } from 'vitest';
import { textPatch } from '@/diff/patch.js';
import { PatchAborted, PatchPool, PoolClosed } from '@/diff/patch-pool.js';

const pools: PatchPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
});

/** A pool of the real patch worker, run from source as dev and tests run it. */
const real = (size = 2) => {
  const pool = new PatchPool({ size });

  pools.push(pool);

  return pool;
};

/** A pool of a stand-in worker that answers after `delay:<ms>`, and crashes on `crash`. */
const standIn = (size = 1, idleMs = 30_000) => {
  const pool = new PatchPool({
    size,
    idleMs,
    worker: {
      url: new URL('../../../tests/fixtures/slow-patch-worker.mjs', import.meta.url),
      execArgv: [],
    },
  });

  pools.push(pool);

  return pool;
};

const lines = (count: number, change: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => change(index)).join('\n');

describe('the patch pool', () => {
  it('patches as textPatch does, off the event loop', async () => {
    const pool = real();
    const pairs = [
      ['a\nb\nc\n', 'a\nB\nc\n'],
      ['', 'added\n'],
      ['removed\n', ''],
      [
        lines(400, (index) => `line ${index}`),
        lines(400, (index) => (index % 7 ? `line ${index}` : `changed ${index}`)),
      ],
    ];

    for (const [before, after] of pairs)
      expect(await pool.patch(before, after)).toEqual(textPatch(before, after));
  });

  it('decides a pair too large to patch without sending it to a worker', async () => {
    const pool = real();
    const huge = 'x'.repeat(1_000_001);

    expect(await pool.patch(huge, 'small')).toBeNull();
    expect(pool.workers).toBe(0);
  });

  it('sends a pair only to a free worker, in order, never more workers than its size', async () => {
    const pool = standIn(2);
    const order: string[] = [];
    const patches = ['delay:60', 'delay:10', 'delay:10', 'delay:10'].map((text, index) =>
      pool.patch(text, `${index}`).then((patch) => order.push(patch!.patch)),
    );

    await vi.waitFor(() => expect(pool.workers).toBe(2));
    await Promise.all(patches);

    expect(pool.workers).toBeLessThanOrEqual(2);
    // The second and later pairs went to the worker that freed first.
    expect(order).toEqual(['delay:10 -> 1', 'delay:10 -> 2', 'delay:10 -> 3', 'delay:60 -> 0']);
  });

  it('drops a waiting pair when its caller stops waiting', async () => {
    const pool = standIn(1);
    const controller = new AbortController();
    const running = pool.patch('delay:50', 'first');
    const waiting = pool.patch('delay:0', 'second', controller.signal);

    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(PatchAborted);
    expect((await running)!.patch).toBe('delay:50 -> first');
  });

  it('stops the worker of a running pair when its caller stops waiting, and replaces it', async () => {
    const pool = standIn(1);
    const controller = new AbortController();
    const running = pool.patch('delay:5000', 'slow', controller.signal);

    await vi.waitFor(() => expect(pool.workers).toBe(1));

    const next = pool.patch('delay:0', 'next');

    controller.abort();

    await expect(running).rejects.toBeInstanceOf(PatchAborted);
    // The next pair waits for the stopped worker to exit, then a fresh one serves it.
    expect((await next)!.patch).toBe('delay:0 -> next');
    expect(pool.workers).toBe(1);
  });

  it('fails a pair whose worker crashed, and serves the next with a fresh one', async () => {
    const pool = standIn(1);

    await expect(pool.patch('crash', 'x')).rejects.toThrow('The worker crashed.');
    expect((await pool.patch('delay:0', 'after'))!.patch).toBe('delay:0 -> after');
  });

  it('ends a worker idle for long enough', async () => {
    const pool = standIn(1, 50);

    await pool.patch('delay:0', 'x');

    expect(pool.workers).toBe(1);

    await vi.waitFor(() => expect(pool.workers).toBe(0), { timeout: 2000 });
  });

  it('settles what waits and what runs on close, and patches nothing after', async () => {
    const pool = standIn(1);
    const running = pool.patch('delay:5000', 'slow');
    const waiting = pool.patch('delay:0', 'next');
    // Heard before closing, so neither rejection is left unhandled.
    const settled = Promise.all([
      expect(running).rejects.toBeInstanceOf(PoolClosed),
      expect(waiting).rejects.toBeInstanceOf(PoolClosed),
    ]);

    await vi.waitFor(() => expect(pool.workers).toBe(1));
    await pool.close();
    await settled;

    await expect(pool.patch('a', 'b')).rejects.toBeInstanceOf(PoolClosed);
    expect(pool.workers).toBe(0);
    // Closing again settles the same way.
    await pool.close();
  });
});
