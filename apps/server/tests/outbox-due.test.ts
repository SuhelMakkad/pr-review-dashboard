import { describe, expect, it } from 'vitest';
import { heads, heldUntil, nextDue, pick } from '@/operations/due.js';
import type { OperationRecord } from '@/operations/types.js';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const row = (
  id: string,
  prId: string,
  status: OperationRecord['status'],
  retryAt: string | null = null,
) => ({ id, prId, status, retryAt }) as OperationRecord;

const ids = (rows: (OperationRecord | null)[]) => rows.map((found) => found?.id ?? null);

describe('the actions the outbox may send next', () => {
  it.each([
    [
      'the first of each PR, in row order',
      [row('a', 'P1', 'queued'), row('b', 'P1', 'queued'), row('c', 'P2', 'waiting')],
      ['a', 'c'],
    ],
    [
      'waiting and checking ones too',
      [row('a', 'P1', 'waiting'), row('b', 'P2', 'checking')],
      ['a', 'b'],
    ],
    [
      'none behind one needing attention',
      [row('a', 'P1', 'needs_attention'), row('b', 'P1', 'queued'), row('c', 'P2', 'queued')],
      ['c'],
    ],
    ['none behind one running', [row('a', 'P1', 'running'), row('b', 'P1', 'queued')], []],
    [
      'the next one once those before it settled',
      [row('a', 'P1', 'succeeded'), row('b', 'P1', 'cancelled'), row('c', 'P1', 'queued')],
      ['c'],
    ],
    ['none of an empty outbox', [], []],
  ])('are %s', (_, rows, expected) => {
    expect(ids(heads(rows))).toEqual(expected);
  });
});

describe('the action sent now', () => {
  it.each([
    ['the first due', [row('a', 'P1', 'queued', at(1)), row('b', 'P2', 'queued')], 'b'],
    ['one whose retry is due at this very moment', [row('a', 'P1', 'waiting', at(0))], 'a'],
    ['none while every retry is ahead', [row('a', 'P1', 'waiting', at(1))], null],
    ['never one whose retry time cannot be read', [row('a', 'P1', 'waiting', 'soon')], null],
    [
      'never one held behind its PR',
      [row('a', 'P1', 'needs_attention'), row('b', 'P1', 'queued')],
      null,
    ],
  ])('is %s', (_, rows, expected) => {
    expect(ids([pick(rows, NOW)])).toEqual([expected]);
  });
});

describe('when the outbox next looks', () => {
  const none = heldUntil(null, null);

  it.each([
    ['never, with nothing waiting', [], none, null],
    ['now, for an action with no retry time', [row('a', 'P1', 'queued')], none, NOW],
    [
      'at the earliest retry',
      [row('a', 'P1', 'waiting', at(30_000)), row('b', 'P2', 'waiting', at(10_000))],
      none,
      NOW + 10_000,
    ],
    ['at a retry already past', [row('a', 'P1', 'waiting', at(-5_000))], none, NOW - 5_000],
    [
      'at a later cooldown',
      [row('a', 'P1', 'waiting', at(30_000))],
      heldUntil(at(60_000), null),
      NOW + 60_000,
    ],
    [
      'at a later sync retry',
      [row('a', 'P1', 'queued')],
      heldUntil(null, at(45_000)),
      NOW + 45_000,
    ],
    [
      'at the later of the cooldown and the sync retry',
      [row('a', 'P1', 'queued')],
      heldUntil(at(20_000), at(45_000)),
      NOW + 45_000,
    ],
    [
      'at the retry, past an earlier cooldown',
      [row('a', 'P1', 'waiting', at(30_000))],
      heldUntil(at(10_000), null),
      NOW + 30_000,
    ],
    [
      'at once, for a cooldown ending at this very moment',
      [row('a', 'P1', 'queued')],
      heldUntil(at(0), null),
      NOW,
    ],
    [
      'as if unheld, for a cooldown that cannot be read',
      [row('a', 'P1', 'queued')],
      heldUntil('later', at(45_000)),
      NOW,
    ],
    [
      'never, for a retry time that cannot be read',
      [row('a', 'P1', 'waiting', 'soon')],
      none,
      null,
    ],
    [
      'never, for a PR held behind one needing attention',
      [row('a', 'P1', 'needs_attention'), row('b', 'P1', 'queued')],
      none,
      null,
    ],
  ])('is %s', (_, rows, until, expected) => {
    expect(nextDue(rows, until, NOW)).toBe(expected);
  });
});
