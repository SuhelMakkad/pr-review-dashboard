import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { overCap, type TextPatch } from '@/diff/patch.js';

/** A patch whose caller stopped waiting: the work is dropped, never published. */
export class PatchAborted extends Error {
  constructor() {
    super('The diff was cancelled.');
    this.name = 'AbortError';
  }
}

/** The pool was closed (shutdown): nothing more is patched. */
export class PoolClosed extends Error {
  constructor() {
    super('The server is restarting. Try again shortly.');
    this.name = 'PoolClosed';
  }
}

interface Task {
  oldText: string;
  newText: string;
  resolve: (patch: TextPatch | null) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  /** Told to stop (aborted, idle or closing): still counted until it exits. */
  stopping: boolean;
  /** What it crashed with, if it did: its task's failure. */
  failure: Error | null;
  idle: NodeJS.Timeout | null;
  exited: Promise<void>;
}

const failure = (error: unknown) =>
  error instanceof Error ? error : new Error('The diff worker could not start.');

/** Where the worker is: built JavaScript, or TypeScript source run through tsx (dev, tests). */
function entry(): { url: URL; execArgv: string[] } {
  const source = import.meta.url.endsWith('.ts');

  return {
    url: new URL(source ? './patch-worker.ts' : './patch-worker.js', import.meta.url),
    execArgv: source ? ['--import', 'tsx'] : [],
  };
}

/**
 * Computes patches off the event loop: a bounded set of worker threads, started when first
 * needed. A pair is sent only to a worker that is free, so nothing queues inside one. Aborting a
 * patch drops it while it waits, or stops its worker while it runs. Workers keep the process alive
 * only while they work, and end after a while idle.
 */
export class PatchPool {
  private readonly slots = new Set<Slot>();
  private readonly waiting: Task[] = [];
  private closing: Promise<void> | null = null;
  readonly size: number;
  private readonly idleMs: number;
  private readonly worker: { url: URL; execArgv: string[] };

  constructor(
    options: {
      size?: number;
      idleMs?: number;
      /** The worker to run: the patch worker, unless a test stands one in. */
      worker?: { url: URL; execArgv: string[] };
    } = {},
  ) {
    this.size = options.size ?? Math.max(1, Math.min(2, availableParallelism() - 1));
    this.idleMs = options.idleMs ?? 30_000;
    this.worker = options.worker ?? entry();
  }

  /** The patch of `oldText` to `newText`, as `textPatch` computes it; null when too large. */
  patch(oldText: string, newText: string, signal?: AbortSignal): Promise<TextPatch | null> {
    if (this.closing) return Promise.reject(new PoolClosed());
    if (signal?.aborted) return Promise.reject(new PatchAborted());
    // Too large to patch: decided here, never copied to a worker.
    if (overCap(oldText, newText)) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      const task: Task = { oldText, newText, resolve, reject, signal };

      if (signal) {
        task.onAbort = () => this.abort(task);
        signal.addEventListener('abort', task.onAbort, { once: true });
      }

      this.waiting.push(task);
      this.dispatch();
    });
  }

  /**
   * Rejects what waits and what runs, stops every worker, and resolves once all have exited. Once
   * called, nothing more is patched.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const task of this.waiting.splice(0)) this.settle(task, new PoolClosed());

      for (const slot of this.slots) {
        if (slot.task) this.settle(slot.task, new PoolClosed());

        slot.task = null;
        this.stop(slot);
      }

      await Promise.all([...this.slots].map((slot) => slot.exited));
    })();

    return this.closing;
  }

  /** Workers, busy or stopping, that count against the size. */
  get workers(): number {
    return this.slots.size;
  }

  /**
   * Hands waiting pairs to free workers, starting one where the size allows. It never throws (it
   * also runs from a worker's exit): a worker that cannot start, or take its pair, fails that pair.
   */
  private dispatch(): void {
    while (this.waiting.length > 0 && !this.closing) {
      let slot = [...this.slots].find((candidate) => !candidate.task && !candidate.stopping);

      if (!slot && this.slots.size >= this.size) return;

      const task = this.waiting.shift()!;

      try {
        slot ??= this.start();
      } catch (error) {
        this.settle(task, failure(error));

        continue;
      }

      if (slot.idle) clearTimeout(slot.idle);

      slot.idle = null;
      slot.task = task;
      slot.worker.ref();

      try {
        slot.worker.postMessage({ oldText: task.oldText, newText: task.newText });
      } catch (error) {
        // Not this worker's to run: it stops, and the next pair gets a fresh one.
        slot.task = null;
        this.settle(task, failure(error));
        this.stop(slot);
      }
    }
  }

  private start(): Slot {
    const worker = new Worker(this.worker.url, { execArgv: this.worker.execArgv });
    let exited!: () => void;
    const slot: Slot = {
      worker,
      task: null,
      stopping: false,
      failure: null,
      idle: null,
      exited: new Promise((resolve) => (exited = resolve)),
    };

    worker.on('message', (patch: TextPatch | null) => {
      const task = slot.task;

      slot.task = null;

      if (task) this.settle(task, null, patch);

      this.rest(slot);
      this.dispatch();
    });
    // A crash is reported as its own error: kept, and its task failed with it once it exits.
    worker.on('error', (error) => {
      slot.failure = error;
    });
    worker.on('exit', () => {
      // A turn later, so an `error` sent as it exited is known first.
      setImmediate(() => {
        const task = slot.task;

        slot.task = null;

        if (slot.idle) clearTimeout(slot.idle);
        if (task) this.settle(task, slot.failure ?? new Error('The diff worker stopped.'));

        this.slots.delete(slot);
        exited();
        // A stopped worker frees its place for the next waiter.
        this.dispatch();
      });
    });

    this.slots.add(slot);

    return slot;
  }

  /** A worker with nothing to do: it no longer holds the process, and ends after a while. */
  private rest(slot: Slot): void {
    if (slot.task || slot.stopping) return;

    slot.worker.unref();
    slot.idle = setTimeout(() => this.stop(slot), this.idleMs);
    slot.idle.unref();
  }

  private stop(slot: Slot): void {
    if (slot.stopping) return;

    slot.stopping = true;
    void slot.worker.terminate();
  }

  private abort(task: Task): void {
    const index = this.waiting.indexOf(task);

    if (index !== -1) {
      this.waiting.splice(index, 1);
      this.settle(task, new PatchAborted());

      return;
    }

    for (const slot of this.slots)
      if (slot.task === task) {
        // Its worker is stopped mid-patch: it counts until it exits, and is then replaced.
        slot.task = null;
        this.settle(task, new PatchAborted());
        this.stop(slot);
      }
  }

  private settle(task: Task, error: Error | null, patch: TextPatch | null = null): void {
    if (task.onAbort) task.signal?.removeEventListener('abort', task.onAbort);

    if (error) task.reject(error);
    else task.resolve(patch);
  }
}
