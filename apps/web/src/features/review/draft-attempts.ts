import { reviewEventLabels, type ReviewEvent } from '@review-desk/shared/review';
import { ApiError } from '@/lib/api';

/**
 * Comment and AI writes as the draft writer journals them (see `DraftWriter.write`): each recorded
 * before it is sent, so a reload never loses one on its way. After a reload one never sent is
 * released, its text yours to copy, and one that may have been sent is only looked up: never sent
 * again on its own. Neither ever holds up the draft.
 */

/** A write's request, as the writer sends it. */
export interface AttemptRequest {
  route: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/** A draft's revision and generation (as `draft-writer`'s `Base`). */
export interface AttemptBase {
  revision: number;
  generation: number;
}

/**
 * - `queued`: recorded, waiting in the queue, never sent (a reload releases it);
 * - `sending`: on its way, its outcome learnt in this tab (a reload only looks it up);
 * - `checking`: may have been sent, looked up in the background;
 * - `unknown`: may have been received, and nothing can tell yet: never sent again on its own;
 * - `not-saved`: never saved, and never can be;
 * - `lost`: stopped without knowing whether it was received before; it can never be after.
 */
export type AttemptPhase = 'queued' | 'sending' | 'checking' | 'unknown' | 'not-saved' | 'lost';

export interface AttemptRecord {
  /** Its own, from when it was asked for: its write id is made only once it is sent. */
  key: string;
  phase: AttemptPhase;
  /** What it asks for: what the banner says of it, and the text you may copy. */
  intent: AttemptRequest;
  /** Its envelope, once made at the front of the queue: every send of it is the very same. */
  writeId?: string;
  request?: AttemptRequest;
  base?: AttemptBase;
  deadline?: number;
  /** For an autosave, the field versions it carries: settled or kept by its outcome. */
  fields?: Partial<Record<'body' | 'event', number>>;
  /** Its last lookup found it not received yet, and able to be: you may send it again. */
  resendable?: boolean;
  /** Why it was not saved. */
  reason?: string;
  /** Hidden from the banner in its phase: shown again once it moves. */
  dismissed?: boolean;
}

/** What the banner shows of a write. */
export interface AttemptView {
  key: string;
  phase: 'unknown' | 'not-saved' | 'lost';
  /** What it was: "Your comment on src/a.ts:12". */
  label: string;
  /** The text it carried, to copy; none for a write whose text the server holds. */
  text: string | null;
  canSendAgain: boolean;
  canStop: boolean;
  reason?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const textOf = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** What the banner calls a write: by what it asked for. */
export function labelOf(intent: AttemptRequest): string {
  const { body } = intent;

  switch (intent.route) {
    case 'addComment': {
      const path = textOf(body.path);
      const line = typeof body.line === 'number' ? `:${body.line}` : '';

      return path ? `Your comment on ${path}${line}` : 'Your comment';
    }
    case 'editComment':
      return 'Your edit to a comment';
    case 'deleteComment':
      return 'Deleting a comment';
    case 'acceptAi':
      return 'Adding an AI finding to your draft';
    case 'prepareAi':
      return 'Preparing the AI review in your draft';
    case 'applyAi':
      return 'Using the AI summary in your draft';
    case 'saveDraft':
      return 'Your summary or verdict';
    default:
      return 'A change to your draft';
  }
}

/** The text a write carried, to copy: a comment's, or a summary and verdict. */
export function textOfIntent(intent: AttemptRequest): string | null {
  const { body } = intent;

  if (intent.route === 'saveDraft') {
    const event = body.event as ReviewEvent | undefined;
    const parts = [
      textOf(body.body),
      event && event in reviewEventLabels ? `Verdict: ${reviewEventLabels[event]}` : null,
    ];

    return parts.filter(Boolean).join('\n\n') || null;
  }

  return intent.route === 'addComment' ||
    intent.route === 'editComment' ||
    intent.route === 'acceptAi'
    ? textOf(body.body)
    : null;
}

/** What stopping a write answers, as it settles it; `null` when it says nothing about it. */
export type WriteStop =
  | { kind: 'pending' }
  | { kind: 'committed'; revision: number; body: unknown }
  | { kind: 'refused'; error: ApiError }
  | { kind: 'not-admitted' }
  | { kind: 'unknown' };

/** Reads `routes.abandonDraftAttempt`'s answer for the write sent as `writeId`. */
export function readWriteStop(answer: unknown, writeId: string): WriteStop | null {
  if (!isObject(answer)) return null;
  if (answer.outcome === 'pending') return { kind: 'pending' };
  if (answer.outcome === 'not-admitted' || answer.outcome === 'unknown')
    return { kind: answer.outcome };

  const attempt = isObject(answer.attempt) ? answer.attempt : null;
  const result = attempt && isObject(attempt.result) ? attempt.result : null;

  if (!attempt || attempt.id !== writeId || !result) return null;

  if (answer.outcome === 'committed' && attempt.state === 'committed')
    return typeof attempt.revision === 'number'
      ? { kind: 'committed', revision: attempt.revision, body: result.body }
      : null;

  if (answer.outcome !== 'refused' || attempt.state !== 'refused') return null;

  const body = isObject(result.body) ? result.body : {};

  return {
    kind: 'refused',
    error: new ApiError(
      typeof body.error === 'string' ? body.error : 'Not saved.',
      typeof result.status === 'number' ? result.status : 409,
      typeof body.code === 'string' ? body.code : undefined,
      body,
    ),
  };
}

/** A checkpoint as `routes.claimCheckpoint` answers it; anything else seals nothing. */
export function readCheckpoint(answer: unknown): { checkpoint: number; seal: string } | null {
  return isObject(answer) &&
    typeof answer.checkpoint === 'number' &&
    Number.isInteger(answer.checkpoint) &&
    answer.checkpoint >= 0 &&
    typeof answer.seal === 'string' &&
    /^[0-9a-f]{16}$/.test(answer.seal)
    ? { checkpoint: answer.checkpoint, seal: answer.seal }
    : null;
}

/** Whether `id` is sealed with a checkpoint: a miss of it can prove it never arrived. */
export const isSealed = (id: string) => id.startsWith('ck1-');

export const ATTEMPT_MESSAGES = {
  unconfirmed:
    'This could not be confirmed as saved, and is not sent again on its own. Its notice with your draft says what you can do.',
  notSentReload: 'This was not sent before the page reloaded.',
  neverReceived: 'This did not reach the server, and never can now.',
  stoppedNever: 'You stopped it before it reached the server.',
  unresolved:
    'The very same is still waiting to be confirmed, so it was not sent again. Its notice with your draft says what you can do.',
} as const;
