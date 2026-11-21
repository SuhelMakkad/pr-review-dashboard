import type { ReviewDraft, ReviewEvent } from '@review-desk/shared/review';
import { ApiError } from '@/lib/api';
import {
  ATTEMPT_MESSAGES,
  isSealed,
  labelOf,
  readCheckpoint,
  readWriteStop,
  textOfIntent,
  type AttemptRecord,
  type AttemptView,
  type WriteStop,
} from '@/features/review/draft-attempts';
import {
  COMMAND_MESSAGES,
  decodeCommand,
  isFinal,
  readAbandon,
  readReceipt,
  type Carried,
  type CommandAnswer,
  type CommandKind,
  type CommandRecord,
  type CommandRequest,
  type CommandView,
  type ReadReceipt,
  type SubmitInput,
} from '@/features/review/draft-commands';

/**
 * One PR's draft writer, per account: the summary and verdict as you edit them, and every draft
 * write in one queue. Each write runs after the one before it settles, on the draft revision you
 * saw, with an id that makes a retry of it answer from the original's outcome (see the server's
 * `routes/claims.ts`). Editors only show it, so one that closes and one that opens later share the
 * same edits, the same order of writes and the same outcomes.
 */

export type Field = 'body' | 'event';

type FieldValue<F extends Field> = F extends 'event' ? ReviewEvent : string;

const FIELDS = ['body', 'event'] as const;

/** The draft revision and generation a write acts on. */
export interface Base {
  revision: number;
  generation: number;
}

/** A write's guard, as its request carries it. */
export interface Guard {
  writeId: string;
  baseRevision: number;
  baseGeneration: number;
}

/** A draft write's request, kept in the journal so a reload can send the very same again. */
export interface WriteRequest {
  route: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * What a write's answer, or its lookup, decodes to. `gap`: refused before any claim, as sealed
 * against history the server no longer holds (by an earlier process, say). `unconfirmed`: no
 * outcome can be learnt any more on its own; only a lookup, or a stop, can tell.
 */
export type Outcome =
  | { kind: 'committed'; body: unknown; revision: number }
  | { kind: 'pending' }
  | { kind: 'conflict'; draft: ReviewDraft }
  | { kind: 'refused'; error: ApiError }
  | { kind: 'unknown'; error: unknown }
  | { kind: 'gap'; error: ApiError }
  | { kind: 'unconfirmed' };

/** What `dispatch` settles a write with. */
type Settled = Exclude<Outcome, { kind: 'pending' } | { kind: 'unknown' } | { kind: 'gap' }>;

/** The write an answer is about: only an answer that names it, on its base, settles it. */
export interface Expected {
  writeId: string;
  base: Base;
}

/** How the writer reaches the server: injected, so it runs without React or a network in tests. */
export interface Transport {
  send(request: WriteRequest): Promise<unknown>;
  /** The attempt's state, as `routes.draftAttempt` answers it; decoded by `fromLookup`. */
  lookup(writeId: string, base: Base): Promise<unknown>;
  /** The claim checkpoint new write ids are sealed with, as `routes.claimCheckpoint` answers. */
  checkpoint(): Promise<unknown>;
  /** Stops waiting for a write, as `routes.abandonDraftAttempt` answers; decoded by `readWriteStop`. */
  abandonWrite(writeId: string): Promise<unknown>;
  /** The account-switch stamp now: a write's answer is shown only under the stamp it was sent at. */
  stamp(): number;
  /** The draft a write left, or the server's draft that refused it, from a write sent at `stamp`. */
  committed(draft: ReviewDraft, stamp: number): void;
  /** A change the queue cannot show itself (a comment write): the draft is read again. */
  stale(): void;
  /** A save was refused: says why, even when no editor of the draft is open. */
  refused(reason: string): void;
  /** The account's receipt-history epoch, read before a command's first send. */
  epoch(): Promise<number>;
  /** Sends a command's frozen request, answering as `api` does (strictly). */
  sendCommand(request: CommandRequest): Promise<unknown>;
  /** A command's receipt, as the route answers it; null for a 404, nothing received. */
  receipt(id: string): Promise<unknown>;
  /** Stops waiting for a command. */
  abandon(id: string, kind: CommandKind, epoch: number | null): Promise<unknown>;
}

/**
 * A write the server refused, or one this tab refused before sending: its input is the caller's
 * to keep. A server's refusal keeps its status, code and details, as any other answer's error.
 */
export class WriteRefused extends ApiError {
  constructor(message: string, code?: string, details: Record<string, unknown> = {}, status = 409) {
    super(message, status, code, details);
  }

