import { operationUnsettled } from '@review-desk/shared/operations';
import type { OperationRecord } from './types.js';

/** What a PR's first unsettled action may be sent or checked from. */
const DISPATCHABLE = new Set<OperationRecord['status']>(['queued', 'waiting', 'checking']);

/**
 * The actions that may be sent or checked next, in row order: the first unsettled action of each
 * PR, kept when it is queued, waiting or checking. One that needs your attention, or is running,
 * holds its PR's later actions back and is not sent itself.
 */
export function heads(rows: OperationRecord[]): OperationRecord[] {
  const seen = new Set<string>();
  const result: OperationRecord[] = [];

  for (const row of rows) {
    if (!operationUnsettled(row.status) || seen.has(row.prId)) continue;

    seen.add(row.prId);

    if (DISPATCHABLE.has(row.status)) result.push(row);
  }

  return result;
}

/**
 * Until when the write cooldown and the sync's `retryAt` hold sending back, in epoch ms. An
 * unreadable time makes this NaN, which holds nothing back, as before.
 */
export const heldUntil = (
  cooldown: string | null | undefined,
  retryAt: string | null | undefined,
) =>
  Math.max(cooldown ? Date.parse(cooldown) : -Infinity, retryAt ? Date.parse(retryAt) : -Infinity);

/** Whether sending is held back at `now` (see `heldUntil`). */
export const held = (until: number, now: number) => until > now;

/** Due at `now`: no `retryAt`, or one at or before it. An unreadable one is never due. */
const due = (row: OperationRecord, now: number) => !row.retryAt || Date.parse(row.retryAt) <= now;

/** The action to send or check now, when sending is not held back: the first head that is due. */
export function pick(rows: OperationRecord[], now: number): OperationRecord | null {
  return heads(rows).find((row) => due(row, now)) ?? null;
}

/**
 * When an action could next be sent or checked, in epoch ms: the earliest head's `retryAt` (now,
 * for one with none), held back to `until` while that is still ahead. Null when no head waits, or
 * only ones `pick` would never send (an unreadable `retryAt`).
 */
export function nextDue(rows: OperationRecord[], until: number, now: number): number | null {
  let earliest = Infinity;

  for (const row of heads(rows)) {
    const at = row.retryAt ? Date.parse(row.retryAt) : now;

    if (!Number.isNaN(at)) earliest = Math.min(earliest, at);
  }

  if (earliest === Infinity) return null;

  return held(until, now) ? Math.max(earliest, until) : earliest;
}
