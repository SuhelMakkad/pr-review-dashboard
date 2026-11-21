import type { DraftAttempt, ReviewDraft, ReviewEvent } from '@review-desk/shared/review';
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

/** The lookup's answer for an attempt (see `routes.draftAttempt`). */
export type LookupAnswer =
  { attempt: DraftAttempt & { result?: unknown } } | { arrived: false; fenced: boolean };

/** How the writer reaches the server: injected, so it runs without React or a network in tests. */
export interface Transport {
  send(request: WriteRequest): Promise<unknown>;
  lookup(writeId: string, base: Base): Promise<LookupAnswer>;
  /** The draft as the write that committed left it, or as the server has it now: shown at once. */
  committed(draft: ReviewDraft | null): void;
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

/** Decodes a write's answer. Only a decoded attempt settles it; anything else stays unknown. */
export async function decode(answer: Promise<unknown>, first: boolean): Promise<Outcome> {
  try {
    const body = (await answer) as { pending?: true; attempt?: DraftAttempt };

    if (body?.pending) return { kind: 'pending' };
    if (body?.attempt?.state === 'committed')
      return { kind: 'committed', body, revision: body.attempt.revision };

    return { kind: 'unknown', error: new Error('The answer carried no outcome.') };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: 'unknown', error };

    const attempt = error.details.attempt as DraftAttempt | undefined;

    if (attempt?.state === 'refused')
      return error.code === 'DRAFT_REVISION_CONFLICT' && error.details.draft
        ? { kind: 'conflict', draft: error.details.draft as ReviewDraft }
        : { kind: 'refused', error };

    // No outcome recorded: no answer, an unreadable one, or a refusal before the claim (a session
    // or schema check). Definite only when nothing earlier of this write may have arrived.
    if (error.status === 0 || error.code === 'UNREADABLE') return { kind: 'unknown', error };

    return first ? { kind: 'refused', error } : { kind: 'unknown', error };
  }
}

/** Decodes a lookup's answer; `never` means the write did not arrive and never can commit. */
export function fromLookup(answer: LookupAnswer): Outcome | 'never' | 'resend' {
  if (!('attempt' in answer)) return answer.fenced ? 'never' : 'resend';

  const { attempt } = answer;
  const result = attempt.result as { body?: unknown; status?: number } | undefined;

  if (attempt.state === 'pending') return { kind: 'pending' };
  if (attempt.state === 'committed')
    return { kind: 'committed', body: result?.body, revision: attempt.revision };

  const body = (result?.body ?? {}) as { error?: string; code?: string; draft?: ReviewDraft };
  const error = new ApiError(body.error ?? 'Not saved.', result?.status ?? 409, body.code, body);

  return body.code === 'DRAFT_REVISION_CONFLICT' && body.draft
    ? { kind: 'conflict', draft: body.draft }
    : { kind: 'refused', error };
}

interface FieldState {
  value: string;
  /** Raised by every edit. */
  version: number;
  /** The highest version the server confirmed saved. */
  settled: number;
  /** The highest version a queued save carries: a flush never queues it twice. */
  queued: number;
  /** The draft revision that save made: the editor shows its value until the draft shows it. */
  savedAt: number;
  /** Why its latest save was refused; it is kept, not sent again, until you edit it. */
  failed: string | null;
  /** The draft generation shown when it was edited: never sent into another (a discard's next). */
  generation: number | null;
}

/** A write sent and not yet settled. */
interface Inflight {
  writeId: string;
  request: WriteRequest;
  base: Base;
  /** For a meta save, the field versions it carries: only these are journaled. */
  fields?: Partial<Record<Field, number>>;
}

/**
 * What a reload keeps: each field, and the autosaves on their way, sent again after it with the
 * same id. A comment or AI write is not resent after a reload: the draft read then shows whether
 * it was kept.
 */
interface Journal {
  fields: Record<Field, Omit<FieldState, 'queued'>>;
  inflight: Inflight[];
  /** When it was written: one older than `JOURNAL_TTL_MS` is not restored. */
  written: number;
}