  /** The draft as the server has it, when the refusal was for a change since. */
  get draft(): ReviewDraft | undefined {
    return this.details.draft as ReviewDraft | undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isDraft = (body: unknown): body is ReviewDraft =>
  isObject(body) && isObject(body.versions) && Array.isArray(body.comments);

/** The attempt `value` names, if it is `expected`'s and well formed; otherwise undefined. */
function attemptOf(
  value: unknown,
  expected: Expected,
): { state: 'pending' | 'refused' } | { state: 'committed'; revision: number } | undefined {
  if (!isObject(value) || value.id !== expected.writeId) return undefined;
  if (value.state === 'pending' || value.state === 'refused') return { state: value.state };

  // A commit is at or after its base: the base itself only for a write that changed nothing.
  const revision = value.revision;

  return value.state === 'committed' &&
    typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= expected.base.revision
    ? { state: 'committed', revision }
    : undefined;
}

/** A refusal's outcome: a change since (with the draft as it is), or any other refusal. */
const refusedOutcome = (error: ApiError): Outcome =>
  error.code === 'DRAFT_REVISION_CONFLICT' && isDraft(error.details.draft)
    ? { kind: 'conflict', draft: error.details.draft }
    : { kind: 'refused', error };

/**
 * Decodes a write's answer. Only an attempt that names this write settles it; anything else stays
 * unknown, except a client error to a first send, which no claim can have answered.
 */
export async function decode(
  answer: Promise<unknown>,
  first: boolean,
  expected: Expected,
): Promise<Outcome> {
  try {
    const body = await answer;
    const attempt = isObject(body) ? attemptOf(body.attempt, expected) : undefined;

    if (attempt?.state === 'pending' && isObject(body) && body.pending === true)
      return { kind: 'pending' };
    if (attempt?.state === 'committed')
      return { kind: 'committed', body, revision: attempt.revision };

    return { kind: 'unknown', error: new Error('The answer carried no outcome.') };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: 'unknown', error };
    // Refused before any claim, its id sealed against history the server no longer holds.
    if (error.code === 'WRITE_HISTORY_GAP') return { kind: 'gap', error };

    const attempt = attemptOf(error.details.attempt, expected);

    if (attempt?.state === 'refused') return refusedOutcome(error);
    // An attempt, but not this write's in a state that settles it: no outcome.
    if (attempt || error.details.attempt !== undefined) return { kind: 'unknown', error };

    // No outcome recorded: no answer, an unreadable one, a server error, or a refusal before the
    // claim (a session or schema check). Only the last is definite, and only when nothing earlier
    // of this write may have arrived.
    const beforeClaim = error.code !== 'UNREADABLE' && error.status >= 400 && error.status < 500;

    return first && beforeClaim ? { kind: 'refused', error } : { kind: 'unknown', error };
  }
}

/**
 * Decodes a lookup's answer. A miss proves something only when the server says it is provable
 * (the id sealed by the server running, its history whole since): `never` means the write did not
 * arrive and never can commit; `resend` that it may yet. A miss that proves nothing is `unknown`.
 * An answer that could not be read is `resend` too: a sealed id sent again answers once.
 */
export function fromLookup(
  answer: unknown,
  expected: Expected,
): Outcome | 'never' | 'resend' | 'unknown' {
  if (!isObject(answer)) return 'resend';

  if (!('attempt' in answer)) {
    if (answer.arrived !== false || typeof answer.fenced !== 'boolean') return 'resend';
    if (answer.provable !== true) return 'unknown';

    return answer.fenced ? 'never' : 'resend';
  }

  const attempt = attemptOf(answer.attempt, expected);
  const recorded = isObject(answer.attempt) ? answer.attempt.result : undefined;

  if (!attempt) return 'resend';
  if (attempt.state === 'pending') return { kind: 'pending' };
  // A settled attempt answers with what it recorded: one without it is not read as settled.
  if (!isObject(recorded)) return 'resend';
  if (attempt.state === 'committed')
    return { kind: 'committed', body: recorded.body, revision: attempt.revision };

  const body = isObject(recorded.body) ? recorded.body : {};
  const status = typeof recorded.status === 'number' ? recorded.status : 409;
  const message = typeof body.error === 'string' ? body.error : 'Not saved.';
  const code = typeof body.code === 'string' ? body.code : undefined;

  return refusedOutcome(new ApiError(message, status, code, body));
}

interface FieldState {
  value: string;
  /** Raised by every edit. */
  version: number;
  /** The highest version the server confirmed saved, or a command retired. */
  settled: number;
  /** The highest version a queued save carries: a flush never queues it twice. */
  queued: number;
  /** The draft revision that save made: the editor shows its value until the draft shows it. */
  savedAt: number;
  /** Why its latest save was refused; it is kept, not sent again, until you edit it. */
  failed: string | null;
  /**
   * The draft generation its unsaved text began on, and when: fixed until it is saved, or until
   * you edit it after a refusal. Never sent into another generation, nor resent after a week.
   */
  generation: number | null;
  since: number | null;
  /**
   * Whether the latest save queued of it committed: what a write that replaces it, or waits on
   * it, depends on, whatever was typed since.
   */
  lastSave: { version: number; kept: Promise<boolean> } | null;
}

/** A field's text as a save carries it. */
interface Snapshot {
  value: string;
  version: number;
  generation: number | null;
  since: number | null;
}

/** The fields a save committed. */
type Committed = Set<Field>;

/** A write sent and not yet settled. */
interface Inflight {
  writeId: string;
  request: WriteRequest;
  base: Base;
  /** When it stops being sent: within the server's receipts, and the journal's week. */
  deadline: number;
  /** The account-switch stamp as it was first sent: its answer is shown only under it. */
  stamp: number;
  /** For a meta save, the field versions it carries: only these are journaled. */
  fields?: Partial<Record<Field, number>>;
  /** For a meta save, where each field's text began: its rebase after a reload keeps them. */
  meta?: Partial<Record<Field, Pick<Snapshot, 'generation' | 'since'>>>;
}

/**
 * What a reload keeps: each field, and the autosaves on their way, sent again after it with the
 * same id until their deadline. A comment or AI write is not resent after a reload: the draft
 * read then shows whether it was kept.
 */
interface Journal {
  fields: Record<Field, Omit<FieldState, 'queued' | 'lastSave'>>;
  inflight: Omit<Inflight, 'stamp'>[];
  /** Submit and discard commands not yet settled: each restored, never sent again on its own. */
  commands?: CommandRecord[];
  /** Legacy ids settled before they were journaled: their outcome, recorded. */
  settledLegacy?: string[];
  /** Comment and AI writes not yet settled, and autosaves an earlier version left: see `write`. */
  writes?: AttemptRecord[];
}

const DEBOUNCE_MS = 800;
/** How long a write is sent again, and an unsaved edit kept to be saved: then only kept. */
export const ATTEMPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const journalKey = (account: string, prId: string) => `review-desk-draft-writer:${account}:${prId}`;
const ZERO: Base = { revision: 0, generation: 0 };

const DISCARDED_ELSEWHERE =
  'This draft was discarded or submitted elsewhere. Your text is kept here and was not saved.';
const NOT_CONFIRMED =
  'This could not be confirmed as saved. Your text is kept here; check the draft before saving it again.';
const EXPIRED = 'Kept from more than a week ago, and not saved. Edit it to save it.';
const KEPT_FROM_DISCARD =
  'Kept from before you discarded the draft, and not saved. Edit it to save it.';
const UNSAVED_REPLACED =
  'Your own summary or verdict was not saved, and this would replace it. Copy or clear it, then try again.';
const UNSAVED = 'Your summary or verdict was not saved. Check it, then try again.';
/** How long a command may take from the front of the queue to its admission answer. */
export const COMMAND_BOUND_MS = 30_000;
/** How often a command whose outcome is not known is looked up. */
const POLL_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const notConfirmed = (): Outcome => ({
  kind: 'refused',
  error: new ApiError(NOT_CONFIRMED, 0, 'NOT_CONFIRMED'),
});

export class DraftWriter {
  private readonly fields: Record<Field, FieldState>;
  private inflight: Inflight[];
  private chain: Promise<void> = Promise.resolve();
  /** Writes queued or running. */
  private queued = 0;
  /** The draft as last read or written: what a write queued while nothing runs acts on. */
  private seen: Base | null = null;
  /**
   * What a write queued behind others acts on: the base the queue began on, moved only by its own
   * commits and by the drafts its conflicts returned, never by a read meanwhile.
   */
  private tail: Base | null = null;
  /** A write in this run of the queue met a change elsewhere: actions behind it stop. */
  private broken = false;
  /** Raised for each job queued: what is queued after a command waits on it. */
  private seq = 0;
  /** Submit and discard commands not yet settled, oldest first. */
  private commands: CommandRecord[];
  /** The place of a submit admitted in this run of the queue: what was queued after it stops. */
  private submittedAt: number | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  /** Commands being looked up now: never two lookups of one at once. */
  private readonly checking = new Set<string>();
  /**
   * Legacy ids adopted, each with how to forget it where an earlier version kept it: forgotten
   * only once this writer's journal holds it, or holds its outcome (`settledLegacy`).
   */
  private readonly unjournaled = new Map<string, () => boolean>();
  /** Legacy ids settled before the journal held them: journaled, so their outcome is durable. */
  private settledLegacy: string[] = [];
  /** How each command settled, while its caller may still be waiting on it. */
  private readonly outcomes = new WeakMap<CommandRecord, 'admitted' | 'refused' | 'lost'>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The checkpoint new write ids are sealed with, as last read (see `sealedId`). */
  private sealing: { checkpoint: number; seal: string } | null = null;
  /** Comment and AI writes, journaled from when they are asked for until they settle. */
  private writes: AttemptRecord[];
  /** Writes being looked up now, by key: a lookup asked for meanwhile joins the one on its way. */
  private readonly checkingWrites = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  /** Raised on every change, so a subscriber can tell one state from the next. */
  version = 0;

