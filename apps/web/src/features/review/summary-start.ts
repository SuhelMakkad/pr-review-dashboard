import type { AiProvider } from '@review-desk/shared/ai';

/**
 * The summary start as the draft writer's own job (see `DraftWriter.startSummary`): what it
 * captured at the click, the preflight that saves the text it was asked on, and the start itself,
 * each journaled before it is sent. Never sent again on its own; it holds up nothing but another
 * summary start.
 */

/** What the summary is started with. */
export interface SummaryRequest {
  provider?: AiProvider;
  force?: boolean;
}

/** A field as the click captured it. */
export interface StartSnapshot {
  value: string;
  version: number;
  generation: number | null;
  since: number | null;
}

/** An envelope the start journals before its send: every send of it is the very same. */
export interface StartEnvelope {
  writeId: string;
  request: { route: string; params: Record<string, string>; body: Record<string, unknown> };
  base: { revision: number; generation: number };
  /** Until when it may be sent again, by your choice. */
  deadline: number;
}

/**
 * - `queued`: waiting in the queue, or saving its text first, the start itself never sent;
 * - `sending`: the start recorded, and on its way;
 * - `unknown`: the start sent, its outcome not known: only looked up, sent again or stopped;
 * - `not-started`: never started, and never can be: shown until you dismiss it;
 * - `lost`: stopped without knowing whether it started before; it never can after.
 */
export type StartPhase = 'queued' | 'sending' | 'unknown' | 'not-started' | 'lost';

export interface StartRecord {
  key: string;
  phase: StartPhase;
  /** Its place in the queue. */
  seq: number;
  request: SummaryRequest;
  /** Each field as shown at the click. */
  captured: { body: StartSnapshot; event: StartSnapshot };
  /** The save of the captured text still unsaved at the front, sent before the start. */
  preflight?: StartEnvelope & {
    fields: Partial<Record<'body' | 'event', number>>;
    meta: Partial<Record<'body' | 'event', { generation: number | null; since: number | null }>>;
    phase: 'sending' | 'committed';
    revision?: number;
  };
  /** The start, once recorded. */
  attempt?: StartEnvelope;
  /** Sent again by you: a bare refusal of either send then proves nothing. */
  resent?: boolean;
  /** Its last lookup found it not received yet, and able to be: you may send it again. */
  resendable?: boolean;
  reason?: string;
}

/** What the banner shows of a summary start. */
export interface StartView {
  key: string;
  phase: 'unknown' | 'not-started' | 'lost';
  canSendAgain: boolean;
  canStop: boolean;
  reason?: string;
}

export const START_MESSAGES = {
  unknown:
    'Starting the summary could not be confirmed. It is never sent again unless you choose to; its notice says what you can do.',
  another:
    'A summary you started is not confirmed yet. Wait for it, or stop it, before starting another.',
  notSent: 'The summary was not started: the server did not answer in time. Try again.',
  notSaved:
    'The summary was not started: your summary or verdict could not be confirmed as saved. Check it, then try again.',
  changed:
    'The draft changed since you asked for the summary. Your text is kept here; check it, then try again.',
  stoppedNever: 'You stopped it before it reached the server.',
} as const;
