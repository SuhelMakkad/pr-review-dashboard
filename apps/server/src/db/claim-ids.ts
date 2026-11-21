import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sealed attempt ids: `ck1-<checkpoint>-<seal>-<uuid>`. The checkpoint is the ledger's last `seq`
 * when the web read it, before the attempt's first send; the seal binds it to the account under the
 * ledger's secret, so an id always carries the checkpoint it was made with, and no later read can
 * be passed off as its own. A bare id (any other) has no checkpoint: a miss of it proves nothing.
 */

const SEALED =
  /^ck1-(\d{1,15})-([0-9a-f]{16})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The seal of `checkpoint` for `account`: the first 16 hex digits of its HMAC. */
export function sealOf(secret: string, account: string, checkpoint: number): string {
  return createHmac('sha256', secret).update(`${account}:${checkpoint}`).digest('hex').slice(0, 16);
}

export type ParsedAttemptId =
  { kind: 'bare' } | { kind: 'sealed'; checkpoint: number } | { kind: 'invalid' };

/** Reads an attempt id: bare, sealed with a checkpoint that verifies, or invalid. */
export function parseAttemptId(id: string, account: string, secret: string): ParsedAttemptId {
  if (!id.startsWith('ck1-')) return { kind: 'bare' };

  const match = SEALED.exec(id);

  if (!match) return { kind: 'invalid' };

  const checkpoint = Number(match[1]);
  const expected = Buffer.from(sealOf(secret, account, checkpoint));
  const given = Buffer.from(match[2]!);

  return expected.length === given.length && timingSafeEqual(expected, given)
    ? { kind: 'sealed', checkpoint }
    : { kind: 'invalid' };
}

/**
 * Whether a miss of `parsed` proves it was never received: only a sealed id whose checkpoint no
 * pruning has reached.
 */
export const provable = (parsed: ParsedAttemptId, watermark: number) =>
  parsed.kind === 'sealed' && watermark <= parsed.checkpoint;
