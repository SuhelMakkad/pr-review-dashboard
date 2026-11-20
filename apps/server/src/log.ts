import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';
import pino from 'pino';

/**
 * The server's log: typed events only, each with a fixed set of fields whose values are numbers,
 * booleans, or strings from a closed set (route templates, operation names, error codes). There
 * is no free-text message, so nothing a user wrote, no path, URL, login or token can reach the
 * file. Everything logs through `log.event`; nothing else in the server uses pino.
 */

type Field = 'number' | 'boolean' | 'route' | readonly string[] | RegExp;
type Schema = Record<string, Field>;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const FORGES = ['github', 'gitlab'] as const;
/**
 * Routes as the server declares them (`/api/pulls/:id`), collected as they are registered: a
 * route field is one of these or `other`, never a request's own path.
 */
export const knownRoutes = new Set<string>();
/** An error's code, such as `rate_limit` or `HEAD_MOVED`, never its message. */
const CODE = /^[A-Za-z_]{1,40}$/;

/** Operations the forges are asked to do, by name; anything else is `other`. */
export const FORGE_OPS = [
  // GitHub GraphQL documents, by operation name.
  'AddComment',
  'AddPendingReview',
  'AddReviewThread',
  'ApproveReview',
  'Blobs',
  'Checks',
  'CommentNow',
  'Comments',
  'ConversationPage',
  'DeleteReview',
  'Detect',
  'Discover',
  'History',
  'Identity',
  'MarkFileViewed',
  'Page',
  'ReplyToThread',
  'RequestReviews',
  'Rereview',
  'ResolvePull',
  'ResolveThread',
  'ReviewReceipt',
  'Search',
  'Snapshot',
  'SubmitReview',
  'UnmarkFileViewed',
  'UnresolveThread',
  'graphql',
  // GitHub REST, by path shape.
  'pulls.files',
  'pulls.get',
  'compare',
  'tarball',
  'issue.comments',
  'git.ref',
  'rate_limit',
  'user',
  'teams',
  // GitLab, by resource.
  'mr',
  'mr.discussions',
  'mr.notes',
  'mr.versions',
  'mr.diffs',
  'mr.approvals',
  'mr.approve',
  'mr.unapprove',
  'mr.reviewers',
  'mr.draft_notes',
  'mr.other',
  'merge_requests',
  'repository.branch',
  'repository.compare',
  'repository.merge_base',
  'repository.commit',
  'repository.archive',
  'repository.files',
  'pipeline.jobs',
  'todos',
  'version',
  'other',
] as const;

export type ForgeOp = (typeof FORGE_OPS)[number];

const schemas = {
  'server.started': { mode: ['production', 'development', 'demo'], port: 'number' },
  'server.stopped': { clean: 'boolean' },
  'http.request': { route: 'route', method: METHODS, status: 'number', ms: 'number' },
  'forge.request': {
    forge: FORGES,
    op: FORGE_OPS,
    credentialMs: 'number',
    spawnMs: 'number',
    childMs: 'number',
    totalMs: 'number',
    code: 'number',
    timedOut: 'boolean',
    bytes: 'number',
  },
  'sync.completed': {
    forge: FORGES,
    trigger: ['interval', 'manual', 'switch', 'start', 'other'],
    outcome: CODE,
    discoveryMs: 'number',
    detectionMs: 'number',
    fetchMs: 'number',
    totalMs: 'number',
    candidates: 'number',
    fetched: 'number',
    changed: 'number',
    failed: 'number',
    concurrency: 'number',
    fetchSumMs: 'number',
    fetchMaxMs: 'number',
  },
  'loop.delay': { p50: 'number', p99: 'number', max: 'number', count: 'number' },
  'ai.archive': {
    side: ['before', 'after'],
    bytes: 'number',
    downloadMs: 'number',
    extractMs: 'number',
  },
  'log.dropped': { count: 'number' },
} as const satisfies Record<string, Schema>;

export type LogEvent = keyof typeof schemas;