  constructor(
    readonly account: string,
    readonly prId: string,
    private readonly transport: Transport,
    /** Waits between attempts to learn a write's outcome; tests make it instant. */
    private readonly backoff: (attempt: number) => number = (attempt) =>
      Math.min(500 * 2 ** attempt, 10_000),
    /** How often an unsettled command is looked up; tests look it up themselves. */
    private readonly pollMs = POLL_MS,
  ) {
    const saved = readJournal(account, prId);
    const now = Date.now();
    const fresh = (field: Field): FieldState => ({
      value: field === 'event' ? 'COMMENT' : '',
      version: 0,
      settled: 0,
      queued: 0,
      savedAt: 0,
      failed: null,
      generation: null,
      since: null,
      lastSave: null,
    });
    // After a reload nothing is queued: an unsaved edit is saved again, besides the very save
    // the journal kept. A refused one stays refused, kept until you edit it.
    const restored = (field: Field): FieldState =>
      saved
        ? {
            ...saved.fields[field],
            queued: saved.fields[field].settled,
            lastSave: null,
          }
        : fresh(field);

    this.fields = { body: restored('body'), event: restored('event') };

    // An unsaved edit from more than a week ago is kept, never saved on its own.
    for (const state of Object.values(this.fields))
      if (state.version > state.settled && !state.failed && isOld(state.since, now))
        state.failed = EXPIRED;

    // Autosaves a reload interrupted are sent again as they were, each answering once by its id,
    // until their deadline; past it their text is kept, unconfirmed.
    const stamp = transport.stamp();

    this.inflight = [];
    // Comment and AI writes a reload interrupted: one never sent is released, its text yours to
    // copy; one that may have been sent is only looked up, never sent again on its own.
    this.writes = (saved?.writes ?? []).map((record) =>
      record.phase === 'queued'
        ? { ...record, phase: 'not-saved', reason: ATTEMPT_MESSAGES.notSentReload }
        : record.phase === 'sending'
          ? { ...record, phase: 'checking' }
          : record,
    );

    // An autosave still to be looked up keeps its fields from a save of their own meanwhile.
    for (const record of this.writes)
      if (writeNeedsLookup(record))
        for (const [field, version] of entries(record.fields ?? {}))
          this.fields[field].queued = Math.max(this.fields[field].queued, version);

    for (const write of saved?.inflight ?? []) {
      const fields = write.fields ?? {};

      if (now >= write.deadline) {
        this.markFailed(fields, NOT_CONFIRMED);
        continue;
      }

      // Journaled by an earlier version, under a bare id: only looked up. Sent again, it could be
      // admitted afresh, its first received and its record pruned since. Its text is kept, and
      // not saved on its own, until its outcome is known.
      if (!isSealed(write.writeId)) {
        for (const [field, version] of entries(fields))
          this.fields[field].queued = Math.max(this.fields[field].queued, version);

        this.writes.push({
          key: write.writeId,
          phase: 'checking',
          intent: write.request,
          writeId: write.writeId,
          request: write.request,
          base: write.base,
          deadline: write.deadline,
          fields,
        });
        continue;
      }

      const resumed = { ...write, stamp };
      const job = this.enqueue(() => this.resume(resumed));

      // What is queued behind it acts on the draft it was sent on, until it commits.
      if (!this.tail || write.base.revision > this.tail.revision) this.tail = write.base;

      for (const [field, version] of entries(fields)) {
        const state = this.fields[field];

        // Queued already: a flush meanwhile does not send the same versions twice.
        state.queued = Math.max(state.queued, version);
        state.lastSave = { version, kept: job.then((done) => done.has(field)) };
      }

      this.inflight.push(resumed);
    }

    // A command a reload interrupted: one never sent is released, its text yours as before; one
    // that may have been sent is only looked up, and holds its gate until it is settled.
    this.commands = (saved?.commands ?? [])
      .filter((command) => command.phase !== 'queued')
      .map((command) => ({
        ...command,
        seq: 0,
        phase: command.phase === 'sending' ? 'unknown' : command.phase,
        // Journaled before `from` was: what it carried, else nothing was typed behind it.
        from: command.from ??
          command.carried?.versions ?? {
            body: this.fields.body.version,
            event: this.fields.event.version,
          },
      }));

    // Legacy ids settled before a reload: never adopted again (see `adopt`).
    this.settledLegacy = saved?.settledLegacy ?? [];

    if (this.commands.some(needsLookup) || this.writes.some(writeNeedsLookup)) {
      this.poll();
      void this.reconcile();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.version += 1;
    this.persist();

    for (const listener of this.listeners) listener();
  }

  /** Writes the journal; false when it could not be written. */
  private persist(): boolean {
    const write = () =>
      writeJournal(this.account, this.prId, {
        fields: { body: strip(this.fields.body), event: strip(this.fields.event) },
        inflight: this.inflight
          .filter((write) => write.fields)
          .map(({ stamp: _stamp, ...write }) => write),
        commands: this.commands,
        ...(this.settledLegacy.length > 0 ? { settledLegacy: this.settledLegacy } : {}),
        ...(this.writes.length > 0 ? { writes: this.writes } : {}),
      });

    if (!write()) return false;

    const kept = this.settledLegacy.length;

    // Each adopted id the journal now holds, or holds the outcome of: the earlier version's record
    // of it may go.
    const held = new Set([...this.commands.map((command) => command.id), ...this.settledLegacy]);

    for (const [id, forget] of [...this.unjournaled])
      if (held.has(id) && forget()) {
        this.unjournaled.delete(id);
        // Deleted there: its outcome need not be kept here.
        this.settledLegacy = this.settledLegacy.filter((settled) => settled !== id);
      }

    // Pruned: written again without them (a failure keeps them, which is harmless).
    if (this.settledLegacy.length < kept) write();

    return true;
  }

  /** A draft read or written: what the next write acts on while nothing is queued. */
  observe(draft: ReviewDraft) {
    const versions = draft.versions;

    if (!versions) return;
    if (!this.seen || versions.revision >= this.seen.revision)
      this.seen = { revision: versions.revision, generation: versions.generation };

    // A field whose save the draft now shows: shown from the draft again.
    this.changed();
  }

  /** The field as the editor shows it: your unsaved edit, else what the draft holds. */
  value<F extends Field>(field: F, draft: ReviewDraft | undefined): FieldValue<F> {
    const state = this.fields[field];
    const shown = draft?.versions?.revision ?? -1;

    // Unsaved, or saved at a revision the draft shown has not reached yet.
    if (state.version > state.settled || state.savedAt > shown) return state.value as FieldValue<F>;

    return (draft?.[field] ?? state.value) as FieldValue<F>;
  }

  /** The field's state as the editor shows it. */
  state(field: Field): 'saved' | 'dirty' | 'saving' | 'error' {
    const state = this.fields[field];

    if (state.failed) return 'error';
    if (state.version <= state.settled) return 'saved';

    return this.timer ? 'dirty' : 'saving';
  }

  /** Why the field's latest save was refused, if it was. */
  failure(field: Field): string | null {
    return this.fields[field].failed;
  }

  /** The versions `fields` hold now: what a command sent with their values carries. */
  versions(fields: Field[]): Partial<Record<Field, number>> {
    return Object.fromEntries(fields.map((field) => [field, this.fields[field].version]));
  }

  /**
   * The summary and verdict as shown on `draft`, and the versions they hold, read at once: what a
   * submit sends, and what its acceptance retires.
   */
  carry(draft: ReviewDraft | undefined): {
    body: string;
    event: ReviewEvent;
    versions: Record<Field, number>;
  } {
    return {
      body: this.value('body', draft),
      event: this.value('event', draft),
      versions: { body: this.fields.body.version, event: this.fields.event.version },
    };
  }

  /** You typed `value` into `field`: saved after a pause (the body) or at once (the verdict). */
  edit<F extends Field>(field: F, value: FieldValue<F>) {
    const state = this.fields[field];

    // Unsaved text begins here, on the draft as shown; typing again after a refusal, which you
    // saw, makes it yours for that draft.
    if (state.version <= state.settled || state.failed) {
      state.generation = this.seen?.generation ?? null;
      state.since = Date.now();
    }

    state.value = value;
    state.version += 1;
    state.failed = null;
    this.changed();

    if (this.timer) clearTimeout(this.timer);

    if (field === 'event') void this.flush();
    else this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  /** Saves every unsaved field now, with what each holds as this is called. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);

    this.timer = null;

    const fields = FIELDS.filter((field) => {
      const state = this.fields[field];

      return state.version > Math.max(state.settled, state.queued) && !state.failed;
    });

    // While a submit or discard is unsettled, edits are parked: kept here, journaled, unsent.
    if (fields.length === 0 || this.parking()) return Promise.resolve();

    // Resolved now, not when it runs: an edit after this is the next save's.
    const snapshot = this.snapshotOf(fields);
    const base = this.baseNow();
    const job = this.enqueue(() => this.save(snapshot, base));

    for (const field of fields)
      this.fields[field].lastSave = {
        version: snapshot[field]!.version,
        kept: job.then((done) => done.has(field)),
      };

    return job.then(() => {});
  }

  /**
   * Resolves once every write queued so far has settled, pending edits saved first: with why the
   * latest save of any of `fields` was not kept, if one was not. What waits on it runs outside the
   * queue, so a slow one never holds up the writes queued after it.
   */
  async settled(fields: Field[] = []): Promise<string | null> {
    const blocked = this.blocked();

    if (blocked) return blocked;

    void this.flush();

    const saves = this.savesOf(fields);
    const versions = this.versions(fields);
    const seq = ++this.seq;

    await this.enqueue(async () => {});

    // A command ahead of it unsettled, or a submit admitted: nothing is to be done on this draft.
    const gate = this.gateAt(seq);

    if (gate) return gate.message;
    if (this.unsaved(fields, await saves)) return this.failureOf(fields) ?? UNSAVED;

    // A field parked, or held by a command, is not saved either.
    return fields.some((field) => this.fields[field].settled < versions[field]!) ? UNSAVED : null;
  }

  /**
   * Queues a draft write (a comment's add, edit or delete, an AI accept, apply or prepare): sent
   * after every write before it, on the draft you saw, with its own sealed id. It is journaled from
   * now, and recorded as sent before it is: a reload releases one never sent and only looks up one
   * that may have been. Resolves with its answer once it committed; rejects with `WriteRefused`
   * when it was refused, its input yours to keep, or when it could no longer be confirmed, kept in
   * the banner. One that `replaces` the summary or verdict is refused unless your own text of it
   * was kept.
   */
  write<T>(
    route: string,
    params: Record<string, string>,
    body: Record<string, unknown>,
    options: { replaces?: Field[] } = {},
  ): Promise<T> {
    // Pending edits go first, saved with what they hold now.
    void this.flush();

    const base = this.baseNow();
    const replaces = options.replaces ?? [];
    const saves = this.savesOf(replaces);
    const seq = ++this.seq;
    const gate = this.gateAt(seq);

    // An unsettled submit or discard, or an open discard: refused now, your input yours to keep.
    if (gate) return Promise.reject(new WriteRefused(gate.message, gate.code));

    const record: AttemptRecord = {
      key: crypto.randomUUID(),
      phase: 'queued',
      intent: { route, params, body },
    };

    this.writes.push(record);
    this.changed();

    return this.enqueue(async () => {
      // Kept past its job only when it could not be confirmed: the banner holds it then.
      let kept = false;

      try {
        // A command queued before it that left the queue unsettled, or a submit it admitted.
        const ahead = this.gateAt(seq);

        if (ahead) throw new WriteRefused(ahead.message, ahead.code);

        if (base === 'chain' && this.broken)
          throw new WriteRefused(
            'The draft changed since you chose this. Check it, then try again.',
            'DRAFT_CHANGED_LOCALLY',
          );

        // Whatever was typed since, the saves it was queued behind must have kept your text.
        if (this.unsaved(replaces, await saves))
          throw new WriteRefused(UNSAVED_REPLACED, 'DRAFT_EDIT_UNSAVED');

        const write = this.attempt(await this.guard(base), { route, params, body });

        // Recorded as sent before it is, or never sent.
        Object.assign(record, {
          phase: 'sending',
          writeId: write.writeId,
          request: write.request,
          base: write.base,
          deadline: write.deadline,
        });

        if (!this.persist()) throw new WriteRefused(COMMAND_MESSAGES.notRecorded, 'NOT_RECORDED');

        const outcome = await this.dispatch(write, true, record);

        if (outcome.kind === 'committed') {
          this.advance(outcome.revision, write.base.generation);

          // An answer that is the draft (apply, prepare) is shown at once; another, read again.
          if (isDraft(outcome.body)) this.transport.committed(outcome.body, write.stamp);
          else this.transport.stale();

          return outcome.body as T;
        }

        if (outcome.kind === 'conflict') {
          this.conflicted(outcome.draft, write.stamp);

          throw new WriteRefused(
            'The draft changed since you saw it. Nothing was saved; check it, then try again.',
            'DRAFT_REVISION_CONFLICT',
            { draft: outcome.draft },
          );
        }

        // Received or not, nothing can tell now: never sent again on its own, only looked up.
        if (outcome.kind === 'unconfirmed') {
          kept = true;
          this.moveWrite(record, 'unknown');
          this.poll();

          throw new WriteRefused(ATTEMPT_MESSAGES.unconfirmed, 'WRITE_UNCONFIRMED');
        }

        throw refusalOf(outcome);
      } finally {
        if (!kept) this.dropWrite(record);
      }
    });
  }

  /**
   * Submits your review: queued behind every write before it, on the draft you saw, with its own
   * id. Its intent is frozen now (`carried`, read with its values, and the pending review shown),
   * and its request once its predecessors resolve. While it is unsettled nothing autosaves into the
   * draft, and nothing else is done on it. Resolves with its receipt once admitted; rejects with
   * its refusal, or as not confirmed, its text kept and the banner offering what to do.
   */
  submit(
    input: SubmitInput,
    carried: Carried,
    expectedPendingReviewId: string | null,
  ): Promise<unknown> {
    return this.queueCommand('submit', carried, { input, expectedPendingReviewId });
  }

  /**
   * Discards the draft, as `submit` is queued. From now until its cleanup finishes, comment and AI
   * writes and other commands are refused, and your edits are parked: kept here, unsent, until it
   * is final, then saved on the draft it left, or kept for you to confirm.
   */
  discard(carried: Carried): Promise<unknown> {
    return this.queueCommand('discard', carried, {});
  }

  /**
   * Why an action asked for now may not go ahead: an unsettled submit or discard, an open discard,
   * or a submit admitted in this run of the queue. Null when it may.
   */
  blocked(): string | null {
    return this.gateAt(Infinity)?.message ?? null;
  }

  /** The commands the banner shows: unsettled, a discard being cleaned up, or lost. */
  commandViews(): CommandView[] {
    return this.commands
      .filter(
        (command): command is CommandRecord & { phase: CommandView['phase'] } =>
          command.phase !== 'queued' && command.phase !== 'sending',
      )
      .map((command) => ({
        id: command.id,
        kind: command.kind,
        phase: command.phase,
        legacy: Boolean(command.legacy),
        canSendAgain: this.canSendAgain(command),
        carried: command.carried,
        missing: Boolean(command.missing),
        ...(command.status ? { status: command.status } : {}),
      }));
  }

  /** Sends a command whose outcome is not known again, the very same, by your choice only. */
  async sendAgain(id: string): Promise<void> {
    const command = this.commands.find((other) => other.id === id);

    if (!command || !this.canSendAgain(command)) return;

    // From now either send may be the one received: only evidence settles it.
    command.resent = true;
    this.changed();

    const answer = await decodeCommand(
      this.transport.sendCommand(command.request!),
      false,
      command,
    );

    this.settleCommand(command, answer);

    // A resend's answer that says nothing is settled by its receipt.
    if (answer.kind !== 'admitted') await this.reconcileOne(command);
  }

  /**
   * Stops waiting for a command whose outcome is not known: received already, it settles as such;
   * otherwise it can never be after, and settles as refused, or as lost when the server cannot
   * tell whether it was received before.
   */
  async stop(id: string): Promise<void> {
    const command = this.commands.find((other) => other.id === id);

    if (!command || (command.phase !== 'unknown' && !command.missing)) return;

    const read = readAbandon(
      await this.transport.abandon(command.id, command.kind, command.epoch),
      command,
      this.prId,
    );

    if (read) this.settleByReceipt(command, read);
  }

  /**
   * Adopts ids an earlier version kept for this draft's submit and discard: recovery-only, with no
   * base and no claim on your current edits, only looked up or stopped. They hold the gate at once,
   * journaled or not; `forget` runs once the journal holds them, so the earlier record is kept
   * until then.
   */
  adopt(legacy: { id: string; kind: CommandKind; forget: () => boolean }[]) {
    // Settled already, here or before a reload: never adopted again, only forgotten there.
    const settled = new Set(this.settledLegacy);
    const present = new Set(legacy.map((command) => command.id));

    // Gone there already: what was kept of them here is no longer needed.
    this.settledLegacy = this.settledLegacy.filter((id) => present.has(id));

    for (const command of legacy)
      if (settled.has(command.id)) this.unjournaled.set(command.id, command.forget);

    legacy = legacy.filter((command) => !settled.has(command.id));

    const known = new Set(this.commands.map((command) => command.id));
    const from = { body: this.fields.body.version, event: this.fields.event.version };

    this.commands.push(
      ...legacy
        .filter((command) => !known.has(command.id))
        .map(({ forget: _forget, ...command }): CommandRecord => ({
          ...command,
          phase: 'unknown',
          seq: 0,
          carried: null,
          from,
          epoch: null,
          legacy: true,
        })),
    );

    // Each one, adopted now or restored already from the journal: forgotten there once settled.
    for (const command of legacy) this.unjournaled.set(command.id, command.forget);

    this.changed();
    this.poll();
    void this.reconcile();
  }

  /** Forgets a lost command, once you have kept what you need of it. */
  dismiss(id: string) {
    this.commands = this.commands.filter(
      (command) => command.id !== id || command.phase !== 'lost',
    );
    this.changed();
  }

  /**
   * Looks up every command whose outcome is not known yet, or whose cleanup is not finished, and
   * every write that may have been received.
   */
  async reconcile(): Promise<void> {
    const open = this.commands.filter(needsLookup);
    const writes = this.writes.filter(writeNeedsLookup);

    if (open.length === 0 && writes.length === 0) {
      this.stopPolling();

      return;
    }

    await Promise.all([
      ...open.map((command) => this.reconcileOne(command)),
      ...writes.map((record) => this.reconcileWrite(record)),
    ]);
  }

  /** The writes the banner shows: not confirmed, not saved, or stopped while not known. */
  writeViews(): AttemptView[] {
    return this.writes
      .filter(
        (record): record is AttemptRecord & { phase: AttemptView['phase'] } =>
          (record.phase === 'unknown' || record.phase === 'not-saved' || record.phase === 'lost') &&
          !record.dismissed,
      )
      .map((record) => ({
        key: record.key,
        phase: record.phase,
        label: labelOf(record.intent),
        text: textOfIntent(record.intent),
        canSendAgain: this.canSendWriteAgain(record),
        canStop: record.phase === 'unknown' && record.writeId !== undefined,
        ...(record.reason ? { reason: record.reason } : {}),
      }));
  }

  /**
   * Sends a write the banner shows again, the very same envelope, by your choice only: through
   * the queue and its gates, as any write. Only one that a lookup found not received yet, and
   * able to be, within its lifetime.
   */
  async sendWriteAgain(key: string): Promise<void> {
    const record = this.writes.find((other) => other.key === key);

    if (!record || !this.canSendWriteAgain(record)) return;

    const seq = ++this.seq;
    const gate = this.gateAt(seq);

    if (gate) throw new WriteRefused(gate.message, gate.code);

    // Recorded as sent before it is, or never sent.
    this.moveWrite(record, 'sending');

    if (!this.persist()) {
      this.moveWrite(record, 'unknown');

      throw new WriteRefused(COMMAND_MESSAGES.notRecorded, 'NOT_RECORDED');
    }

    await this.enqueue(async () => {
      const ahead = this.gateAt(seq);

      if (ahead) {
        this.moveWrite(record, 'unknown');

        throw new WriteRefused(ahead.message, ahead.code);
      }

      const write: Inflight = {
        writeId: record.writeId!,
        request: record.request!,
        base: record.base!,
        deadline: record.deadline!,
        stamp: this.transport.stamp(),
      };
      const outcome = await this.dispatch(write, false, record);

      if (outcome.kind === 'committed') {
        this.advance(outcome.revision, write.base.generation);

        if (isDraft(outcome.body)) this.transport.committed(outcome.body, write.stamp);
        else this.transport.stale();

        this.dropWrite(record);
      } else if (outcome.kind === 'conflict') {
        // Sent on the draft it was first sent on: shown, without stopping what is queued after.
        this.observe(outcome.draft);
        this.transport.committed(outcome.draft, write.stamp);
        this.notSaved(record, 'The draft changed since this was first sent, so it was not saved.');
      } else if (outcome.kind === 'unconfirmed')
        this.moveWrite(record, 'unknown', { resendable: false });
      else this.notSaved(record, refusalOf(outcome).message);
    });
  }

  /**
   * Stops waiting for a write the banner shows as not confirmed: received already, it settles as
   * such; otherwise it never can be after, and it is not saved, or lost when the server cannot
   * tell whether it was received before.
   */
  async stopWrite(key: string): Promise<void> {
    const record = this.writes.find((other) => other.key === key);

    if (!record || record.phase !== 'unknown' || !record.writeId) return;

    const read = readWriteStop(await this.transport.abandonWrite(record.writeId), record.writeId);

    if (read && this.writes.includes(record) && record.phase === 'unknown')
      this.settleStop(record, read);
  }

  /** Hides a write from the banner: one still to be settled is still looked up. */
  dismissWrite(key: string) {
    const record = this.writes.find((other) => other.key === key);

    if (!record) return;
    if (record.phase === 'not-saved' || record.phase === 'lost') this.dropWrite(record);
    else {
      record.dismissed = true;
      this.changed();
    }
  }

  private canSendWriteAgain(record: AttemptRecord): boolean {
    return (
      record.phase === 'unknown' &&
      record.resendable === true &&
      record.fields === undefined &&
      record.writeId !== undefined &&
      isSealed(record.writeId) &&
      record.request !== undefined &&
      record.base !== undefined &&
      Date.now() < (record.deadline ?? 0)
    );
  }

  /**
   * Looks up a write that may have been received, in the background: settled by what it finds,
   * the draft read again for a commit, never moving what the queue acts on.
   */
  private reconcileWrite(record: AttemptRecord): Promise<void> {
    const known = this.checkingWrites.get(record.key);

    if (known) return known;

    const looking = this.lookUpWrite(record).finally(() => this.checkingWrites.delete(record.key));

    this.checkingWrites.set(record.key, looking);

    return looking;
  }

  private async lookUpWrite(record: AttemptRecord): Promise<void> {
    const { writeId, base } = record;

    if (!writeId || !base) return;

    try {
      const looked = fromLookup(await this.transport.lookup(writeId, base), { writeId, base });

      // Settled meanwhile (stopped, or sent again): this lookup is stale.
      if (!this.writes.includes(record) || !writeNeedsLookup(record) || record.writeId !== writeId)
        return;

      if (looked === 'never') this.notSaved(record, ATTEMPT_MESSAGES.neverReceived);
      else if (looked === 'resend' || looked === 'unknown') {
        // Not found: an autosave's text is kept for you to confirm.
        if (record.fields && this.markFailed(record.fields, NOT_CONFIRMED)) this.changed();

        this.moveWrite(record, 'unknown', {
          resendable: looked === 'resend' && isSealed(writeId),
        });
      } else if (looked.kind === 'committed') this.writeCommitted(record, looked.revision);
      else if (looked.kind === 'conflict')
        this.notSaved(record, 'The draft changed since this was sent, so it was not saved.');
      else if (looked.kind === 'refused') this.notSaved(record, looked.error.message);
    } catch {
      // Not reachable: looked up again later.
    }
  }

  private settleStop(record: AttemptRecord, read: WriteStop) {
    if (read.kind === 'pending') this.moveWrite(record, 'checking');
    else if (read.kind === 'committed') this.writeCommitted(record, read.revision);
    else if (read.kind === 'refused') this.notSaved(record, read.error.message);
    else if (read.kind === 'not-admitted') this.notSaved(record, ATTEMPT_MESSAGES.stoppedNever);
    else this.moveWrite(record, 'lost');
  }

  /** A write found committed in the background: its fields settled, the draft read again. */
  private writeCommitted(record: AttemptRecord, revision: number) {
    if (record.fields) this.settleFields(record.fields, revision);

    this.dropWrite(record);
    this.transport.stale();
  }

  /** Never saved: an autosave's fields keep its text for you to confirm; another is shown. */
  private notSaved(record: AttemptRecord, reason: string) {
    if (record.fields) {
      this.markFailed(record.fields, reason);
      this.dropWrite(record);

      return;
    }

    this.moveWrite(record, 'not-saved', { reason });
  }

  private moveWrite(
    record: AttemptRecord,
    phase: AttemptRecord['phase'],
    extra: Partial<AttemptRecord> = {},
  ) {
    // Moved: shown again, if it was hidden.
    if (record.phase !== phase) record.dismissed = false;

    Object.assign(record, extra, { phase });
    this.changed();
  }

  private dropWrite(record: AttemptRecord) {
    this.writes = this.writes.filter((other) => other !== record);
    this.changed();
  }

  private canSendAgain(command: CommandRecord): boolean {
    return (
      command.phase === 'unknown' &&
      !command.legacy &&
      command.request !== undefined &&
      Date.now() < (command.firstSent ?? 0) + ATTEMPT_TTL_MS
    );
  }

  /** Whether edits are parked now: a submit or discard is unsettled, or a discard not final. */
  private parking(): boolean {
    return this.commands.some((command) => command.phase !== 'lost');
  }

  /** Why a job queued at `seq` may not go ahead; null when it may. */
  private gateAt(seq: number): { code: string; message: string } | null {
    for (const command of this.commands) {
      if (command.seq >= seq || command.phase === 'lost') continue;

      return command.kind === 'discard' && command.phase !== 'unknown'
        ? { code: 'DRAFT_DISCARDING', message: COMMAND_MESSAGES.discarding }
        : { code: 'DRAFT_COMMAND_UNKNOWN', message: COMMAND_MESSAGES.unknown };
    }

    if (this.submittedAt !== null && this.submittedAt < seq)
      return { code: 'DRAFT_SUBMITTED', message: COMMAND_MESSAGES.submitted };

    return null;
  }

  private queueCommand(
    kind: CommandKind,
    carried: Carried,
    intent: Pick<CommandRecord, 'input' | 'expectedPendingReviewId'>,
  ): Promise<unknown> {
    const seq = ++this.seq;
    const gate = this.gateAt(seq);

    if (gate) return Promise.reject(new WriteRefused(gate.message, gate.code));

    // Nothing autosaves what it carries, from now.
    if (this.timer) clearTimeout(this.timer);

    this.timer = null;

    const command: CommandRecord = {
      id: crypto.randomUUID(),
      kind,
      phase: 'queued',
      seq,
      carried,
      from: { ...carried.versions },
      ...intent,
      epoch: null,
    };

    this.commands.push(command);
    this.changed();

    return this.enqueue(() => this.runCommand(command));
  }

  /**
   * A command at the front of the queue. From now it has `COMMAND_BOUND_MS` to read the epoch, be
   * recorded and be answered. Expiring before its send releases it, unsent; after, it leaves the
   * queue as not known, what is queued after it stopped.
   */
  private async runCommand(command: CommandRecord): Promise<unknown> {
    const deadline = Date.now() + COMMAND_BOUND_MS;
    const release = (error: WriteRefused) => {
      this.release(command);
      throw error;
    };

    if (this.broken)
      return release(
        new WriteRefused(
          'The draft changed since you chose this. Check it, then try again.',
          'DRAFT_CHANGED_LOCALLY',
        ),
      );

    // Its base: the draft its confirmed predecessors left, never a read meanwhile.
    const base = this.tail ?? this.seen ?? ZERO;
    const epoch = await beforeDeadline(this.transport.epoch(), deadline).catch(() => null);

    if (!isEpoch(epoch) || Date.now() >= deadline)
      return release(new WriteRefused(COMMAND_MESSAGES.notSent, 'NOT_SENT'));

    command.epoch = epoch;
    command.base = base;
    command.request = this.requestOf(command, base);
    command.phase = 'sending';
    command.firstSent = Date.now();

    // Recorded before it is sent, or never sent.
    if (!this.persist()) {
      command.phase = 'queued';

      return release(new WriteRefused(COMMAND_MESSAGES.notRecorded, 'NOT_RECORDED'));
    }

    if (Date.now() >= deadline)
      return release(new WriteRefused(COMMAND_MESSAGES.notSent, 'NOT_SENT'));

    const answer = decodeCommand(this.transport.sendCommand(command.request), true, command);
    const settled = await beforeDeadline(answer, deadline).catch(() => null);

    if (!settled) {
      // Not answered in time: settled by its answer, should it still come.
      void answer.then((late) => this.settleCommand(command, late));

      return this.reconciledOr(command, () => {
        if (this.active(command)) this.settleCommand(command, { kind: 'unknown', error: null });

        throw this.unknownError(command);
      });
    }

    return this.answerOf(command, settled);
  }

  /** A command's first answer, to its caller: its receipt, or its refusal, or as not known. */
  private answerOf(command: CommandRecord, answer: CommandAnswer): unknown {
    // An answer that says nothing, after its receipt settled it: as the receipt settled it.
    if (answer.kind === 'unknown')
      return this.reconciledOr(command, () => {
        this.settleCommand(command, answer);

        throw this.unknownError(command);
      });

    this.settleCommand(command, answer);

    if (answer.kind === 'admitted') return answer.body;

    const { message, code, details, status } = answer.error;

    throw new WriteRefused(message, code, details, status);
  }

  /**
   * To its caller, how its receipt settled `command` while its own answer said nothing: admitted
   * (or a discard being cleaned up, or done), or refused. Otherwise `unsettled()`.
   */
  private reconciledOr(command: CommandRecord, unsettled: () => never): unknown {
    const outcome = this.outcomes.get(command);

    // Admitted, its receipt said, its own answer still to come: nothing to return but that.
    if (outcome === 'admitted' || phaseOf(command) === 'admitted') return null;
    if (outcome === 'refused')
      throw new WriteRefused(
        'This was not received, and cannot be now. Nothing was sent; try again.',
        'NOT_RECEIVED',
      );

    return unsettled();
  }

  private unknownError(command: CommandRecord): WriteRefused {
    return new WriteRefused(
      command.kind === 'submit' ? COMMAND_MESSAGES.submitUnknown : COMMAND_MESSAGES.discardUnknown,
      'COMMAND_UNKNOWN',
    );
  }

  /** Settles a command by an answer to one of its sends: as admitted, refused, or not known. */
  private settleCommand(command: CommandRecord, answer: CommandAnswer) {
    if (!this.active(command)) return;

    // Sent again since: a late refusal of the first send says nothing of the second.
    if (answer.kind === 'refused' && command.resent)
      answer = { kind: 'unknown', error: answer.error };

    if (answer.kind === 'refused') this.release(command);
    else if (answer.kind === 'unknown') {
      if (command.phase !== 'admitted') this.unknown(command);
    } else if (command.kind === 'submit') this.admitSubmit(command);
    else {
      command.phase = 'admitted';
      this.changed();
      this.poll();

      // A local discard is final at once: its receipt has the draft it left.
      if (answer.local) void this.reconcileOne(command);
    }
  }

  private unknown(command: CommandRecord) {
    command.phase = 'unknown';
    this.changed();
    this.poll();
  }

  /** Whether `command` is still to be settled: neither settled already, nor lost. */
  private active(command: CommandRecord): boolean {
    return this.commands.includes(command) && command.phase !== 'lost';
  }

  private async reconcileOne(command: CommandRecord): Promise<void> {
    if (this.checking.has(command.id)) return;

    this.checking.add(command.id);

    // A miss means something only for a lookup made once it was known received.
    const knownReceived = command.phase === 'admitted';

    try {
      const read = readReceipt(await this.transport.receipt(command.id), command, this.prId);

      if (!read || !this.active(command)) return;

      // Known received, and now missing: lost only when receipt history changed since it was
      // sent (a reset); otherwise the lookup crossed its admission, and proves nothing. With no
      // epoch to tell (a legacy id), it is offered "Stop it", which fences it.
      if (read.kind === 'none') {
        if (!knownReceived) return;

        if (command.epoch === null) {
          if (!command.missing) {
            command.missing = true;
            this.changed();
          }

          return;
        }

        const epoch = await this.transport.epoch();

        if (isEpoch(epoch) && epoch !== command.epoch && this.active(command))
          this.lose(command, COMMAND_MESSAGES.keptForConfirmation);

        return;
      }

      this.settleByReceipt(command, read);
    } catch {
      // Not reachable: looked up again later.
    } finally {
      this.checking.delete(command.id);
    }
  }

  /** Settles a command by what its receipt, or its stop, says: only while it is still to be. */
  private settleByReceipt(command: CommandRecord, read: ReadReceipt) {
    if (!this.active(command) || read.kind === 'none') return;

    if (read.kind === 'abandoned') {
      if (read.decision === 'not-admitted') this.release(command);
      else this.lose(command, COMMAND_MESSAGES.keptUnknown);

      return;
    }

    if (command.kind === 'submit') {
      this.admitSubmit(command);

      return;
    }

    if (!isFinal(read.status)) {
      command.phase = 'admitted';
      command.status = read.status;
      command.missing = false;
      this.changed();
      this.poll();

      return;
    }

    this.finishDiscard(command, read.status === 'succeeded', read.draft);
  }

  /** A submit admitted: what it carried is retired; what you typed since is kept to confirm. */
  private admitSubmit(command: CommandRecord) {
    this.outcomes.set(command, 'admitted');
    this.drop(command);
    this.retire(command);
    this.keepParked(COMMAND_MESSAGES.keptAfterSubmit);

    // What was queued after it stops: the draft is the review now.
    if (this.queued > 0) this.submittedAt = Math.max(this.submittedAt ?? 0, command.seq);

    this.transport.stale();
    this.changed();
  }

  /**
   * A discard's cleanup finished. Your edits resume on the draft it left: what it carried is
   * retired if it succeeded, and saved again if it was cancelled. Without that draft, or with the
   * draft changed past it since, they are kept for you to confirm.
   */
  private finishDiscard(
    command: CommandRecord,
    succeeded: boolean,
    stamp: { revision: number; generation: number } | null,
  ) {
    this.outcomes.set(command, 'admitted');
    this.drop(command);

    // Succeeded: what it carried is gone with the draft, whatever is known of the draft after.
    if (succeeded) this.retire(command);

    if (!stamp || (this.seen && this.seen.generation > stamp.generation)) {
      this.keepParked(COMMAND_MESSAGES.keptForConfirmation);
      this.changed();

      return;
    }

    // The draft it left is what anything after it acts on, the queue's run included.
    if (!this.seen || stamp.revision >= this.seen.revision) this.seen = { ...stamp };
    if (this.tail) this.tail = { ...stamp };

    for (const [field, state] of entries(this.fields)) {
      if (state.version <= state.settled || state.failed) continue;

      // Begun on the draft it left already (shown before its receipt was read): saved as it is.
      if (state.generation === stamp.generation) continue;

      // Only text begun on the draft it locked is handed to the draft it left: typed behind it,
      // or, cancelled, carried by it too. Text from another draft (another tab cleared it), or
      // with a legacy id, whose request had no base to tie it to a draft, is kept for you to
      // confirm.
      const ours =
        command.base !== undefined &&
        (state.generation === null || state.generation === command.base.generation);
      const handed = state.version > command.from[field] || !succeeded;

      if (ours && handed) state.generation = stamp.generation;
      else state.failed = COMMAND_MESSAGES.keptForConfirmation;
    }

    this.transport.stale();
    this.changed();
    void this.flush();
  }

  /** Released, unsent or refused: your edits are saved as before, on the draft they began on. */
  private release(command: CommandRecord) {
    this.outcomes.set(command, 'refused');
    this.drop(command);
    this.changed();
    void this.flush();
  }

  /**
   * Stopped without knowing whether it was received before: it never can be after, so the gate
   * lifts; your edits are kept for you to confirm, and it is shown until you dismiss it.
   */
  private lose(command: CommandRecord, reason: string) {
    this.outcomes.set(command, 'lost');
    command.phase = 'lost';
    this.keepParked(reason);
    this.changed();
  }

  private drop(command: CommandRecord) {
    this.commands = this.commands.filter((other) => other !== command);

    // A legacy id settled: its outcome is journaled, so the earlier record of it may go too.
    if (command.legacy && this.unjournaled.has(command.id))
      this.settledLegacy = [...this.settledLegacy, command.id];
  }

  /** The versions a command carried, retired: never saved by a field's autosave after. */
  private retire(command: CommandRecord) {
    for (const [field, version] of entries(command.carried?.versions ?? {})) {
      const state = this.fields[field];

      if (version > state.settled) {
        state.settled = version;
        state.savedAt = 0;
      }

      // Only the outcome of a save of what it carried is retired: a newer save's still counts.
      if (state.lastSave && state.lastSave.version <= version) state.lastSave = null;
      if (state.version === version) state.failed = null;
    }
  }

  /** Every unsaved edit kept, refused with `reason`, until you edit it. */
  private keepParked(reason: string) {
    for (const state of Object.values(this.fields))
      if (state.version > state.settled && !state.failed) state.failed = reason;
  }

  private requestOf(command: CommandRecord, base: Base): CommandRequest {
    const guard = {
      operationId: command.id,
      baseRevision: base.revision,
      baseGeneration: base.generation,
    };

    return command.kind === 'submit'
      ? {
          route: 'submit',
          params: { account: this.account, id: this.prId },
          body: {
            ...command.input,
            ...guard,
            expectedPendingReviewId: command.expectedPendingReviewId ?? null,
          },
        }
      : { route: 'discard', params: { account: this.account, id: this.prId }, body: guard };
  }

  private poll() {
    if (this.poller || !(this.commands.some(needsLookup) || this.writes.some(writeNeedsLookup)))
      return;

    this.poller = setInterval(() => void this.reconcile(), this.pollMs);
  }

  private stopPolling() {
    if (this.poller) clearInterval(this.poller);

    this.poller = null;
  }

  /** Runs `job` after every write before it. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    // A run of the queue begins on the draft as shown.
    if (this.queued === 0) this.tail = this.seen ?? ZERO;

    this.queued += 1;

    const run = this.chain.then(job);

    this.chain = run.then(
      () => this.drained(),
      () => this.drained(),
    );

    return run;
  }

  private drained() {
    this.queued -= 1;

    // Nothing queued: the next write acts on the draft as shown, and nothing ahead of it broke.
    if (this.queued === 0) {
      this.tail = null;
      this.broken = false;
      this.submittedAt = null;
    }
  }

  /** The base a write queued now acts on: the draft shown, or, behind others, the queue's tail. */
  private baseNow(): Base | 'chain' {
    return this.queued === 0 ? (this.seen ?? ZERO) : 'chain';
  }

  /** A new write's guard: a sealed id, and the base it acts on as it is about to be sent. */
  private async guard(base: Base | 'chain'): Promise<Guard> {
    const writeId = await this.sealedId();
    const resolved = base === 'chain' ? (this.tail ?? this.seen ?? ZERO) : base;

    return { writeId, baseRevision: resolved.revision, baseGeneration: resolved.generation };
  }

  /**
   * A new write id, sealed with the server's claim checkpoint: read once and kept, read again
   * after a restart (`forgetCheckpoint`) or a refusal that says it is stale. Waits, as a write
   * with no answer does, while it cannot be read.
   */
  private async sealedId(): Promise<string> {
    let sealing = this.sealing;

    for (let attempt = 0; !sealing; attempt++) {
      sealing = await this.transport.checkpoint().then(readCheckpoint, () => null);

      if (!sealing) await sleep(this.backoff(attempt));
    }

    this.sealing = sealing;

    return `ck1-${sealing.checkpoint}-${sealing.seal}-${crypto.randomUUID()}`;
  }

  /** The server may have restarted: new write ids are sealed with a checkpoint read again. */
  forgetCheckpoint() {
    this.sealing = null;
  }

  /** A new attempt of `request` under `guard`. */
  private attempt(
    guard: Guard,
    request: WriteRequest,
    saved?: Pick<Inflight, 'fields' | 'meta'>,
  ): Inflight {
    return {
      writeId: guard.writeId,
      request: { ...request, body: { ...request.body, ...guardOf(guard) } },
      base: { revision: guard.baseRevision, generation: guard.baseGeneration },
      deadline: Date.now() + ATTEMPT_TTL_MS,
      stamp: this.transport.stamp(),
      ...saved,
    };
  }

  /** A write on a base of `generation` committed at `revision`: the next queued acts on it. */
  private advance(revision: number, generation: number) {
    this.tail = { revision, generation };

    if (!this.seen || revision > this.seen.revision) this.seen = { revision, generation };
  }

  /** A write met a change elsewhere: shown, and what is queued behind it stops, on that draft. */
  private conflicted(draft: ReviewDraft, stamp: number) {
    const versions = draft.versions!;

    this.observe(draft);
    this.transport.committed(draft, stamp);
    this.broken = true;
    this.tail = { revision: versions.revision, generation: versions.generation };
  }

  /** What each of `fields` holds now, marked queued. */
  private snapshotOf(fields: Field[]): Partial<Record<Field, Snapshot>> {
    const snapshot: Partial<Record<Field, Snapshot>> = {};

    for (const field of fields) {
      const state = this.fields[field];

      snapshot[field] = {
        value: state.value,
        version: state.version,
        generation: state.generation,
        since: state.since,
      };
      state.queued = state.version;
    }

    return snapshot;
  }

  /** What a resumed autosave carried, for each of its fields not settled since. */
  private restoredSnapshot(write: Inflight): Partial<Record<Field, Snapshot>> {
    const snapshot: Partial<Record<Field, Snapshot>> = {};

    for (const [field, version] of entries(write.fields ?? {})) {
      const value = write.request.body[field];
      const began = write.meta?.[field];

      // Where its text began, as it was sent: never renewed by an edit since.
      if (version > this.fields[field].settled && typeof value === 'string' && began)
        snapshot[field] = { value, version, ...began };
    }

    return snapshot;
  }

  /** The outcomes of the latest saves queued of `fields`, as of now. */
  private savesOf(fields: Field[]): Promise<boolean[]> {
    return Promise.all(fields.map((field) => this.fields[field].lastSave?.kept ?? true));
  }

  /** Whether any of `fields` is refused, or its latest save before this was not kept. */
  private unsaved(fields: Field[], saves: boolean[]): boolean {
    return saves.includes(false) || this.failureOf(fields) !== null;
  }

  private failureOf(fields: Field[]): string | null {
    return fields.map((field) => this.fields[field].failed).find(Boolean) ?? null;
  }

  /**
   * Takes out of `snapshot`, as it is about to be sent, each field that must not be: settled since
   * (kept), from more than a week ago, or begun on another generation (each kept, refused). A save
   * queued before a command is its predecessor, and is sent as any other.
   */
  private sendable(snapshot: Partial<Record<Field, Snapshot>>, guard: Guard, kept: Committed) {
    const now = Date.now();

    for (const [field, saved] of entries(snapshot)) {
      const state = this.fields[field];
      const reason = isOld(saved.since, now)
        ? EXPIRED
        : saved.generation !== null && saved.generation !== guard.baseGeneration
          ? DISCARDED_ELSEWHERE
          : null;

      // Settled since it was queued (a submit that carried it was accepted): nothing to send,
      // and nothing refused.
      if (saved.version <= state.settled) kept.add(field);
      else if (reason) this.failFields({ [field]: saved.version }, reason);
      else continue;

      delete snapshot[field];
    }
  }

  private async save(
    snapshot: Partial<Record<Field, Snapshot>>,
    base: Base | 'chain',
  ): Promise<Committed> {
    let guard = await this.guard(base);
    // Fields settled by the time they were to be sent: kept, as a commit of them is.
    const kept: Committed = new Set();
    let afresh = 0;

    for (;;) {
      this.sendable(snapshot, guard, kept);

      const sent = entries(snapshot);

      if (sent.length === 0) return kept;

      const fields = Object.fromEntries(sent.map(([field, saved]) => [field, saved.version]));
      const values = Object.fromEntries(sent.map(([field, saved]) => [field, saved.value]));
      const meta = Object.fromEntries(
        sent.map(([field, saved]) => [field, { generation: saved.generation, since: saved.since }]),
      );
      const write = this.attempt(
        guard,
        { route: 'saveDraft', params: { account: this.account, id: this.prId }, body: values },
        { fields, meta },
      );
      const outcome = await this.dispatch(write);

      if (outcome.kind === 'committed') {
        this.settleFields(fields, outcome.revision);
        this.advance(outcome.revision, write.base.generation);

        if (isDraft(outcome.body)) this.transport.committed(outcome.body, write.stamp);
        else this.transport.stale();

        return new Set([...kept, ...sent.map(([field]) => field)]);
      }

      if (outcome.kind === 'conflict') {
        this.conflicted(outcome.draft, write.stamp);

        // Changed by another tab or window: your newest edit wins, on the draft as it is now.
        // Discarded, submitted or locked since: nothing is sent into another draft.
        if (outcome.draft.versions!.generation === guard.baseGeneration) {
          guard = await this.guard('chain');
          continue;
        }

        this.failFields(fields, DISCARDED_ELSEWHERE);

        return kept;
      }

      // Not found, and the server cannot tell whether it was received: sealed by a server since
      // restarted, and never received by it. The very text is saved afresh under a new id, on the
      // draft as it is: a save only sets what it carries, so nothing is applied twice.
      if (outcome.kind === 'unconfirmed' && afresh < 3) {
        afresh += 1;
        guard = await this.guard('chain');
        continue;
      }

      this.failFields(fields, refusalOf(outcome).message);

      return kept;
    }
  }

  /** An autosave the journal kept across a reload: sent again as it was, by its id. */
  private async resume(write: Inflight): Promise<Committed> {
    const fields = write.fields ?? {};
    const outcome = await this.dispatch(write, false);

    if (outcome.kind === 'committed') {
      this.settleFields(fields, outcome.revision);
      this.advance(outcome.revision, write.base.generation);
      this.transport.stale();

      return new Set(Object.keys(fields) as Field[]);
    }

    if (outcome.kind === 'conflict') {
      this.conflicted(outcome.draft, write.stamp);

      // Changed elsewhere since, the same draft: the very text it carried is saved again on the
      // draft as it is, in this job, so what waits behind it waits for that too. Anything typed
      // since is left to its own save.
      if (outcome.draft.versions!.generation === write.base.generation)
        return this.save(this.restoredSnapshot(write), 'chain');

      this.failFields(fields, DISCARDED_ELSEWHERE);

      return new Set();
    }

    // Sealed by a server since restarted, and not received by it: saved afresh, as in `save`.
    if (outcome.kind === 'unconfirmed') return this.save(this.restoredSnapshot(write), 'chain');

    this.failFields(fields, refusalOf(outcome).message);

    return new Set();
  }

  /**
   * Sends a write and learns its outcome. An answer that says nothing is sent again as it was,
   * the same id answering once; one still on its way is looked up until it settles. Nothing is
   * sent, nor looked up, past its deadline: it is then taken as unconfirmed. A first send refused
   * before any claim, sealed by a server since restarted, is sealed afresh and sent as new; an id
   * sent before keeps its own, and is `unconfirmed` once the server can no longer tell.
   */
  private async dispatch(write: Inflight, first = true, record?: AttemptRecord): Promise<Settled> {
    this.inflight = [...this.inflight.filter((other) => other.writeId !== write.writeId), write];
    this.changed();

    // Whether the id on its way has been sent only once: only then may a gap be sealed afresh.
    let fresh = first;
    let resealed = 0;
    const send = (isFirst: boolean) => {
      fresh = isFirst;

      return Date.now() >= write.deadline
        ? Promise.resolve(notConfirmed())
        : decode(this.transport.send(write.request), isFirst, write);
    };
    let outcome = await send(first);
    let attempt = 0;

    while (outcome.kind === 'pending' || outcome.kind === 'unknown' || outcome.kind === 'gap') {
      if (outcome.kind === 'gap') {
        if (!fresh || resealed >= 3) {
          outcome = { kind: 'unconfirmed' };
          break;
        }

        resealed += 1;
        this.sealing = null;
        this.reseal(write, await this.sealedId(), record);

        // A journaled write is recorded under its new id before it is sent.
        if (record && !this.persist()) {
          outcome = {
            kind: 'refused',
            error: new ApiError(COMMAND_MESSAGES.notRecorded, 0, 'NOT_RECORDED'),
          };
          break;
        }

        outcome = await send(true);
        continue;
      }

      await sleep(this.backoff(attempt++));

      if (Date.now() >= write.deadline) {
        outcome = notConfirmed();
        break;
      }

      if (outcome.kind === 'pending') {
        const looked = await this.transport
          .lookup(write.writeId, write.base)
          .then((answer) => fromLookup(answer, write))
          .catch((): 'resend' => 'resend');

        // It never arrived and never can: as refused, nothing saved.
        if (looked === 'never') {
          outcome = {
            kind: 'refused',
            error: new ApiError('This write did not reach the server.', 409, 'NOT_RECEIVED'),
          };
          break;
        }

        // Not found, and nothing can tell whether it was received: nothing more is sent.
        if (looked === 'unknown') {
          outcome = { kind: 'unconfirmed' };
          break;
        }

        outcome = looked === 'resend' ? await send(false) : looked;
      } else outcome = await send(false);
    }

    this.inflight = this.inflight.filter((other) => other.writeId !== write.writeId);
    this.changed();

    return outcome as Settled;
  }

  /** `write` under a new id: never sent before, so nothing of it can have been received. */
  private reseal(write: Inflight, writeId: string, record?: AttemptRecord) {
    write.writeId = writeId;
    write.request = { ...write.request, body: { ...write.request.body, writeId } };

    if (record) {
      record.writeId = writeId;
      record.request = write.request;
    }

    this.changed();
  }

  private settleFields(fields: Partial<Record<Field, number>>, revision: number) {
    for (const [field, version] of entries(fields)) {
      const state = this.fields[field];

      if (version > state.settled) {
        state.settled = version;
        state.savedAt = revision;
      }

      // Its very text is saved: a refusal of it (an expiry on restore, say) no longer holds.
      if (version === state.version) state.failed = null;
    }

    this.changed();
  }

  /** Marks each field refused, if it still holds the version refused: an edit since is the next save's. */
  private markFailed(fields: Partial<Record<Field, number>>, reason: string): boolean {
    let failed = false;

    for (const [field, version] of entries(fields)) {
      const state = this.fields[field];

      // A refusal of a version settled since (a submit carried it) is late: it no longer holds.
      if (state.version === version && version > state.settled) {
        state.failed = reason;
        failed = true;
      }
    }

    return failed;
  }

  private failFields(fields: Partial<Record<Field, number>>, reason: string) {
    const failed = this.markFailed(fields, reason);

    this.changed();

    if (failed) this.transport.refused(reason);
  }
}

const entries = <V>(record: Partial<Record<Field, V>>) => Object.entries(record) as [Field, V][];

/** Whether unsaved text begun at `since` is older than a week by `now`. */
const isOld = (since: number | null, now: number) =>
  since !== null && now - since >= ATTEMPT_TTL_MS;

const guardOf = (guard: Guard) => ({
  writeId: guard.writeId,
  baseRevision: guard.baseRevision,
  baseGeneration: guard.baseGeneration,
});

function refusalOf(outcome: Outcome): WriteRefused {
  if (outcome.kind === 'refused') {
    const { message, code, details, status } = outcome.error;

    return new WriteRefused(message, code, details, status);
  }

  if (outcome.kind === 'conflict')
    return new WriteRefused('The draft changed since you saw it.', 'DRAFT_REVISION_CONFLICT', {
      draft: outcome.draft,
    });

  return new WriteRefused(NOT_CONFIRMED, 'NOT_CONFIRMED');
}

const strip = ({ queued: _queued, lastSave: _lastSave, ...state }: FieldState) => state;

/** A command's phase, read afresh: it may move while a send of it is awaited. */
const phaseOf = (command: CommandRecord): CommandRecord['phase'] => command.phase;

/** A receipt-history epoch as the server issues it: anything else is no evidence. */
const isEpoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Whether a command's outcome, or its cleanup, is still to be looked up. */
const needsLookup = (command: CommandRecord) =>
  command.phase === 'unknown' || command.phase === 'admitted' || command.phase === 'sending';

/** Whether a write may have been received, and is to be looked up. */
const writeNeedsLookup = (record: AttemptRecord) =>
  (record.phase === 'checking' || record.phase === 'unknown') && record.writeId !== undefined;

/** `promise`, or a rejection once `deadline` passes first. */
function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Past its deadline.')),
      Math.max(0, deadline - Date.now()),
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function readJournal(account: string, prId: string): Journal | null {
  try {
    const text = sessionStorage.getItem(journalKey(account, prId));

    return text ? (JSON.parse(text) as Journal) : null;
  } catch {
    return null;
  }
}

/** Writes the journal; false when it could not be (storage full, or not available). */
function writeJournal(account: string, prId: string, journal: Journal): boolean {
  try {
    // A refused field is unsettled too: kept until you edit it, a reload included.
    const empty =
      journal.inflight.length === 0 &&
      (journal.commands ?? []).length === 0 &&
      (journal.settledLegacy ?? []).length === 0 &&
      (journal.writes ?? []).length === 0 &&
      journal.fields.body.version <= journal.fields.body.settled &&
      journal.fields.event.version <= journal.fields.event.settled;

    if (empty) sessionStorage.removeItem(journalKey(account, prId));
    else sessionStorage.setItem(journalKey(account, prId), JSON.stringify(journal));

    return true;
  } catch {
    // The server's copy is authoritative; the journal is a safety net, which a command needs.
    return false;
  }
}

const writers = new WeakMap<object, Map<string, DraftWriter>>();

/**
 * The writer of `account`'s draft of `prId` within `scope` (the page's query client): one per
 * page, shared by every editor of it.
 */
export function draftWriter(
  scope: object,
  account: string,
  prId: string,
  transport: () => Transport,
  /** Run once, as the writer is made. */
  made: (writer: DraftWriter) => void = () => {},
): DraftWriter {
  const key = `${account}\u0000${prId}`;
  const scoped = writers.get(scope) ?? new Map<string, DraftWriter>();
  let writer = scoped.get(key);

  writers.set(scope, scoped);

  if (!writer) {
    writer = new DraftWriter(account, prId, transport());
    scoped.set(key, writer);
    made(writer);
  }

  return writer;
}