const DEBOUNCE_MS = 800;
const JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const journalKey = (account: string, prId: string) => `review-desk-draft-writer:${account}:${prId}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DraftWriter {
  private readonly fields: Record<Field, FieldState>;
  private inflight: Inflight[];
  private chain: Promise<void> = Promise.resolve();
  /** Writes queued or running. */
  private queued = 0;
  /** The draft as last read or written: what a write queued while nothing runs acts on. */
  private seen: Base | null = null;
  /** The revision the queue's last committed write made: what the next queued write acts on. */
  private last: Base | null = null;
  /** A write in this run of the queue was refused or rebased: actions behind it stop. */
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
    const fresh = (field: Field): FieldState => ({
      value: field === 'event' ? 'COMMENT' : '',
      version: 0,
      settled: 0,
      queued: 0,
      savedAt: 0,
      failed: null,
      generation: null,
    });
    // After a reload nothing is queued: an unsaved edit is saved again, besides the very save
    // the journal kept. A refused one stays refused, kept until you edit it.
    const restored = (field: Field): FieldState =>
      saved ? { ...saved.fields[field], queued: saved.fields[field].settled } : fresh(field);

    this.fields = { body: restored('body'), event: restored('event') };
    this.inflight = saved?.inflight ?? [];

    // Autosaves a reload interrupted are sent again as they were: each answers once, by its id.
    for (const write of this.inflight) void this.enqueue(() => this.resume(write));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.version += 1;
    writeJournal(this.account, this.prId, {
      fields: {
        body: strip(this.fields.body),
        event: strip(this.fields.event),
      },
      inflight: this.inflight.filter((write) => write.fields),
      written: Date.now(),
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

  /** You typed `value` into `field`: saved after a pause (the body) or at once (the verdict). */
  edit<F extends Field>(field: F, value: FieldValue<F>) {
    const state = this.fields[field];

    state.value = value;
    state.version += 1;
    state.failed = null;
    // Edited on the draft as shown: a refused edit typed again is yours for this draft.
    state.generation = this.seen?.generation ?? null;
    this.changed();

    if (this.timer) clearTimeout(this.timer);

    if (field === 'event') void this.flush();
    else this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  /** Saves every unsaved field now, with what each holds as this is called. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);

    this.timer = null;

    const fields = (['body', 'event'] as const).filter((field) => {
      const state = this.fields[field];

      return state.version > Math.max(state.settled, state.queued) && !state.failed;
    });

    if (fields.length === 0) return Promise.resolve();

    // Resolved now, not when it runs: an edit after this is the next save's.
    const snapshot = Object.fromEntries(
      fields.map((field) => [
        field,
        { value: this.fields[field].value, version: this.fields[field].version },
      ]),
    ) as Partial<Record<Field, { value: string; version: number }>>;
    const base = this.baseNow();

    for (const field of fields) this.fields[field].queued = this.fields[field].version;

    return this.enqueue(() => this.save(snapshot, base));
  }

  /**
   * Queues a draft write (a comment's add, edit or delete, an AI accept, apply or prepare): sent
   * after every write before it, on the draft you saw, with its own id. Resolves with its answer
   * once it committed; rejects with `WriteRefused` when it was refused, its input yours to keep.
   */
  write<T>(
    route: string,
    params: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<T> {
    // Pending edits go first, saved with what they hold now.
    void this.flush();

    const base = this.baseNow();

    return this.enqueue(async () => {
      if (base === 'chain' && this.broken)
        throw new WriteRefused(
          'The draft changed since you chose this. Check it, then try again.',
          'DRAFT_CHANGED_LOCALLY',
        );

      const guard = this.guard(base);
      const write: Inflight = {
        writeId: guard.writeId,
        request: { route, params, body: { ...body, ...guardOf(guard) } },
        base: baseOf(guard),
      };
      const outcome = await this.dispatch(write);

      if (outcome.kind === 'committed') {
        this.advance(outcome.revision);

        // An answer that is the draft (apply, prepare) is shown at once; another, read again.
        if (isDraft(outcome.body)) {
          this.retireFailed(outcome.revision);
          this.transport.committed(outcome.body);
        } else this.transport.stale();

        return outcome.body as T;
      }

      this.broken = true;

      if (outcome.kind === 'conflict') {
        this.observe(outcome.draft);
        this.transport.committed(outcome.draft);

        throw new WriteRefused(
          'The draft changed since you saw it. Nothing was saved; check it, then try again.',
          'DRAFT_REVISION_CONFLICT',
          { draft: outcome.draft },
        );
      }

      throw refusalOf(outcome);
    });
  }

  /** Runs `job` after every write before it. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
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
      this.last = null;
      this.broken = false;
    }
  }

  /** The base a write queued now acts on: the draft shown, or, behind others, their last commit. */
  private baseNow(): Base | 'chain' {
    return this.queued === 0 ? (this.seen ?? { revision: 0, generation: 0 }) : 'chain';
  }

  private guard(base: Base | 'chain'): Guard {
    const resolved =
      base === 'chain' ? (this.last ?? this.seen ?? { revision: 0, generation: 0 }) : base;

    return {
      writeId: crypto.randomUUID(),
      baseRevision: resolved.revision,
      baseGeneration: resolved.generation,
    };
  }

  private advance(revision: number) {
    const generation = this.last?.generation ?? this.seen?.generation ?? 0;

    this.last = { revision, generation };

    if (!this.seen || revision > this.seen.revision) this.seen = { revision, generation };
  }

  private async save(
    snapshot: Partial<Record<Field, { value: string; version: number }>>,
    base: Base | 'chain',
  ): Promise<void> {
    let guard = this.guard(base);

    // An edit made on another generation (before a discard elsewhere) is never sent into this one.
    const elsewhere = Object.entries(snapshot).filter(([field, saved]) => {
      const generation = this.fields[field as Field].generation;

      return (
        this.fields[field as Field].version === saved!.version &&
        generation !== null &&
        generation !== guard.baseGeneration
      );
    });

    if (elsewhere.length > 0) {
      this.failFields(
        Object.fromEntries(elsewhere.map(([field, saved]) => [field, saved!.version])),
        DISCARDED_ELSEWHERE,
      );

      for (const [field] of elsewhere) delete snapshot[field as Field];
    }

    if (Object.keys(snapshot).length === 0) return;

    for (;;) {
      const fields = Object.fromEntries(
        Object.entries(snapshot).map(([field, saved]) => [field, saved!.version]),
      ) as Partial<Record<Field, number>>;
      const write: Inflight = {
        writeId: guard.writeId,
        request: {
          route: 'saveDraft',
          params: { account: this.account, id: this.prId },
          body: {
            ...Object.fromEntries(
              Object.entries(snapshot).map(([field, saved]) => [field, saved!.value]),
            ),
            ...guardOf(guard),
          },
        },
        base: baseOf(guard),
        fields,
      };
      const outcome = await this.dispatch(write);

      if (outcome.kind === 'committed') {
        this.settleFields(fields, outcome.revision);
        this.advance(outcome.revision);
        this.transport.committed(outcome.body as ReviewDraft);

        return;
      }

      if (outcome.kind === 'conflict') {
        const draft = outcome.draft;
        const versions = draft.versions;

        this.observe(draft);
        this.transport.committed(draft);
        // Either way the draft is not the one the actions behind this chose: they stop.
        this.broken = true;

        // Changed by another tab or window: your newest edit wins, on the draft as it is now.
        // Discarded, submitted or locked since: nothing is sent into another draft.
        if (versions && versions.generation === guard.baseGeneration) {
          this.last = { revision: versions.revision, generation: versions.generation };
          guard = this.guard('chain');
          continue;
        }

        this.failFields(fields, DISCARDED_ELSEWHERE);

        return;
      }

      this.failFields(fields, refusalOf(outcome).message);

      return;
    }
  }

  /** An autosave the journal kept across a reload: sent again as it was, by its id. */
  private async resume(write: Inflight): Promise<void> {
    const fields = write.fields ?? {};
    const outcome = await this.dispatch(write, false);

    if (outcome.kind === 'committed') {
      this.settleFields(fields, outcome.revision);
      this.advance(outcome.revision);
      this.transport.stale();

      return;
    }

    if (outcome.kind === 'conflict') {
      this.observe(outcome.draft);
      this.transport.committed(outcome.draft);

      // Changed elsewhere since, the same draft: its edits are saved again on the draft as it is.
      if (outcome.draft.versions?.generation === write.base.generation) {
        void this.flush();

        return;
      }

      this.failFields(fields, DISCARDED_ELSEWHERE);

      return;
    }

    this.failFields(fields, refusalOf(outcome).message);
  }

  /**
   * Sends a write and learns its outcome. An answer that says nothing is sent again as it was,
   * the same id answering once; one still on its way is looked up until it settles.
   */
  private async dispatch(
    write: Inflight,
    first = true,
  ): Promise<Exclude<Outcome, { kind: 'pending' } | { kind: 'unknown' }>> {
    this.inflight = [...this.inflight.filter((other) => other.writeId !== write.writeId), write];
    this.changed();

    let outcome = await decode(this.transport.send(write.request), first);
    let attempt = 0;

    while (outcome.kind === 'pending' || outcome.kind === 'unknown') {
      await sleep(this.backoff(attempt++));

      if (outcome.kind === 'pending') {
        const looked = await this.transport
          .lookup(write.writeId, write.base)
          .then(fromLookup)
          .catch((): 'resend' => 'resend');

        // It never arrived and never can: as refused, nothing saved.
        if (looked === 'never') {
          outcome = {
            kind: 'refused',
            error: new ApiError('This write did not reach the server.', 409, 'NOT_RECEIVED'),
          };
          break;
        }

        outcome =
          looked === 'resend' ? await decode(this.transport.send(write.request), false) : looked;
      } else outcome = await decode(this.transport.send(write.request), false);
    }

    this.inflight = this.inflight.filter((other) => other.writeId !== write.writeId);
    this.changed();

    return outcome;
  }

  private settleFields(fields: Partial<Record<Field, number>>, revision: number) {
    for (const [field, version] of Object.entries(fields) as [Field, number][]) {
      const state = this.fields[field];

      if (version > state.settled) {
        state.settled = version;
        state.savedAt = revision;
      }
    }

    this.changed();
  }

  private failFields(fields: Partial<Record<Field, number>>, reason: string) {
    let failed = false;

    for (const [field, version] of Object.entries(fields) as [Field, number][])
      // An edit since is the next save's to send: this refusal is not its.
      if (this.fields[field].version === version) {
        this.fields[field].failed = reason;
        failed = true;
      }

    this.changed();

    if (failed) this.transport.refused(reason);
  }

  /** A write that replaced the draft's text (apply, prepare): a refused edit it replaced is retired. */
  private retireFailed(revision: number) {
    for (const state of Object.values(this.fields))
      if (state.failed) {
        state.failed = null;
        state.settled = state.version;
        state.savedAt = revision;
      }

    this.changed();
  }
}

const DISCARDED_ELSEWHERE =
  'This draft was discarded or submitted elsewhere. Your text is kept here and was not saved.';

const isDraft = (body: unknown): body is ReviewDraft =>
  typeof body === 'object' && body !== null && 'versions' in body && 'comments' in body;

const guardOf = (guard: Guard) => ({
  writeId: guard.writeId,
  baseRevision: guard.baseRevision,
  baseGeneration: guard.baseGeneration,
});

const baseOf = (guard: Guard): Base => ({
  revision: guard.baseRevision,
  generation: guard.baseGeneration,
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

  return new WriteRefused('This write could not be confirmed.');
}

const strip = ({ queued: _queued, ...state }: FieldState) => state;

function readJournal(account: string, prId: string): Journal | null {
  try {
    const text = sessionStorage.getItem(journalKey(account, prId));
    const journal = text ? (JSON.parse(text) as Journal) : null;

    return journal && Date.now() - journal.written < JOURNAL_TTL_MS ? journal : null;
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
