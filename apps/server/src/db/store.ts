import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, asc, eq, gte, max } from 'drizzle-orm';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { emptyTriage } from '@review-desk/shared/attention';
import { normalizeSnapshot } from '@review-desk/shared/snapshot';
import type {
  FeedSource,
  LocalTriageState,
  PullRequestSnapshot,
  Source,
  SyncStatus,
} from '@review-desk/shared/types';
import type { ActivityEvent } from '@/insights/extract.js';
import { migrateDatabase } from '@/db/migrate.js';
import {
  activityEvents,
  aiRuns,
  autoReviewLog,
  githubOperations,
  draftComments,
  feedMembership,
  notificationLog,
  prSync,
  queueSamples,
  reviewDrafts,
  settings,
  snapshots,
  triage,
} from '@/db/schema.js';

/** The Drizzle database, with the underlying `node:sqlite` connection as `$client`. */
export type Database = NodeSQLiteDatabase & { $client: DatabaseSync };

export interface SyncState {
  fingerprint: string | null;
  lastFullAt: string | null;
  nextFullAt: string | null;
}

export interface QueueSample {
  at: string;
  attention: number;
  waiting: number;
  authoredBlocked: number;
  oldestAttentionAt: string | null;
}

/** Rows per multi-row INSERT, well under SQLite's limit on bound parameters. */
const BATCH_SIZE = 200;

export function* batches<T>(rows: T[]): Generator<T[]> {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    yield rows.slice(start, start + BATCH_SIZE);
  }
}

export class Store {
  readonly db: Database;
  private transactionDepth = 0;
  /** Effects waiting for the outermost transaction to commit. */
  private committed: (() => void)[] = [];

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const client = new DatabaseSync(path);

