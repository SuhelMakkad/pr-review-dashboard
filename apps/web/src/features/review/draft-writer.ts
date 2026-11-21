import type { ReviewDraft, ReviewEvent } from '@review-desk/shared/review';
import { ApiError } from '@/lib/api';

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

/** What a write's answer, or its lookup, decodes to. */
export type Outcome =
  | { kind: 'committed'; body: unknown; revision: number }
  | { kind: 'pending' }
  | { kind: 'conflict'; draft: ReviewDraft }
  | { kind: 'refused'; error: ApiError }
  | { kind: 'unknown'; error: unknown };

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
  /** The account-switch stamp now: a write's answer is shown only under the stamp it was sent at. */
  stamp(): number;
  /** The draft a write left, or the server's draft that refused it, from a write sent at `stamp`. */
  committed(draft: ReviewDraft, stamp: number): void;
  /** A change the queue cannot show itself (a comment write): the draft is read again. */
  stale(): void;
  /** A save was refused: says why, even when no editor of the draft is open. */
  refused(reason: string): void;
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
 * Decodes a lookup's answer: `never` means the write did not arrive and never can commit; `resend`
 * that it may yet, or that the answer could not be read, so the write is sent again as it was.
 */
export function fromLookup(answer: unknown, expected: Expected): Outcome | 'never' | 'resend' {
  if (!isObject(answer)) return 'resend';

  if (!('attempt' in answer))
    return answer.arrived === false && typeof answer.fenced === 'boolean'
      ? answer.fenced
        ? 'never'
        : 'resend'
      : 'resend';

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
   * The running commands (submit, discard) that hold it, each with the version it carries: no
   * autosave of it while any does.
   */
  owned: Map<symbol, number>;
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
  fields: Record<Field, Omit<FieldState, 'queued' | 'owned' | 'lastSave'>>;
  inflight: Omit<Inflight, 'stamp'>[];
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
  private timer: ReturnType<typeof setTimeout> | null = null;
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
      owned: new Map(),
      lastSave: null,
    });
    // After a reload nothing is queued: an unsaved edit is saved again, besides the very save
    // the journal kept. A refused one stays refused, kept until you edit it.
    const restored = (field: Field): FieldState =>
      saved
        ? {
            ...saved.fields[field],
            queued: saved.fields[field].settled,
            owned: new Map(),
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

    for (const write of saved?.inflight ?? []) {
      const fields = write.fields ?? {};

      if (now >= write.deadline) {
        this.markFailed(fields, NOT_CONFIRMED);
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
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.version += 1;
    writeJournal(this.account, this.prId, {
      fields: { body: strip(this.fields.body), event: strip(this.fields.event) },
      inflight: this.inflight
        .filter((write) => write.fields)
        .map(({ stamp: _stamp, ...write }) => write),
    });

    for (const listener of this.listeners) listener();
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

      return (
        state.version > Math.max(state.settled, state.queued) &&
        !state.failed &&
        state.owned.size === 0
      );
    });

    if (fields.length === 0) return Promise.resolve();

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
    void this.flush();

    const saves = this.savesOf(fields);

    await this.enqueue(async () => {});

    return this.unsaved(fields, await saves) ? (this.failureOf(fields) ?? UNSAVED) : null;
  }

  /**
   * Queues a draft write (a comment's add, edit or delete, an AI accept, apply or prepare): sent
   * after every write before it, on the draft you saw, with its own id. Resolves with its answer
   * once it committed; rejects with `WriteRefused` when it was refused, its input yours to keep.
   * One that `replaces` the summary or verdict is refused unless your own text of it was kept.
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

    return this.enqueue(async () => {
      if (base === 'chain' && this.broken)
        throw new WriteRefused(
          'The draft changed since you chose this. Check it, then try again.',
          'DRAFT_CHANGED_LOCALLY',
        );

      // Whatever was typed since, the saves it was queued behind must have kept your text.
      if (this.unsaved(replaces, await saves))
        throw new WriteRefused(UNSAVED_REPLACED, 'DRAFT_EDIT_UNSAVED');

      const write = this.attempt(this.guard(base), { route, params, body });
      const outcome = await this.dispatch(write);

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

      throw refusalOf(outcome);
    });
  }

  /**
   * Runs a command (submit, discard) that carries or drops `fields`, at the versions it was sent
   * with (`carried`, as `versions()` gave them with its values; as they are now if not given):
   * none of them is autosaved while it runs, even by a save queued or retried before it. Its
   * failure releases them, to be saved as before. Its success either retires what it carried (a
   * submit: it is in the review), or keeps your unsaved text, unsent, until you edit it (a
   * discard: cleanup may yet not happen).
   */
  async command<T>(
    fields: Field[],
    run: () => Promise<T>,
    onSuccess: 'retire' | 'keep',
    carried: Partial<Record<Field, number>> = this.versions(fields),
  ): Promise<T> {
    if (this.timer) clearTimeout(this.timer);

    this.timer = null;

    const token = Symbol('command');
    const owned = new Map(
      fields.map((field) => [field, carried[field] ?? this.fields[field].version]),
    );

    for (const [field, version] of owned) this.fields[field].owned.set(token, version);

    this.changed();

    // Each command releases only its own hold: another running still holds the field.
    const release = () => {
      for (const field of owned.keys()) this.fields[field].owned.delete(token);
    };

    try {
      const result = await run();

      release();

      for (const [field, version] of owned) {
        const state = this.fields[field];

        if (onSuccess === 'keep') {
          if (state.version > state.settled) state.failed = KEPT_FROM_DISCARD;

          continue;
        }

        if (version > state.settled) {
          state.settled = version;
          state.savedAt = 0;
        }

        // Only the outcome of a save of what it carried is retired: a newer save's still counts.
        if (state.lastSave && state.lastSave.version <= version) state.lastSave = null;

        if (state.version === version) state.failed = null;
      }

      return result;
    } catch (error) {
      release();

      throw error;
    } finally {
      this.changed();
      // An edit made meanwhile, or one released, is saved now.
      void this.flush();
    }
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
    }
  }

  /** The base a write queued now acts on: the draft shown, or, behind others, the queue's tail. */
  private baseNow(): Base | 'chain' {
    return this.queued === 0 ? (this.seen ?? ZERO) : 'chain';
  }

  private guard(base: Base | 'chain'): Guard {
    const resolved = base === 'chain' ? (this.tail ?? this.seen ?? ZERO) : base;

    return {
      writeId: crypto.randomUUID(),
      baseRevision: resolved.revision,
      baseGeneration: resolved.generation,
    };
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

  /** Whether a command holds any field `write` carries. */
  private held(write: Inflight): boolean {
    return entries(write.fields ?? {}).some(([field]) => this.fields[field].owned.size > 0);
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
   * Takes out of `snapshot`, as it is about to be sent, each field that must not be: held by a
   * command (sent again once it releases it), from more than a week ago, or begun on another
   * generation (each kept, refused).
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
      else if (state.owned.size > 0) {
        if (state.queued === saved.version) state.queued = state.settled;
      } else if (reason) this.failFields({ [field]: saved.version }, reason);
      else continue;

      delete snapshot[field];
    }
  }

  private async save(
    snapshot: Partial<Record<Field, Snapshot>>,
    base: Base | 'chain',
  ): Promise<Committed> {
    let guard = this.guard(base);
    // Fields settled by the time they were to be sent: kept, as a commit of them is.
    const kept: Committed = new Set();

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
          guard = this.guard('chain');
          continue;
        }

        this.failFields(fields, DISCARDED_ELSEWHERE);

        return kept;
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

    this.failFields(fields, refusalOf(outcome).message);

    return new Set();
  }

  /**
   * Sends a write and learns its outcome. An answer that says nothing is sent again as it was,
   * the same id answering once; one still on its way is looked up until it settles. While a
   * command holds a field it carries, it is only looked up, never sent again: a resend could be
   * its first delivery. Nothing is sent, nor looked up, past its deadline: it is then taken as
   * unconfirmed.
   */
  private async dispatch(
    write: Inflight,
    first = true,
  ): Promise<Exclude<Outcome, { kind: 'pending' } | { kind: 'unknown' }>> {
    this.inflight = [...this.inflight.filter((other) => other.writeId !== write.writeId), write];
    this.changed();

    const send = (isFirst: boolean) =>
      Date.now() >= write.deadline
        ? Promise.resolve(notConfirmed())
        : decode(this.transport.send(write.request), isFirst, write);
    let outcome = await send(first);
    let attempt = 0;

    while (outcome.kind === 'pending' || outcome.kind === 'unknown') {
      await sleep(this.backoff(attempt++));

      if (Date.now() >= write.deadline) {
        outcome = notConfirmed();
        break;
      }

      const held = this.held(write);

      if (outcome.kind === 'pending' || held) {
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

        // Held again by the time the lookup answered: still only looked up.
        if (looked !== 'resend') outcome = looked;
        else if (!this.held(write)) outcome = await send(false);
      } else outcome = await send(false);
    }

    this.inflight = this.inflight.filter((other) => other.writeId !== write.writeId);
    this.changed();

    return outcome as Exclude<Outcome, { kind: 'pending' } | { kind: 'unknown' }>;
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

const strip = ({ queued: _queued, owned: _owned, lastSave: _lastSave, ...state }: FieldState) =>
  state;

function readJournal(account: string, prId: string): Journal | null {
  try {
    const text = sessionStorage.getItem(journalKey(account, prId));

    return text ? (JSON.parse(text) as Journal) : null;
  } catch {
    return null;
  }
}

function writeJournal(account: string, prId: string, journal: Journal) {
  try {
    // A refused field is unsettled too: kept until you edit it, a reload included.
    const empty =
      journal.inflight.length === 0 &&
      journal.fields.body.version <= journal.fields.body.settled &&
      journal.fields.event.version <= journal.fields.event.settled;

    if (empty) sessionStorage.removeItem(journalKey(account, prId));
    else sessionStorage.setItem(journalKey(account, prId), JSON.stringify(journal));
  } catch {
    // The server's copy is authoritative; the journal is a safety net.
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
): DraftWriter {
  const key = `${account}\u0000${prId}`;
  const scoped = writers.get(scope) ?? new Map<string, DraftWriter>();
  let writer = scoped.get(key);

  writers.set(scope, scoped);

  if (!writer) {
    writer = new DraftWriter(account, prId, transport());
    scoped.set(key, writer);
  }

  return writer;
}
