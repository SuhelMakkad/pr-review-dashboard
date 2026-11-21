import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { AiRunStatus, AiTask } from '@review-desk/shared/ai';
import { batches } from '@/db/batches.js';
import type { Database } from '@/db/store.js';
import { aiRuns, autoReviewLog, type AiRunRow } from '@/db/schema.js';

export type { AiRunRow };

/**
 * AI task runs, as the runner and the automatic reviewer ask for them. Each method is one
 * statement, or one per batch, and opens no transaction: a caller's `store.transaction` covers
 * every method it calls, as when a run settles together with its publication decision.
 */
export class AiRuns {
  constructor(private readonly db: Database) {}

  get(id: string): AiRunRow | null {
    return this.db.select().from(aiRuns).where(eq(aiRuns.id, id)).get() ?? null;
  }

  insert(row: typeof aiRuns.$inferInsert): void {
    this.db.insert(aiRuns).values(row).run();
  }

  update(id: string, changes: Partial<typeof aiRuns.$inferInsert>): void {
    if (Object.keys(changes).length === 0) return;

    this.db.update(aiRuns).set(changes).where(eq(aiRuns.id, id)).run();
  }

  /** Every account's runs that were queued or running, as a previous process left them. */
  unfinished(): AiRunRow[] {
    return this.db
      .select()
      .from(aiRuns)
      .where(inArray(aiRuns.status, ['queued', 'running']))
      .all();
  }

  /** The account's runs a server restart paused, oldest first. */
  pausedByRestart(account: string): AiRunRow[] {
    return this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.account, account),
          eq(aiRuns.status, 'paused'),
          eq(aiRuns.pauseReason, 'restart'),
        ),
      )
      .orderBy(aiRuns.createdAt)
      .all();
  }

  /** The newest run with this cache key that is queued, running, paused or done. */
  latestByKey(account: string, cacheKey: string): AiRunRow | null {
    return (
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.account, account),
            eq(aiRuns.cacheKey, cacheKey),
            inArray(aiRuns.status, ['queued', 'running', 'paused', 'done']),
          ),
        )
        .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get() ?? null
    );
  }

  /** The task's runs on the PR in one of `statuses`, in storage order. */
  withStatus(account: string, prId: string, task: AiTask, statuses: AiRunStatus[]): AiRunRow[] {
    return this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.account, account),
          eq(aiRuns.prId, prId),
          eq(aiRuns.task, task),
          inArray(aiRuns.status, statuses),
        ),
      )
      .all();
  }

  /** The newest run of the task on the PR that is queued, running or paused. */
  active(account: string, prId: string, task: AiTask): AiRunRow | null {
    return (
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.account, account),
            eq(aiRuns.prId, prId),
            eq(aiRuns.task, task),
            inArray(aiRuns.status, ['queued', 'running', 'paused']),
          ),
        )
        .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get() ?? null
    );
  }

  /** The PR's finished full reviews, newest first. */
  doneReviews(account: string, prId: string): AiRunRow[] {
    return this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.account, account),
          eq(aiRuns.prId, prId),
          eq(aiRuns.task, 'full_review'),
          eq(aiRuns.status, 'done'),
        ),
      )
      .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
      .all();
  }

  /** Every full review of the account's PRs, newest first. */
  reviews(account: string): AiRunRow[] {
    return this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.account, account), eq(aiRuns.task, 'full_review')))
      .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
      .all();
  }

  /** Every run on the PR, newest first. */
  forPull(account: string, prId: string): AiRunRow[] {
    return this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.account, account), eq(aiRuns.prId, prId)))
      .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
      .all();
  }

  /** The newest full review of the PR started at or after `since`, other than `except`. */
  reviewStartedSince(
    account: string,
    prId: string,
    since: string,
    except: string | null,
  ): AiRunRow | null {
    return (
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.account, account),
            eq(aiRuns.prId, prId),
            eq(aiRuns.task, 'full_review'),
            ne(aiRuns.id, except ?? ''),
            gte(aiRuns.createdAt, since),
          ),
        )
        .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get() ?? null
    );
  }

  /** The account's automatic full reviews that are queued, running or paused. */
  automaticReviewsInFlight(account: string): AiRunRow[] {
    return this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.account, account),
          eq(aiRuns.task, 'full_review'),
          eq(aiRuns.trigger, 'auto'),
          inArray(aiRuns.status, ['queued', 'running', 'paused']),
        ),
      )
      .all();
  }
}

export type AutoReviewEntry = typeof autoReviewLog.$inferSelect;
export type AutoReviewStatus = AutoReviewEntry['status'];

/** What a recorded entry says about its request, besides its key and PR. */
export type AutoReviewRecord = Pick<
  AutoReviewEntry,
  'status' | 'runId' | 'attempts' | 'error' | 'headOid' | 'restartAt' | 'waitingSince' | 'updatedAt'
