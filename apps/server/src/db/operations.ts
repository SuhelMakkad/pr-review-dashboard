import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { GitHubOperation } from '@review-desk/shared/operations';
import { storedSteps } from '@/operations/intent.js';
import { githubOperations } from '@/db/schema.js';
import type { Database } from '@/db/store.js';
import type { OperationRecord } from '@/operations/types.js';

/** The statuses of rows still to settle, which the queue sends or checks. */
const ACTIVE: GitHubOperation['status'][] = [
  'queued',
  'running',
  'waiting',
  'checking',
  'needs_attention',
];

/**
 * True for a forge operation, false for a local receipt. Rows from before local receipts existed
 * carry no kind: they are all forge operations.
 */
/**
 * A row as read: its steps each a step, a missing or damaged entry read as a placeholder that keeps
 * its index (see `storedSteps`), so startup, Activity and the queue never meet a malformed one.
 */
const stored = (row: OperationRecord): OperationRecord => ({
  ...row,
  steps: storedSteps(row.steps),
});

const forgeRow = sql`json_extract(${githubOperations.data}, '$.kind') IS NOT 'local'`;

/**
 * The outbox's rows: forge operations, and the receipts of local writes that answered an outbox
 * ID. Both share one ID space per account. Only the replay lookup (`find`) sees a local receipt;
 * every listing and lookup Activity shows leaves them out. Each method is one statement and opens
 * no transaction of its own.
 */
export class OperationLog {
  constructor(private readonly db: Database) {}

  /** Every account's rows a previous process left running or being checked. */
  interrupted(): OperationRecord[] {
    return this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(inArray(githubOperations.status, ['running', 'checking']))
      .all()
      .map((row) => stored(row.data));
  }

  /** The account's rows still to settle, oldest first. */
  active(account: string): OperationRecord[] {
    return this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(and(eq(githubOperations.account, account), inArray(githubOperations.status, ACTIVE)))
      .orderBy(asc(githubOperations.createdAt), asc(githubOperations.id))
      .all()
      .map((row) => stored(row.data));
  }

  /** The row with this ID, a local receipt included: what a retry of that ID replays. */
  find(account: string, id: string): OperationRecord | undefined {
    const row = this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(and(eq(githubOperations.account, account), eq(githubOperations.id, id)))
      .get()?.data;

    return row && stored(row);
  }

  /** The forge operation with this ID, as Activity shows it; never a local receipt. */
  visible(account: string, id: string): OperationRecord | undefined {
    const row = this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(and(eq(githubOperations.account, account), eq(githubOperations.id, id), forgeRow))
      .get()?.data;

    return row && stored(row);
  }

  /**
   * A page of the account's finished forge operations, newest first, from before `cursor`. Local
   * receipts are left out before the limit, so they never take a visible row's place.
   */
  finished(
    account: string,
    statuses: GitHubOperation['status'][],
    cursor: { createdAt: string; id: string } | null,
    limit: number,
  ): OperationRecord[] {
    return this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(
        and(
          eq(githubOperations.account, account),
          inArray(githubOperations.status, statuses),
          forgeRow,
          cursor
            ? or(
                lt(githubOperations.createdAt, cursor.createdAt),
                and(
                  eq(githubOperations.createdAt, cursor.createdAt),
                  lt(githubOperations.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(githubOperations.createdAt), desc(githubOperations.id))
      .limit(limit)
      .all()
      .map((row) => stored(row.data));
  }

  /**
   * When the account's newest forge operation was created, so the next one sorts after it. Local
   * receipts take no part: an invisible discard never moves the visible timeline.
   */
  latestCreatedAt(account: string): string | null {
    return (
      this.db
        .select({ createdAt: githubOperations.createdAt })
        .from(githubOperations)
        .where(and(eq(githubOperations.account, account), forgeRow))
        .orderBy(desc(githubOperations.createdAt))
        .limit(1)
        .get()?.createdAt ?? null
    );
  }

  insert(row: OperationRecord): void {
    this.db
      .insert(githubOperations)
      .values({
        account: row.account,
        id: row.id,
        prId: row.prId,
        status: row.status,
        createdAt: row.createdAt,
        data: row,
      })
      .run();
  }

  update(row: OperationRecord): void {
    this.db
      .update(githubOperations)
      .set({ status: row.status, data: row })
      .where(and(eq(githubOperations.account, row.account), eq(githubOperations.id, row.id)))
      .run();
  }
}
