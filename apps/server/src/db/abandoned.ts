import { and, eq, sql } from 'drizzle-orm';
import { abandonedCommands, receiptEpochs } from '@/db/schema.js';
import type { Database } from '@/db/store.js';

export type AbandonDecision = 'not-admitted' | 'unknown';

/** A submit or discard id you stopped waiting for (see `abandonedCommands`). */
export interface AbandonedCommand {
  account: string;
  id: string;
  prId: string;
  type: 'review' | 'discard';
  decision: AbandonDecision;
  createdAt: string;
}

/**
 * Stopped commands, and each account's receipt-history epoch. Each method is one statement and
 * opens no transaction of its own, so it joins the caller's: a stop is decided in the same turn as
 * any admission of its id.
 */
export class AbandonedCommands {
  constructor(private readonly db: Database) {}

  find(account: string, id: string): AbandonedCommand | undefined {
    return this.db
      .select()
      .from(abandonedCommands)
      .where(and(eq(abandonedCommands.account, account), eq(abandonedCommands.id, id)))
      .get() as AbandonedCommand | undefined;
  }

  record(command: AbandonedCommand): void {
    this.db.insert(abandonedCommands).values(command).run();
  }

  /** The account's receipt-history epoch: 0 until its outbox rows were first deleted. */
  epochOf(account: string): number {
    return (
      this.db
        .select({ epoch: receiptEpochs.epoch })
        .from(receiptEpochs)
        .where(eq(receiptEpochs.account, account))
        .get()?.epoch ?? 0
    );
  }

  /** Raised as the account's outbox rows are deleted: receipts from before it are gone. */
  raiseEpoch(account: string): void {
    this.db
      .insert(receiptEpochs)
      .values({ account, epoch: 1 })
      .onConflictDoUpdate({
        target: receiptEpochs.account,
        set: { epoch: sql`${receiptEpochs.epoch} + 1` },
      })
      .run();
  }
}
