import { randomBytes } from 'node:crypto';
import { and, eq, inArray, lt, max, ne, sql } from 'drizzle-orm';
import { claimLedger, claimWatermarks, draftWrites } from '@/db/schema.js';
import type { Database } from '@/db/store.js';

export type ClaimState = 'pending' | 'committed' | 'refused';

/** A claimed draft write or AI start (see `draftWrites`). */
export interface WriteClaim {
  account: string;
  id: string;
  prId: string;
  kind: 'write' | 'start';
  fingerprint: string;
  baseRevision: number | null;
  baseGeneration: number | null;
  state: ClaimState;
  result: unknown;
  createdAt: string;
  seq?: number | null;
}

/** The fingerprint of a claim recorded by a stop, not by a request: an abandonment marker. */
export const ABANDONED = 'abandoned';

/** What a stop decided of a claim it found missing. */
export type AbandonDecision = 'not-admitted' | 'unknown';

/** What a settled claim keeps: a commit's revision and answer, or a refusal's status and answer. */
export type ClaimResult = { revision: number; body: unknown } | { status: number; body: unknown };

/** How long settled claims are kept: well past the web journal's 7-day recovery lifetime. */
export const CLAIM_RETENTION_MS = 30 * 24 * 3_600_000;

/** The refusal recorded for a claim its process left pending, which therefore never committed. */
export const INTERRUPTED = {
  status: 409,
  body: { error: 'Interrupted before it was saved.', code: 'INTERRUPTED' },
};

/**
 * The claim ledger. A draft write or AI start with an id is claimed as it arrives, before any
 * await, and settled in the transaction that decides it: the commit's own, or its refusal's. Each
 * method is one statement and opens no transaction of its own, so it joins the caller's.
 */
export class DraftWriteLog {
  /** The secret this process seals checkpoints with (see `secret`). */
  private readonly sealing = randomBytes(32).toString('hex');

  constructor(private readonly db: Database) {}

  find(account: string, id: string): WriteClaim | undefined {
    return this.db
      .select()
      .from(draftWrites)
      .where(and(eq(draftWrites.account, account), eq(draftWrites.id, id)))
      .get() as WriteClaim | undefined;
  }

  /** Claims a new id, pending, at the ledger's next `seq`. The caller has checked there is none. */
  claim(claim: Omit<WriteClaim, 'state' | 'result' | 'seq'>): void {
    this.db
      .insert(draftWrites)
      .values({ ...claim, state: 'pending', result: null, seq: this.next() })
      .run();
  }

  /**
   * Records a stop of an id never received: a refused claim (an abandonment marker) that answers
   * every later arrival of it, never pruned. The caller has checked there is none.
   */
  abandon(marker: {
    account: string;
    id: string;
    prId: string;
    kind: 'write' | 'start';
    decision: AbandonDecision;
    createdAt: string;
  }): void {
    const { decision, ...claim } = marker;

    this.db
      .insert(draftWrites)
      .values({
        ...claim,
        fingerprint: ABANDONED,
        baseRevision: null,
        baseGeneration: null,
        state: 'refused',
        result: {
          status: 409,
          body: {
            error: 'You stopped waiting for this, so it can no longer be saved.',
            code: 'WRITE_ABANDONED',
            decision,
          },
        },
        seq: this.next(),
      })
      .run();
  }

  /** The ledger's row. The migration makes it; should it ever be missing, it is made here. */
  private ledger(): { last: number } {
    const read = () =>
      this.db
        .select({ last: claimLedger.last })
        .from(claimLedger)
        .where(eq(claimLedger.id, 1))
        .get();
    const found = read();

    if (found) return found;

    this.db.insert(claimLedger).values({ id: 1, last: 0 }).onConflictDoNothing().run();

    return read()!;
  }

  /** The ledger's next `seq`, assigned. */
  private next(): number {
    this.ledger();

    return this.db
      .update(claimLedger)
      .set({ last: sql`${claimLedger.last} + 1` })
      .where(eq(claimLedger.id, 1))
      .returning({ last: claimLedger.last })
      .get()!.last;
  }

  /** The last `seq` the ledger assigned: a checkpoint every claim after it is newer than. */
  checkpoint(): number {
    return this.ledger().last;
  }

  /**
   * The secret checkpoints are sealed with: this process's own, never stored, so a database put
   * back from a backup cannot vouch for an id sealed against the history it lost (see
   * `db/claim-ids.ts`).
   */
  secret(): string {
    return this.sealing;
  }

  /** The highest `seq` pruning deleted of `account`'s claims: 0 when none. */
  watermarkOf(account: string): number {
    return (
      this.db
        .select({ watermark: claimWatermarks.watermark })
        .from(claimWatermarks)
        .where(eq(claimWatermarks.account, account))
        .get()?.watermark ?? 0
    );
  }

  /** Settles a pending claim, true when it did; one already settled keeps its outcome. */
  settle(
    account: string,
    id: string,
    state: 'committed' | 'refused',
    result: ClaimResult,
  ): boolean {
    const { changes } = this.db
      .update(draftWrites)
      .set({ state, result })
      .where(
        and(
          eq(draftWrites.account, account),
          eq(draftWrites.id, id),
          eq(draftWrites.state, 'pending'),
        ),
      )
      .run();

    return changes > 0;
  }

  /** The PRs with a claim still pending, every account's. */
  pending(): { account: string; prId: string }[] {
    return this.db
      .select({ account: draftWrites.account, prId: draftWrites.prId })
      .from(draftWrites)
      .where(eq(draftWrites.state, 'pending'))
      .all();
  }

  /**
   * Records every pending claim as interrupted, or only those of `prIds` for `account`. A claim
   * still pending after its handler is gone never committed: its commit and its settling are one
   * transaction.
   */
  interrupt(scope?: { account: string; prIds: string[] }): void {
    const pending = eq(draftWrites.state, 'pending');

    this.db
      .update(draftWrites)
      .set({ state: 'refused', result: INTERRUPTED })
      .where(
        scope
          ? and(
              pending,
              eq(draftWrites.account, scope.account),
              inArray(draftWrites.prId, scope.prIds),
            )
          : pending,
      )
      .run();
  }

  /**
   * Removes settled claims created before `before`, raising each account's watermark to the
   * highest `seq` removed, in the caller's transaction. A pending claim is never removed, nor an
   * abandonment marker, which must answer its id for good.
   */
  prune(before: string): void {
    const old = and(
      inArray(draftWrites.state, ['committed', 'refused']),
      lt(draftWrites.createdAt, before),
      ne(draftWrites.fingerprint, ABANDONED),
    );
    const removed = this.db
      .select({ account: draftWrites.account, seq: max(draftWrites.seq) })
      .from(draftWrites)
      .where(old)
      .groupBy(draftWrites.account)
      .all();

    for (const { account, seq } of removed)
      this.db
        .insert(claimWatermarks)
        .values({ account, watermark: seq ?? 0 })
        .onConflictDoUpdate({
          target: claimWatermarks.account,
          set: { watermark: sql`max(${claimWatermarks.watermark}, ${seq ?? 0})` },
        })
        .run();

    this.db.delete(draftWrites).where(old).run();
  }
}
