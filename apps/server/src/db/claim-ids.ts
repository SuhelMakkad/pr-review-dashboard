import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sealed attempt ids: `ck1-<checkpoint>-<seal>-<uuid>`. The checkpoint is the ledger's last `seq`
 * when the web read it, before the attempt's first send. The seal binds it to the account under a
 * secret this server process made as it started and never stores, so an id always carries the
 * checkpoint it was made with, and no later read can be passed off as its own.
 *
 * Only an id this process sealed can prove anything by its absence: every claim after its
 * checkpoint is in this database. One sealed by an earlier process (or forged) may have been
 * received by a database since replaced, a restored backup's say, so it is foreign: answered when
 * found, never provable, never admitted afresh. A bare id (any other) has no checkpoint at all.
 */

/** Any attempt id, as the routes take it (the shared contract's `operationId`). */
const ID = /^[A-Za-z0-9-]{8,120}$/;

const SEALED =
  /^ck1-(\d{1,15})-([0-9a-f]{16})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The seal of `checkpoint` for `account`: the first 16 hex digits of its HMAC. */
export function sealOf(secret: string, account: string, checkpoint: number): string {
  return createHmac('sha256', secret).update(`${account}:${checkpoint}`).digest('hex').slice(0, 16);
}

export type ParsedAttemptId =
  | { kind: 'bare' }
  | { kind: 'sealed'; checkpoint: number }
  | { kind: 'foreign' }
  | { kind: 'invalid' };

/**
 * Reads an attempt id: bare; sealed by this process, with its checkpoint; sealed but not by this
 * process (foreign); or not an attempt id at all (invalid, as is a sealed one out of shape).
 */
export function parseAttemptId(id: string, account: string, secret: string): ParsedAttemptId {
  if (!ID.test(id)) return { kind: 'invalid' };
  if (!id.startsWith('ck1-')) return { kind: 'bare' };

  const match = SEALED.exec(id);

  if (!match) return { kind: 'invalid' };

  const checkpoint = Number(match[1]);
  const expected = Buffer.from(sealOf(secret, account, checkpoint));
  const given = Buffer.from(match[2]!);

  return expected.length === given.length && timingSafeEqual(expected, given)
    ? { kind: 'sealed', checkpoint }
    : { kind: 'foreign' };
}

/**
 * Whether a miss of `parsed` proves it was never received: only an id this process sealed, whose
 * checkpoint no pruning has reached.
 */
export const provable = (parsed: ParsedAttemptId, watermark: number) =>
  parsed.kind === 'sealed' && watermark <= parsed.checkpoint;

/**
 * Whether an id with no claim must not be admitted afresh: foreign, or sealed behind the
 * watermark. Its original may have been received and its claim lost since (pruned, or with a
 * replaced database), so it is never claimed again.
 */
export const behindHistory = (parsed: ParsedAttemptId, watermark: number) =>
  parsed.kind === 'foreign' || (parsed.kind === 'sealed' && watermark > parsed.checkpoint);
