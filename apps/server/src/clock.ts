/** Stops a timer from firing again. */
export type Cancel = () => void;

/**
 * Wall time and timers, injected so a test can move time without touching the process's clock.
 * One app has one clock (`SyncService.clock`). Work that is paced or measured by elapsed time
 * uses `performance.now()` instead, so a wall-clock jump cannot stall it.
 */
export interface Clock {
  /** Wall time, in epoch milliseconds. */
  now(): number;
  /** Runs `run` once after `ms`. The timer keeps the process alive unless `unref` is set. */
  after(ms: number, run: () => void, options?: { unref?: boolean }): Cancel;
  /** Runs `run` every `ms` on a fixed cadence, however long each run takes. */
  every(ms: number, run: () => void): Cancel;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, run, options) {
    const timer = setTimeout(run, ms);

    if (options?.unref) timer.unref();

    return () => clearTimeout(timer);
  },
  every(ms, run) {
    const timer = setInterval(run, ms);

    return () => clearInterval(timer);
  },
};

/** The clock's time as rows store it. */
export function isoNow(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/**
 * For tests: wall time that `advance` and `set` move by hand, over real timers. Only what reads
 * this clock sees the change; the process's own clock is untouched.
 */
export class TestClock implements Clock {
  private offset = 0;

  constructor(start?: number) {
    if (start !== undefined) this.set(start);
  }

  now(): number {
    return Date.now() + this.offset;
  }

  advance(ms: number): void {
    this.offset += ms;
  }

  set(epochMs: number): void {
    this.offset = epochMs - Date.now();
  }

  after(ms: number, run: () => void, options?: { unref?: boolean }): Cancel {
    return systemClock.after(ms, run, options);
  }

  every(ms: number, run: () => void): Cancel {
    return systemClock.every(ms, run);
  }
}
