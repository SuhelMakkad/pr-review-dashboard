import { expect } from 'vitest';

/** Stops a timer, as the server's `Cancel` does. */
type Cancel = () => void;

export interface RecordedTimer {
  ms: number;
  run: () => void;
  unref: boolean;
  done: boolean;
}

/**
 * Timers that fire only when a test fires them, as the server's `Clock` (which it satisfies by
 * shape). Wall time is `wall`, moved by hand, or another clock's (a `TestClock` the rest of the
 * app reads), so only these timers are held.
 */
export class RecordingClock {
  wall = Date.parse('2026-11-05T10:00:00Z');
  readonly timers: RecordedTimer[] = [];

  constructor(private readonly wallClock?: { now(): number }) {}

  now(): number {
    return this.wallClock ? this.wallClock.now() : this.wall;
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

  /** The delays of the wakes still armed: the unref'd timers, which only wakes use. */
  wakes(): number[] {
    return this.timers.filter((timer) => timer.unref && !timer.done).map((timer) => timer.ms);
  }

  /** Fires the one wake armed. */
  fire(): void {
    const armed = this.timers.filter((timer) => timer.unref && !timer.done);

    expect(armed).toHaveLength(1);

    armed[0].done = true;
    armed[0].run();
  }
}
