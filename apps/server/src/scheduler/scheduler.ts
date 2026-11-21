import { performance } from 'node:perf_hooks';
import { isoNow, type Cancel, type Clock } from '@/clock.js';
import { deadlineOf, earlier, later, type WorkRow } from '@/db/scheduled-work.js';
import type { Store } from '@/db/store.js';
import { log } from '@/log.js';
import { safeError } from '@/redact.js';

/** How many runs of each class go at once. */
export const CLASS_LIMITS = { automation: 1, history: 1 } as const;

export type WorkClass = keyof typeof CLASS_LIMITS;

/** Thrown by a handler whose work cannot run before `until` (a cooldown): no attempt counts. */
export class Defer extends Error {
  constructor(readonly until: string) {
    super(`Not before ${until}.`);
    this.name = 'Defer';
  }
}

/** Thrown by a handler told to stop: its work is released as it was, to run again. */
export class Aborted extends Error {
  constructor() {
    super('Stopped before it finished.');
    this.name = 'Aborted';
  }
}

/** What a handler is asked to do: its row's kind, key and account. */
export interface Work {
  kind: string;
  key: string;
  account: string | null;
}

export interface WorkHandler {
  class: WorkClass;
  /**
   * Does the work, reading what is due from its own domain: a row is a wake-up, never the work's
   * state, so a run that finds nothing to do is harmless. Resolves with when it is next wanted,
   * or null. Rejects with `Defer` to wait for a time, `Aborted` once `signal` aborts.
   */
  run(work: Work, signal: AbortSignal): Promise<{ next: string | null }>;
}

type Outcome =
  | { kind: 'next'; next: string | null }
  | { kind: 'defer'; until: string }
  | { kind: 'fail'; error: unknown }
  | { kind: 'release' };

interface Run {
  work: Work;
  class: WorkClass;
  controller: AbortController;
  /** The handler, then the first attempt to settle its row. */
  done: Promise<void>;
  /** A retry of a settlement whose write failed, while one is armed. */
  retry: Cancel | null;
}

/** The soonest a wake runs: requests made together are picked up as one. */
const MIN_WAKE_MS = 100;
/** The longest a wake sleeps: wall time can jump meanwhile, so it looks again by then. */
const MAX_SLEEP_MS = 5 * 60_000;
/** How soon a wake looks again after it could not read what is due. */
const WAKE_RETRY_MS = 1000;
const SETTLE_RETRY_MS = 1000;
const MAX_SETTLE_RETRY_MS = 30_000;

/** How long a failed run waits before its `attempts`th retry: 30 s, doubling, at most 30 min. */
export const backoff = (attempts: number) =>
  Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

const idOf = (work: Pick<Work, 'kind' | 'key'>) => `${work.kind}\u0000${work.key}`;

/** Held back at `now` by a gate still ahead. */
const gated = (notBefore: string | null, now: number) =>
  notBefore !== null && Date.parse(notBefore) > now;

/**
 * Runs background work at its due time (`scheduled_work`). Each row is a durable wake-up: its
 * handler decides from its own domain's state, so the row is never the truth, and work claimed by
 * a process that is gone is released and run again. One timer, armed for the earliest row a class
 * has room for, and for nothing while no row waits.
 */