    client.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db = drizzle({ client });
    migrateDatabase(this.db, path);
  }

  /** Runs `work` in one immediate transaction, rolling back if it throws. */
  transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) return this.savepoint(work);

    let result: T;

    this.transactionDepth++;

    try {
      result = this.db.transaction<T>(work as never, { behavior: 'immediate' });
    } catch (error) {
      this.committed = [];

      throw error;
    } finally {
      this.transactionDepth--;
    }

    // Committed: only now may in-memory state follow what the transaction saved.
    for (const effect of this.committed.splice(0)) effect();

    return result;
  }

  /** A nested transaction: a savepoint inside the one in progress. */
  private savepoint<T>(work: () => T): T {
    const name = `store_nested_${this.transactionDepth++}`;
    const pending = this.committed.length;

    try {
      this.db.$client.exec(`SAVEPOINT ${name}`);

      try {
        const result = work();
        this.db.$client.exec(`RELEASE SAVEPOINT ${name}`);

        return result;
      } catch (error) {
        this.db.$client.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
        // What the rolled-back part asked to do after committing never happened.
        this.committed.length = pending;

        throw error;
      }
    } finally {
      this.transactionDepth--;
    }
  }

  /**
   * Runs `effect` once the outermost transaction in progress commits, and never if it rolls back;
   * at once outside a transaction. For in-memory state that must not run ahead of the database.
   */
  afterCommit(effect: () => void): void {
    if (this.transactionDepth === 0) effect();
    else this.committed.push(effect);
  }

  /** Every cached PR of the account, closed and merged ones included, in ID order. */
  snapshots(account: string): PullRequestSnapshot[] {
    return this.db
      .select({ data: snapshots.data })
      .from(snapshots)
      .where(eq(snapshots.account, account))
      .orderBy(asc(snapshots.id))
      .all()
      .map((row) => normalizeSnapshot(row.data));
  }

  /**
   * The account's open PRs, in ID order, through the state index: closed and merged ones are never
   * read. A row whose JSON is malformed has no state, so this skips it where `snapshots` fails.
   */
  openSnapshots(account: string): PullRequestSnapshot[] {
    return this.db
      .select({ data: snapshots.data })
      .from(snapshots)
      .where(and(eq(snapshots.account, account), eq(snapshots.state, 'OPEN')))
      .orderBy(asc(snapshots.id))
      .all()
      .map((row) => normalizeSnapshot(row.data));
  }

  snapshot(account: string, id: string): PullRequestSnapshot | null {
    const row = this.db
      .select({ data: snapshots.data })
      .from(snapshots)
      .where(and(eq(snapshots.account, account), eq(snapshots.id, id)))
      .get();

    return row ? normalizeSnapshot(row.data) : null;
  }

  saveSnapshot(account: string, snapshot: PullRequestSnapshot): void {
    this.db
      .insert(snapshots)
      .values({ account, id: snapshot.id, data: snapshot })
      .onConflictDoUpdate({ target: [snapshots.account, snapshots.id], set: { data: snapshot } })
      .run();
  }

  triage(account: string, id: string): LocalTriageState {
    const row = this.db
      .select({ data: triage.data })
      .from(triage)
      .where(and(eq(triage.account, account), eq(triage.id, id)))
      .get();

    return row ? { ...emptyTriage(), ...row.data } : emptyTriage();
  }

  saveTriage(account: string, id: string, state: LocalTriageState): void {
    this.db
      .insert(triage)
      .values({ account, id, data: state })
      .onConflictDoUpdate({ target: [triage.account, triage.id], set: { data: state } })
      .run();
  }

  syncState(account: string, id: string): SyncState | null {
    const row = this.db
      .select({
        fingerprint: prSync.fingerprint,
        lastFullAt: prSync.lastFullAt,
        nextFullAt: prSync.nextFullAt,
      })
      .from(prSync)
      .where(and(eq(prSync.account, account), eq(prSync.id, id)))
      .get();

    return row ?? null;
  }

  saveSyncState(account: string, id: string, state: SyncState): void {
    this.db
      .insert(prSync)
      .values({ account, id, ...state })
      .onConflictDoUpdate({ target: [prSync.account, prSync.id], set: state })
      .run();
  }

  /** Which discovery feeds currently return each PR. */
  membership(account: string): Map<string, Source[]> {
    const rows = this.db
      .select({ id: feedMembership.id, feed: feedMembership.feed })
      .from(feedMembership)
      .where(eq(feedMembership.account, account))
      .all();
    const result = new Map<string, Source[]>();

    for (const row of rows) result.set(row.id, [...(result.get(row.id) ?? []), row.feed]);

    return result;
  }

  /** Records a successful feed run: exactly `ids` are now members of `feed`. */
  replaceFeed(account: string, feed: FeedSource, ids: string[], at: string): void {
    this.transaction(() => {
      this.db
        .delete(feedMembership)
        .where(and(eq(feedMembership.account, account), eq(feedMembership.feed, feed)))
        .run();

      for (const batch of batches(ids)) {
        this.db
          .insert(feedMembership)
          .values(batch.map((id) => ({ account, id, feed, seenAt: at })))
          .onConflictDoNothing()
          .run();
      }
    });
  }

  /**
   * Marks a PR as added by hand. Discovery never replaces the `manual` feed. Returns the new
   * membership's ID, or null when the PR was already added by hand (nothing changed).
   */
  addManual(account: string, id: string, at: string): string | null {
    const membershipId = randomUUID();
    const result = this.db
      .insert(feedMembership)
      .values({ account, id, feed: 'manual', seenAt: at, membershipId })
      .onConflictDoNothing()
      .run();

    return Number(result.changes) > 0 ? membershipId : null;
  }

  /** When the PR was added by hand; null when it was not. */
  manualAddedAt(account: string, id: string): string | null {
    const row = this.db
      .select({ seenAt: feedMembership.seenAt })
      .from(feedMembership)
      .where(
        and(
          eq(feedMembership.account, account),
          eq(feedMembership.id, id),
          eq(feedMembership.feed, 'manual'),
        ),
      )
      .get();

    return row?.seenAt ?? null;
  }

  /**
   * Removes the PR's manual membership; with `membershipId`, only that one, so an Undo never
   * removes a membership added again since. True when one was removed.
   */
  removeManual(account: string, id: string, membershipId?: string): boolean {
    return (
      Number(
        this.db
          .delete(feedMembership)
          .where(
            and(
              eq(feedMembership.account, account),
              eq(feedMembership.id, id),
              eq(feedMembership.feed, 'manual'),
              membershipId === undefined
                ? undefined
                : eq(feedMembership.membershipId, membershipId),
            ),
          )
          .run().changes,
      ) > 0
    );
  }

  /**
   * Stops tracking a PR: drops its cached snapshot and sync bookkeeping. Notes, activity history,
   * drafts and AI runs are kept, so adding the PR again brings them back.
   */
  forgetPull(account: string, id: string): void {
    this.transaction(() => {
      this.db
        .delete(snapshots)
        .where(and(eq(snapshots.account, account), eq(snapshots.id, id)))
        .run();
      this.db
        .delete(prSync)
        .where(and(eq(prSync.account, account), eq(prSync.id, id)))
        .run();
    });
  }

  /** Idempotently appends activity; events are keyed so re-extraction never duplicates. */
  recordActivity(account: string, events: ActivityEvent[]): number {
    let added = 0;

    this.transaction(() => {
      for (const batch of batches(events)) {
        const result = this.db
          .insert(activityEvents)
          .values(
            batch.map((event) => ({
              account,
              key: event.key,
              prId: event.prId,
              repository: event.repository,
              number: event.number,
              kind: event.kind,
              actor: event.actor,
              at: event.at,
              data: event.data ?? {},
            })),
          )
          .onConflictDoNothing()
          .run();

        added += Number(result.changes);
      }
    });

    return added;
  }

  activity(account: string, since = '1970-01-01T00:00:00.000Z'): ActivityEvent[] {
    return this.db
      .select({
        key: activityEvents.key,
        prId: activityEvents.prId,
        repository: activityEvents.repository,
        number: activityEvents.number,
        kind: activityEvents.kind,
        actor: activityEvents.actor,
        at: activityEvents.at,
        data: activityEvents.data,
      })
      .from(activityEvents)
      .where(and(eq(activityEvents.account, account), gte(activityEvents.at, since)))
      .orderBy(asc(activityEvents.at))
      .all();
  }

  lastQueueSampleAt(account: string): string | null {
    const row = this.db
      .select({ at: max(queueSamples.at) })
      .from(queueSamples)
      .where(eq(queueSamples.account, account))
      .get();

    return row?.at ?? null;
  }

  saveQueueSample(account: string, sample: QueueSample): void {
    this.db
      .insert(queueSamples)
      .values({ account, ...sample })
      .onConflictDoUpdate({ target: [queueSamples.account, queueSamples.at], set: sample })
      .run();
  }

  queueSamples(account: string, since: string): QueueSample[] {
    return this.db
      .select({
        at: queueSamples.at,
        attention: queueSamples.attention,
        waiting: queueSamples.waiting,
        authoredBlocked: queueSamples.authoredBlocked,
        oldestAttentionAt: queueSamples.oldestAttentionAt,
      })
      .from(queueSamples)
      .where(and(eq(queueSamples.account, account), gte(queueSamples.at, since)))
      .orderBy(asc(queueSamples.at))
      .all();
  }

  /** Removes cached PRs, local triage and everything else held for one account (demo reset). */
  clearAccount(account: string): void {
    const tables = [
      snapshots,
      triage,
      prSync,
      feedMembership,
      activityEvents,
      queueSamples,
      draftComments,
      reviewDrafts,
      aiRuns,
      notificationLog,
      autoReviewLog,
      githubOperations,
    ];

    this.transaction(() => {
      for (const table of tables) this.db.delete(table).where(eq(table.account, account)).run();
    });
  }

  getSetting<T>(key: string): T | null {
    const row = this.db
      .select({ data: settings.data })
      .from(settings)
      .where(eq(settings.key, key))
      .get();

    return row ? (row.data as T) : null;
  }

  saveStatus(status: SyncStatus): void {
    if (!status.account) return;

    this.setSetting(`status:${status.account.login}`, { ...status, syncing: false });
    this.setSetting('lastAccount', status.account.login);
  }

  deleteSetting(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, data: value })
      .onConflictDoUpdate({ target: settings.key, set: { data: value } })
      .run();
  }

  close(): void {
    this.db.$client.close();
  }
}
