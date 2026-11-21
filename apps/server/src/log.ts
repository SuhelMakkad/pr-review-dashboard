import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
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
/** The settings the registry declares (`db/settings.ts`), by name: never a key or a value. */
export const SETTING_NAMES = [
  'lastAccount',
  'selectedAccount',
  'status',
  'writeCooldown',
  'aiSettings',
  'notificationSettings',
  'reviewSlaHours',
  'backfill',
  'autoReviewPrimed',
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];
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
  'outbox.wake-failed': {},
  'scheduler.wake-failed': {},
  'scheduler.settle-failed': {},
  'ai.archive': {
    side: ['before', 'after'],
    bytes: 'number',
    downloadMs: 'number',
    extractMs: 'number',
  },
  'log.dropped': { count: 'number' },
  'settings.invalid': { setting: SETTING_NAMES },
  'backup.written': { published: 'boolean', stagingLeft: 'boolean' },
  'retention.backups': {
    kept: 'number',
    removed: 'number',
    failed: 'number',
    managed: 'boolean',
  },
  'ai.workspaces': {
    kept: 'number',
    keptBytes: 'number',
    removed: 'number',
    removedBytes: 'number',
    deferred: 'number',
    failed: 'number',
  },
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
  /** A rotation queued or running: the minute's check does not queue another. */
  private rotation: Promise<void> | null = null;
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

  /**
   * Opens the file, rotating one already past the threshold. Only under the data dir's lock, and
   * before the server serves anything: the rotations after this one never block the event loop.
   */
  open(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (sizeOf(this.path) >= this.rotateAt) this.shiftSync();
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

    // A little of the budget is kept for the record of what was dropped.
    if (this.pending + bytes > this.budget - DROPPED_RESERVE) {
      this.dropped += 1;
      return;
    }

    this.pending += bytes;

    if (this.rotating || !this.stream) this.buffered.push(line);
    else this.send(line, bytes);
  }

  /** Rotates a file past its threshold, without blocking the event loop. Serialized with `close`. */
  rotate(): Promise<void> {
    if (this.rotation) return this.rotation;

    const rotation = (this.chain = this.chain.then(async () => {
      if (this.closed || this.failed || !this.stream) return;

      // What is on disk and what is on its way there. A file removed from under the log is
      // reopened, without shifting the old ones, so records stop going to the removed file.
      const size = await sizeOfAsync(this.path);
      const removed = size === null;

      // A file that cannot be measured is left as it is; its stream may still be writing.
      if (size === undefined) return;
      if (!removed && size + this.pending < this.rotateAt) return;

      this.rotating = true;

      try {
        await this.end(this.stream);
        this.stream = null;
        if (!removed) await this.shift();
        // Reopened even when closing has begun: the records accepted meanwhile are written to it,
        // and the close that waits behind this rotation then closes it.
        this.attach(this.openStream(this.path));
      } catch {
        this.fail();
      } finally {
        this.rotating = false;
      }

      if (this.stream)
        for (const line of this.buffered.splice(0)) this.send(line, Buffer.byteLength(line));
    }));

    this.rotation = rotation.finally(() => {
      this.rotation = null;
    });

    return this.rotation;
  }

  /**
   * Stops taking records and closes the file, after any rotation, once its descriptor is closed.
   * `timeout` when that takes longer than `withinMs`, or the stream fails without closing: then
   * the file may still be in use, and the caller must not give up the data directory's lock.
   */
  async close(withinMs = 2000): Promise<'closed' | 'timeout'> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    this.noteDropped(true);
    this.closed = true;

    const done = (this.chain = this.chain.then(async () => {
      const stream = this.stream;

      this.stream = null;
      if (stream) await this.end(stream);
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

  /**
   * Ends a stream and waits until its descriptor is closed, not only flushed. A stream that fails
   * is waited for until it closes too: a caller's deadline decides when to stop waiting.
   */
  private end(stream: Writable): Promise<void> {
    return new Promise((resolve) => {
      if (stream.closed) return resolve();

      stream.once('close', () => resolve());
      stream.end();
    });
  }

  /** `.1` becomes `.2` and so on, the oldest is removed, and the file becomes `.1`. */
  private async shift(): Promise<void> {
    await rm(`${this.path}.${this.keep}`, { force: true });

    for (let index = this.keep - 1; index >= 1; index--)
      await rename(`${this.path}.${index}`, `${this.path}.${index + 1}`).catch(() => undefined);

    // A file removed from under the log is started afresh, not a reason to stop logging.
    await rename(this.path, `${this.path}.1`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  /** The same, before the server serves anything. */
  private shiftSync(): void {
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

  /** A file that cannot be written loses records from now on, never the app. */
  private fail(): void {
    if (this.failed) return;

    this.failed = true;
    this.buffered = [];
    this.warn('Review Desk cannot write its log file; logging is off until it restarts.');
  }
}

/** Room kept in a log file's budget for the record of how many were dropped. */
const DROPPED_RESERVE = 256;

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The file's size, null when there is no file, or undefined when it cannot be measured. */
async function sizeOfAsync(path: string): Promise<number | null | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}