type ValueOf<F> = F extends 'number'
  ? number
  : F extends 'boolean'
    ? boolean
    : F extends 'route'
      ? string
      : F extends readonly (infer S)[]
        ? S
        : string;

export type EventFields<E extends LogEvent> = {
  [K in keyof (typeof schemas)[E]]?: ValueOf<(typeof schemas)[E][K]>;
};

export type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * The fields of one record, as the schema allows them. A number is rounded to a tenth; a string
 * outside its closed set becomes `other`; a field the schema does not name is left out.
 */
export function allowed(event: LogEvent, fields: Record<string, unknown>): Record<string, unknown> {
  const schema: Schema = schemas[event];
  const record: Record<string, unknown> = {};

  for (const [name, kind] of Object.entries(schema)) {
    const value = fields[name];

    if (value === undefined || value === null) continue;

    if (kind === 'number') {
      if (typeof value === 'number' && Number.isFinite(value))
        record[name] = Math.round(value * 10) / 10;
    } else if (kind === 'boolean') {
      if (typeof value === 'boolean') record[name] = value;
    } else if (kind === 'route') {
      record[name] = typeof value === 'string' && knownRoutes.has(value) ? value : 'other';
    } else if (kind instanceof RegExp) {
      record[name] = typeof value === 'string' && kind.test(value) ? value : 'other';
    } else {
      record[name] = typeof value === 'string' && kind.includes(value) ? value : 'other';
    }
  }

  return record;
}

/** Where log lines go; `LogFile` in the server, an array in tests. */
export interface LogDestination {
  write(line: string): void;
}

class EventLog {
  private logger: pino.Logger = pino({ level: 'silent' });

  /** Starts writing to `destination` from `level` up; until then, nothing is written. */
  open(destination: LogDestination, level: string = 'info'): void {
    this.logger = pino(
      {
        level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
      },
      destination,
    );
  }

  /** Writes nothing more; the destination itself is closed by its owner. */
  silence(): void {
    this.logger = pino({ level: 'silent' });
  }

  isLevelEnabled(level: Level): boolean {
    return this.logger.isLevelEnabled(level);
  }

  event<E extends LogEvent>(level: Level, event: E, fields: EventFields<E>): void {
    if (!this.logger.isLevelEnabled(level)) return;

    this.logger[level]({ event, ...allowed(event, fields as Record<string, unknown>) });
  }
}

/** The server's log. Silent until `index.ts` opens it on the data directory's log file. */
export const log = new EventLog();

export interface LogFileOptions {
  /** A file over this size is rotated (checked at start and every `checkEveryMs`). */
  rotateAtBytes?: number;
  /** Rotated files kept: `.1` (newest) to `.keep`. */
  keep?: number;
  /** Bytes handed to the file and not yet written, past which a record is dropped. */
  budgetBytes?: number;
  checkEveryMs?: number;
  /** Opens the file's stream; tests replace it. */
  openStream?: (path: string) => Writable;
  warn?: (message: string) => void;
}

/**
 * The log file in the data directory, owned by the process that holds its lock. It rotates past
 * a size threshold, keeps a few old files, and never lets pending writes grow past a budget: a
 * slow or failing disk loses records (counted), never memory, and never stops the app.
 */
export class LogFile implements LogDestination {
  private stream: Writable | null = null;
  private pending = 0;
  private dropped = 0;
  private buffered: string[] = [];
  private rotating = false;
  private failed = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Rotation and closing, one after another. */
  private chain: Promise<void> = Promise.resolve();
  private readonly rotateAt: number;
  private readonly keep: number;
  private readonly budget: number;
  private readonly checkEvery: number;
  private readonly openStream: (path: string) => Writable;
  private readonly warn: (message: string) => void;

