import type { ReviewEvent } from '@review-desk/shared/review';
import { ApiError } from '@/lib/api';

/**
 * Submit and discard as the draft writer's commands (see `DraftWriter.submit`): what each carries,
 * how its answers and receipts decode, and what a reload keeps of it. A command is never sent
 * again on its own: only you send it again, stop it, or its receipt says what became of it.
 */

export type CommandKind = 'submit' | 'discard';

/** A submit's input, as the finish sheet sends it. */
export interface SubmitInput {
  event: ReviewEvent;
  body: string;
  expectedHeadOid: string;
  allowNewHead?: boolean;
}

/** The summary and verdict a command carries, read at once with the versions they hold. */
export interface Carried {
  body: string;
  event: ReviewEvent;
  versions: { body: number; event: number };
}

/** A command's request, frozen before its first send: every send of it is the very same. */
export interface CommandRequest {
  route: 'submit' | 'discard';
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * - `queued`: waiting in the queue, never sent (a reload releases it);
 * - `sending`: recorded, and on its way or about to be;
 * - `unknown`: sent, its outcome not known;
 * - `admitted`: a discard received, its cleanup yet to finish;
 * - `lost`: stopped without knowing whether it was received before; it can never be after.
 */
export type CommandPhase = 'queued' | 'sending' | 'unknown' | 'admitted' | 'lost';

export interface CommandRecord {
  id: string;
  kind: CommandKind;
  phase: CommandPhase;
  /** Its place in the queue: what was queued after it waits on it. Restored ones come first. */
  seq: number;
  /** What it carries; none for a legacy id, which claims nothing of your current edits. */
  carried: Carried | null;
  input?: SubmitInput;
  /** The pending review the sheet showed, for a submit. */
  expectedPendingReviewId?: string | null;
  request?: CommandRequest;
  /** The server's receipt-history epoch, read before its first send; null for a legacy id. */
  epoch: number | null;
  firstSent?: number;
  /** An id an earlier version kept: its outcome is only looked up, never sent again. */
  legacy?: boolean;
  /** An admitted discard's operation status, as last read. */
  status?: string;
}

/** What the banner shows of a command. */
export interface CommandView {
  id: string;
  kind: CommandKind;
  phase: Exclude<CommandPhase, 'queued' | 'sending'>;
  legacy: boolean;
  /** Within its recovery lifetime, and not a legacy id: you may send the very same again. */
  canSendAgain: boolean;
  carried: Carried | null;
  status?: string;
}

/** What a command's answer decodes to. */
export type CommandAnswer =
  | { kind: 'admitted'; body: unknown; local: boolean }
  | { kind: 'refused'; error: ApiError }
  | { kind: 'unknown'; error: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Decodes a command's answer. A receipt that names the command, or a local discard's `ok`, is its
 * admission; a client error to a first send, which nothing earlier of it can have preceded, is a
 * refusal. Anything else says nothing: the command stays unknown, its receipt to settle it.
 */
export async function decodeCommand(
  answer: Promise<unknown>,
  first: boolean,
  command: Pick<CommandRecord, 'id' | 'kind'>,
): Promise<CommandAnswer> {
  try {
    const body = await answer;

    if (isObject(body) && isObject(body.operation) && body.operation.id === command.id)
      return { kind: 'admitted', body, local: false };
    if (command.kind === 'discard' && isObject(body) && body.ok === true)
      return { kind: 'admitted', body, local: true };

    return { kind: 'unknown', error: new Error('The answer carried no outcome.') };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: 'unknown', error };

    // Stopped already: only its receipt says whether it was received before.
    if (error.code === 'COMMAND_ABANDONED') return { kind: 'unknown', error };

    const beforeAdmission =
      error.code !== 'UNREADABLE' && error.status >= 400 && error.status < 500;

    return first && beforeAdmission ? { kind: 'refused', error } : { kind: 'unknown', error };
  }
}

/** A receipt read for a command, as it settles it; `null` when it says nothing about it. */
export type ReadReceipt =
  | { kind: 'received'; status: string; draft: { revision: number; generation: number } | null }
  | { kind: 'abandoned'; decision: 'not-admitted' | 'unknown' }
  | { kind: 'none' };

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Reads the receipt route's answer for `command`: settled only by one for this PR and action.
 * `answer` is null for a 404, nothing received under its id.
 */
export function readReceipt(
  answer: unknown,
  command: Pick<CommandRecord, 'kind'>,
  prId: string,
): ReadReceipt | null {
  if (answer === null) return { kind: 'none' };
  if (!isObject(answer) || answer.prId !== prId) return null;
  if (answer.type !== (command.kind === 'submit' ? 'review' : 'discard')) return null;

  if (answer.kind === 'abandoned')
    return answer.decision === 'not-admitted' || answer.decision === 'unknown'
      ? { kind: 'abandoned', decision: answer.decision }
      : null;

  if ((answer.kind !== 'local' && answer.kind !== 'forge') || typeof answer.status !== 'string')
    return null;

  const draft =
    isObject(answer.draft) && isCount(answer.draft.revision) && isCount(answer.draft.generation)
      ? { revision: answer.draft.revision, generation: answer.draft.generation }
      : null;

  return { kind: 'received', status: answer.status, draft };
}

/** What stopping a command answers, as it settles it; `null` when it says nothing. */
export function readAbandon(
  answer: unknown,
  command: Pick<CommandRecord, 'kind'>,
  prId: string,
): ReadReceipt | null {
  if (!isObject(answer)) return null;
  if (answer.outcome === 'not-admitted' || answer.outcome === 'unknown')
    return { kind: 'abandoned', decision: answer.outcome };

  return answer.outcome === 'admitted' ? readReceipt(answer.receipt, command, prId) : null;
}

/** Statuses after which a discard's cleanup is done, one way or the other. */
export const isFinal = (status: string) => status === 'succeeded' || status === 'cancelled';

export const COMMAND_MESSAGES = {
  unknown:
    'Your last submit or discard is not confirmed yet. Wait for it, or stop it, before doing this.',
  discarding: 'This draft is being discarded. Wait for that to finish, or cancel it in Activity.',
  submitted: 'This draft was submitted. Nothing more is saved into it.',
  notSent: 'This was not sent: the server did not answer in time. Try again.',
  notRecorded: 'This could not be recorded in this tab, so it was not sent. Try again.',
  submitUnknown:
    'Your review could not be confirmed as submitted. It is kept here: send it again, or stop it.',
  discardUnknown:
    'Discarding the draft could not be confirmed. Your draft is kept here: send it again, or stop it.',
  keptAfterSubmit:
    'Typed after you submitted your review, and not saved. Edit it to save it on the next draft.',
  keptForConfirmation:
    'Kept from before the discard, and not saved. Edit it to save it on the current draft.',
  keptUnknown:
    'Kept while an earlier action could not be confirmed, and not saved. Edit it to save it.',
} as const;
