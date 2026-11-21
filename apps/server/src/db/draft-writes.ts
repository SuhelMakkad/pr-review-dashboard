import { and, eq, inArray, lt } from 'drizzle-orm';
import { draftWrites } from '@/db/schema.js';
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
}

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
  constructor(private readonly db: Database) {}

  find(account: string, id: string): WriteClaim | undefined {
    return this.db
      .select()
      .from(draftWrites)
      .where(and(eq(draftWrites.account, account), eq(draftWrites.id, id)))
      .get() as WriteClaim | undefined;
  }

  /** Claims a new id, pending. The caller has checked there is no claim for it yet. */
  claim(claim: Omit<WriteClaim, 'state' | 'result'>): void {
    this.db
      .insert(draftWrites)
      .values({ ...claim, state: 'pending', result: null })
      .run();
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

  /** Removes settled claims created before `before`. A pending claim is never removed. */
  prune(before: string): void {
    this.db
      .delete(draftWrites)
      .where(
        and(
          inArray(draftWrites.state, ['committed', 'refused']),
          lt(draftWrites.createdAt, before),
        ),
      )
      .run();
  }
}