  constructor(
    readonly path: string,
    options: LogFileOptions = {},
  ) {
    this.rotateAt = options.rotateAtBytes ?? 10 * 1024 * 1024;
    this.keep = options.keep ?? 5;
    this.budget = options.budgetBytes ?? 1024 * 1024;
    this.checkEvery = options.checkEveryMs ?? 60_000;
    this.openStream =
      options.openStream ?? ((path) => createWriteStream(path, { flags: 'a', mode: 0o600 }));
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Opens the file, rotating one already past the threshold. Only under the data dir's lock. */
  open(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (this.size() >= this.rotateAt) this.shift();
      this.attach(this.openStream(this.path));
    } catch {
      this.fail();
      return;
    }

    this.timer = setInterval(() => void this.rotate(), this.checkEvery);
    this.timer.unref();
  }

  write(line: string): void {
    if (this.closed || this.failed) return;

    const bytes = Buffer.byteLength(line);

    if (this.pending + bytes > this.budget) {
      this.dropped += 1;
      return;
    }

    this.pending += bytes;

    if (this.rotating || !this.stream) this.buffered.push(line);
    else this.send(line, bytes);
  }

  /** Rotates a file past its threshold. Serialized with `close`. */
  rotate(): Promise<void> {
    this.chain = this.chain.then(async () => {
      // What is on disk and what is on its way there.
      if (this.closed || this.failed || !this.stream || this.size() + this.pending < this.rotateAt)
        return;

      this.rotating = true;

      try {
        await this.end(this.stream);
        this.stream = null;
        this.shift();
        this.attach(this.openStream(this.path));
      } catch {
        this.fail();
      } finally {
        this.rotating = false;
      }

      for (const line of this.buffered.splice(0)) this.send(line, Buffer.byteLength(line));
    });

    return this.chain;
  }

  /**
   * Stops taking records and closes the file, after any rotation, once its descriptor is closed.
   * `timeout` when that takes longer than `withinMs`: then the file may still be in use, and
   * the caller must not give up the data directory's lock.
   */
  async close(withinMs = 2000): Promise<'closed' | 'timeout'> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    this.noteDropped(true);
    this.closed = true;

    const done = (this.chain = this.chain.then(async () => {
      const stream = this.stream;

      this.stream = null;
      if (stream) await this.end(stream).catch(() => undefined);
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), withinMs);
      timer.unref();
    });
    const result = await Promise.race([done.then(() => 'closed' as const), timeout]);

    clearTimeout(timer);

    return result;
  }

  private send(line: string, bytes: number): void {
    this.stream!.write(line, () => {
      this.pending -= bytes;
      this.noteDropped(false);
    });
  }

  /** Records how many records were dropped, once the file has caught up (or as it closes). */
  private noteDropped(closing: boolean): void {
    if (this.dropped === 0 || this.closed || (!closing && this.pending > 0)) return;

    const count = this.dropped;
    const line = `${JSON.stringify({ level: 'warn', time: new Date().toISOString(), event: 'log.dropped', count })}\n`;

    this.dropped = 0;
    this.pending += Buffer.byteLength(line);
    if (this.rotating || !this.stream) this.buffered.push(line);
    else this.send(line, Buffer.byteLength(line));
  }

  private attach(stream: Writable): void {
    this.stream = stream;
    stream.on('error', () => this.fail());
  }

  /** Ends a stream and waits until its descriptor is closed, not only flushed. */
  private end(stream: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
      if (stream.closed) return resolve();

      stream.once('close', () => resolve());
      stream.once('error', reject);
      stream.end();
    });
  }

  /** `.1` becomes `.2` and so on, the oldest is removed, and the file becomes `.1`. */
  private shift(): void {
    rmSync(`${this.path}.${this.keep}`, { force: true });

    for (let index = this.keep - 1; index >= 1; index--) {
      try {
        renameSync(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      } catch {
        // No such file yet.
      }
    }

    renameSync(this.path, `${this.path}.1`);
  }

  private size(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  /** A file that cannot be written loses records from now on, never the app. */
  private fail(): void {
    if (this.failed) return;

    this.failed = true;
    this.buffered = [];
    this.warn('Review Desk cannot write its log file; logging is off until it restarts.');
  }
}