export class Scheduler {
  private readonly handlers = new Map<string, WorkHandler>();
  private readonly runs = new Map<string, Run>();
  private opened = false;
  private closed = false;
  private cancelWake: Cancel | null = null;
  /** When the armed wake fires, on the monotonic clock; null while none is armed. */
  private wakeAt: number | null = null;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    /** This process's boot id, which its claims carry. */
    private readonly bootId: string,
  ) {}

  private get rows() {
    return this.store.scheduledWork;
  }

  register(kind: string, handler: WorkHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Asks for the work by `at`, not before `notBefore`, in the caller's transaction: the earliest
   * ask wins, a gate is only ever raised, and the timer is armed once it commits.
   */
  request(
    kind: string,
    key: string,
    ask: { account: string | null; at: string; notBefore?: string | null },
  ): void {
    const handler = this.handlers.get(kind);

    if (!handler) throw new Error(`Nothing runs ${kind}.`);

    this.rows.request(kind, key, { ...ask, class: handler.class }, isoNow(this.clock));
    this.store.afterCommit(() => this.wake());
  }

  /**
   * Releases work a previous process claimed, as it was (with what was asked meanwhile), drops
   * rows kept only for a gate that has passed, then arms. Called once this process owns the data
   * directory.
   */
  open(): void {
    if (this.opened || this.closed) return;

    const now = this.clock.now();
    const at = isoNow(this.clock);

    this.store.transaction(() => {
      for (const row of this.rows.claimedElsewhere(this.bootId))
        this.rows.update(row, {
          claimedBy: null,
          claimedAt: null,
          rearmAt: null,
          requestedAt: earlier(row.requestedAt, row.rearmAt),
          updatedAt: at,
        });

      for (const row of this.rows.all())
        if (row.claimedBy === null && row.requestedAt === null && !gated(row.notBefore, now))
          this.rows.delete(row);
    });
    this.opened = true;
    this.wake();
  }

  /**
   * Starts nothing more, tells every run to stop, and waits for each to end and try to settle.
   * A settlement still failing is left: the next start releases its claim.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.disarm();

    for (const run of this.runs.values()) {
      run.controller.abort();
      run.retry?.();
      run.retry = null;
    }

    await Promise.allSettled([...this.runs.values()].map((run) => run.done));
  }

  /** Arms the timer for the earliest row that could run. Never throws. */
  private wake(): void {
    if (!this.opened || this.closed) return;

    let delay: number | null;

    try {
      delay = this.nextDelay();
    } catch {
      // Looked at again soon, or when the wake already armed fires. Nothing of the error is kept.
      log.event('warn', 'scheduler.wake-failed', {});

      if (this.cancelWake) return;

      delay = WAKE_RETRY_MS;
    }

    if (delay === null) {
      this.disarm();

      return;
    }

    // Compared on the monotonic clock: a jump of wall time cannot keep a late wake.
    const fireAt = performance.now() + delay;

    if (this.cancelWake && this.wakeAt !== null && this.wakeAt <= fireAt) return;

    this.disarm();
    this.wakeAt = fireAt;
    this.cancelWake = this.clock.after(
      delay,
      () => {
        this.cancelWake = null;
        this.wakeAt = null;
        this.dispatch();
      },
      { unref: true },
    );
  }

  private disarm(): void {
    this.cancelWake?.();
    this.cancelWake = null;
    this.wakeAt = null;
  }

  /** How long until a row could start, in ms: 100 ms at least, 5 min at most. Null for none. */
  private nextDelay(): number | null {
    const now = this.clock.now();
    let earliest = Infinity;

    for (const row of this.rows.runnable()) {
      if (!this.startable(row)) continue;

      const deadline = Date.parse(deadlineOf(row)!);

      if (!Number.isNaN(deadline)) earliest = Math.min(earliest, deadline);
    }

    if (earliest === Infinity) return null;

    return Math.min(MAX_SLEEP_MS, Math.max(MIN_WAKE_MS, earliest - now));
  }

  /** Run here, and its class has room. */
  private startable(row: WorkRow): boolean {
    const handler = this.handlers.get(row.kind);

    if (!handler) return false;

    let busy = 0;

    for (const run of this.runs.values()) if (run.class === handler.class) busy++;

    return busy < CLASS_LIMITS[handler.class];
  }

  /** Starts every due row its class has room for, earliest first, then arms for the next. */
  private dispatch(): void {
    if (!this.opened || this.closed) return;

    try {
      const now = this.clock.now();
      const due = this.rows
        .runnable()
        .map((row) => ({ row, deadline: Date.parse(deadlineOf(row)!) }))
        .filter(({ deadline }) => deadline <= now)
        .sort((left, right) => left.deadline - right.deadline);

      for (const { row } of due) if (this.startable(row)) this.start(row);
    } catch {
      log.event('warn', 'scheduler.wake-failed', {});
    }

    this.wake();
  }

  private start(row: WorkRow): void {
    const handler = this.handlers.get(row.kind)!;
    const work: Work = { kind: row.kind, key: row.key, account: row.account };
    const controller = new AbortController();

    this.rows.claim(row, this.bootId, isoNow(this.clock));

    const run: Run = {
      work,
      class: handler.class,
      controller,
      done: Promise.resolve(),
      retry: null,
    };

    this.runs.set(idOf(work), run);
    run.done = Promise.resolve()
      .then(() => handler.run(work, controller.signal))
      .then(
        (result): Outcome => ({ kind: 'next', next: result.next }),
        (error: unknown): Outcome =>
          controller.signal.aborted || error instanceof Aborted
            ? { kind: 'release' }
            : error instanceof Defer
              ? { kind: 'defer', until: error.until }
              : { kind: 'fail', error },
      )
      .then((outcome) => this.settle(run, outcome, 0));
  }

  /**
   * Saves how the run ended, read against the row as it is now: a request or gate written while
   * it ran stays. A write that fails is retried, never the work, while this process is open.
   */
  private settle(run: Run, outcome: Outcome, retries: number): void {
    try {
      this.store.transaction(() => this.apply(run.work, outcome));
    } catch {
      log.event('warn', 'scheduler.settle-failed', {});

      // Its slot stays taken until it settles; once closed, the next start releases the claim.
      if (this.closed) return;

      run.retry = this.clock.after(
        Math.min(MAX_SETTLE_RETRY_MS, SETTLE_RETRY_MS * 2 ** retries),
        () => {
          run.retry = null;

          if (!this.closed) this.settle(run, outcome, retries + 1);
        },
        { unref: true },
      );

      return;
    }

    this.runs.delete(idOf(run.work));
    this.wake();
  }

  private apply(work: Work, outcome: Outcome): void {
    const live = this.rows.get(work.kind, work.key);

    // Gone (its account's data cleared meanwhile), or no longer this run's: nothing to settle.
    if (!live || live.claimedBy !== this.bootId) return;

    const now = this.clock.now();
    // What was asked and not yet served: the request it ran for, and any made while it ran.
    const kept = earlier(live.requestedAt, live.rearmAt);
    const values: Partial<WorkRow> = {
      claimedBy: null,
      claimedAt: null,
      rearmAt: null,
      requestedAt: kept,
      updatedAt: isoNow(this.clock),
    };

    if (outcome.kind === 'next') {
      values.requestedAt = earlier(outcome.next, live.rearmAt);
      values.attempts = 0;
      values.lastError = null;
    } else if (outcome.kind === 'defer') {
      values.notBefore = later(live.notBefore, outcome.until);
    } else if (outcome.kind === 'fail') {
      const attempts = live.attempts + 1;

      values.attempts = attempts;
      values.lastError = safeError(outcome.error);
      values.notBefore = later(live.notBefore, new Date(now + backoff(attempts)).toISOString());
    }

    const notBefore = values.notBefore === undefined ? live.notBefore : values.notBefore;

    // Nothing asked, nothing held back: done with.
    if (values.requestedAt === null && !gated(notBefore, now)) this.rows.delete(live);
    else this.rows.update(live, values);
  }
}