>;

/**
 * The requests automatic review has handled, one entry per request key. Like `AiRuns`, each
 * method opens no transaction of its own.
 */
export class AutoReviewLog {
  constructor(private readonly db: Database) {}

  /** Every entry of the account. */
  all(account: string): AutoReviewEntry[] {
    return this.db.select().from(autoReviewLog).where(eq(autoReviewLog.account, account)).all();
  }

  /** The account's entries in one of `statuses`, on one PR when `prId` is given. */
  withStatus(account: string, statuses: AutoReviewStatus[], prId?: string): AutoReviewEntry[] {
    return this.db
      .select()
      .from(autoReviewLog)
      .where(
        and(
          eq(autoReviewLog.account, account),
          inArray(autoReviewLog.status, statuses),
          prId === undefined ? undefined : eq(autoReviewLog.prId, prId),
        ),
      )
      .all();
  }

  /** The account's entries for one run, in one of `statuses`. */
  forRun(account: string, runId: string, statuses: AutoReviewStatus[]): AutoReviewEntry[] {
    return this.db
      .select()
      .from(autoReviewLog)
      .where(
        and(
          eq(autoReviewLog.account, account),
          eq(autoReviewLog.runId, runId),
          inArray(autoReviewLog.status, statuses),
        ),
      )
      .all();
  }

  /** Every account's entries still waiting to restart or to be checked. */
  pending(): AutoReviewEntry[] {
    return this.db
      .select()
      .from(autoReviewLog)
      .where(inArray(autoReviewLog.status, ['waiting', 'checking']))
      .all();
  }

  /** Saves the request's entry, replacing what it said before. */
  record(account: string, key: string, prId: string, values: AutoReviewRecord): void {
    this.db
      .insert(autoReviewLog)
      .values({ account, key, prId, ...values })
      .onConflictDoUpdate({ target: [autoReviewLog.account, autoReviewLog.key], set: values })
      .run();
  }

  /**
   * Marks every one of `candidates` handled, as requests already waiting when automatic review was
   * turned on: new ones as primed, and failed or waiting ones from an earlier period too. Reviews
   * that finished while it was off stand as started.
   */
  prime(account: string, candidates: { key: string; prId: string }[], updatedAt: string): void {
    for (const batch of batches(candidates)) {
      this.db
        .insert(autoReviewLog)
        .values(
          batch.map(({ key, prId }) => ({
            account,
            key,
            prId,
            status: 'primed' as const,
            updatedAt,
          })),
        )
        .onConflictDoNothing()
        .run();

      this.db
        .update(autoReviewLog)
        .set({ status: 'primed', updatedAt, headOid: null, restartAt: null })
        .where(
          and(
            eq(autoReviewLog.account, account),
            inArray(autoReviewLog.status, ['failed', 'waiting']),
            inArray(
              autoReviewLog.key,
              batch.map(({ key }) => key),
            ),
          ),
        )
        .run();
    }

    this.db
      .update(autoReviewLog)
      .set({ status: 'started', updatedAt })
      .where(and(eq(autoReviewLog.account, account), eq(autoReviewLog.status, 'checking')))
      .run();
  }

  /** Ends the PR's waits other than `key`'s, as skipped. */
  closeWaits(account: string, prId: string, key: string, updatedAt: string): void {
    this.db
      .update(autoReviewLog)
      .set({ status: 'skipped', headOid: null, restartAt: null, waitingSince: null, updatedAt })
      .where(
        and(
          eq(autoReviewLog.account, account),
          eq(autoReviewLog.prId, prId),
          eq(autoReviewLog.status, 'waiting'),
          ne(autoReviewLog.key, key),
        ),
      )
      .run();
  }

  /** Ends the checks waiting on a run, as started. */
  endChecks(account: string, runId: string, updatedAt: string): void {
    this.db
      .update(autoReviewLog)
      .set({ status: 'started', updatedAt })
      .where(
        and(
          eq(autoReviewLog.account, account),
          eq(autoReviewLog.runId, runId),
          eq(autoReviewLog.status, 'checking'),
        ),
      )
      .run();
  }

  /** Drops every account's promised restarts, as primed, and owed checks, as started. */
  dropPending(updatedAt: string): void {
    this.db
      .update(autoReviewLog)
      .set({ status: 'primed', headOid: null, restartAt: null, waitingSince: null, updatedAt })
      .where(eq(autoReviewLog.status, 'waiting'))
      .run();
    this.db
      .update(autoReviewLog)
      .set({ status: 'started', updatedAt })
      .where(eq(autoReviewLog.status, 'checking'))
      .run();
  }
}
