import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { scheduledWork } from '@/db/schema.js';
import type { Database } from '@/db/store.js';

/** One scheduled wake-up (see `scheduledWork`). */
export type WorkRow = typeof scheduledWork.$inferSelect;

/** The earlier of two times, either of which may be missing. */
export const earlier = (left: string | null, right: string | null) =>
  left === null
    ? right
    : right === null
      ? left
      : Date.parse(right) < Date.parse(left)
        ? right
        : left;

/** The later of two times, either of which may be missing. */
export const later = (left: string | null, right: string | null) =>
  left === null
    ? right
    : right === null
      ? left
      : Date.parse(right) > Date.parse(left)
        ? right
        : left;

/** When the row may run: its request, held back to its gate. Null while nothing is requested. */
export const deadlineOf = (row: Pick<WorkRow, 'requestedAt' | 'notBefore'>) =>
  row.requestedAt === null ? null : later(row.requestedAt, row.notBefore);

/**
 * The scheduler's wake-ups. Each method is one statement, or reads and writes the one row, and
 * opens no transaction of its own: it joins the caller's, so a domain write and its wake-up commit
 * together.
 */
export class ScheduledWork {
  constructor(private readonly db: Database) {}

  get(kind: string, key: string): WorkRow | undefined {
    return this.db
      .select()
      .from(scheduledWork)
      .where(and(eq(scheduledWork.kind, kind), eq(scheduledWork.key, key)))
      .get();
  }

  /**
   * Asks for the work by `at`. The earliest ask wins; one made while it runs waits as `rearmAt`,
   * for when that run settles. `notBefore` only ever raises its gate.
   */
  request(
    kind: string,
    key: string,
    ask: { account: string | null; class: string; at: string; notBefore?: string | null },
    now: string,
  ): void {
    const row = this.get(kind, key);

    if (!row) {
      this.db
        .insert(scheduledWork)
        .values({
          kind,
          key,
          account: ask.account,
          class: ask.class,
          requestedAt: ask.at,
          notBefore: ask.notBefore ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return;
    }

    const claimed = row.claimedBy !== null;

    this.update(row, {
      requestedAt: claimed ? row.requestedAt : earlier(row.requestedAt, ask.at),
      rearmAt: claimed ? earlier(row.rearmAt, ask.at) : row.rearmAt,
      notBefore: later(row.notBefore, ask.notBefore ?? null),
      updatedAt: now,
    });
  }

  /** Rows nothing runs, with a request: what may be claimed, by deadline or not. */
  runnable(): WorkRow[] {
    return this.db
      .select()
      .from(scheduledWork)
      .all()
      .filter((row) => row.claimedBy === null && row.requestedAt !== null);
  }

  claim(row: WorkRow, bootId: string, now: string): void {
    this.update(row, { claimedBy: bootId, claimedAt: now, updatedAt: now });
  }

  update(row: Pick<WorkRow, 'kind' | 'key'>, values: Partial<WorkRow>): void {
    this.db
      .update(scheduledWork)
      .set(values)
      .where(and(eq(scheduledWork.kind, row.kind), eq(scheduledWork.key, row.key)))
      .run();
  }

  delete(row: Pick<WorkRow, 'kind' | 'key'>): void {
    this.db
      .delete(scheduledWork)
      .where(and(eq(scheduledWork.kind, row.kind), eq(scheduledWork.key, row.key)))
      .run();
  }

  /** Rows another process claimed: it is gone (this one owns the data directory). */
  claimedElsewhere(bootId: string): WorkRow[] {
    return this.db
      .select()
      .from(scheduledWork)
      .where(and(isNotNull(scheduledWork.claimedBy), ne(scheduledWork.claimedBy, bootId)))
      .all();
  }

  /** Every row, for pruning gates that have passed. */
  all(): WorkRow[] {
    return this.db.select().from(scheduledWork).all();
  }
}
