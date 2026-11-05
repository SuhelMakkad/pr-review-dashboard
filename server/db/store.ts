import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyTriage } from '../../shared/attention.js';
import { normalizeSnapshot } from '../../shared/snapshot.js';
import type {
  LocalTriageState,
  PullRequestSnapshot,
  Source,
  SyncStatus,
} from '../../shared/types.js';
import type { ActivityEvent } from '../insights/extract.js';
import { migrate } from './migrations.js';

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

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    migrate(this.db, path);
  }

  /** Runs `work` in one immediate transaction, rolling back if it throws. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const result = work();

      this.db.exec('COMMIT');

      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');

      throw error;
    }
  }

  snapshots(account: string): PullRequestSnapshot[] {
    return this.db
      .prepare('SELECT data FROM snapshots WHERE account = ?')
      .all(account)
      .map((row) => normalizeSnapshot(JSON.parse(String(row.data)) as PullRequestSnapshot));
  }

  snapshot(account: string, id: string): PullRequestSnapshot | null {
    const row = this.db
      .prepare('SELECT data FROM snapshots WHERE account = ? AND id = ?')
      .get(account, id);

    return row ? normalizeSnapshot(JSON.parse(String(row.data)) as PullRequestSnapshot) : null;
  }

  saveSnapshot(account: string, snapshot: PullRequestSnapshot): void {
    this.db
      .prepare('INSERT OR REPLACE INTO snapshots (account, id, data) VALUES (?, ?, ?)')
      .run(account, snapshot.id, JSON.stringify(snapshot));
  }

  triage(account: string, id: string): LocalTriageState {
    const row = this.db
      .prepare('SELECT data FROM triage WHERE account = ? AND id = ?')
      .get(account, id);

    return row
      ? ({ ...emptyTriage(), ...JSON.parse(String(row.data)) } as LocalTriageState)
      : emptyTriage();
  }

  saveTriage(account: string, id: string, state: LocalTriageState): void {
    this.db
      .prepare('INSERT OR REPLACE INTO triage (account, id, data) VALUES (?, ?, ?)')
      .run(account, id, JSON.stringify(state));
  }

  syncState(account: string, id: string): SyncState | null {
    const row = this.db
      .prepare(
        'SELECT fingerprint, last_full_at, next_full_at FROM pr_sync WHERE account = ? AND id = ?',
      )
      .get(account, id) as
      | { fingerprint: string | null; last_full_at: string | null; next_full_at: string | null }
      | undefined;

    return row
      ? { fingerprint: row.fingerprint, lastFullAt: row.last_full_at, nextFullAt: row.next_full_at }
      : null;
  }

  saveSyncState(account: string, id: string, state: SyncState): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO pr_sync (account, id, fingerprint, last_full_at, next_full_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(account, id, state.fingerprint, state.lastFullAt, state.nextFullAt);
  }

  /** Which discovery feeds currently return each PR. */
  membership(account: string): Map<string, Source[]> {
    const rows = this.db
      .prepare('SELECT id, feed FROM feed_membership WHERE account = ?')
      .all(account) as { id: string; feed: Source }[];
    const result = new Map<string, Source[]>();

    for (const row of rows) result.set(row.id, [...(result.get(row.id) ?? []), row.feed]);

    return result;
  }

  /** Records a successful feed run: exactly `ids` are now members of `feed`. */
  replaceFeed(account: string, feed: Source, ids: string[], at: string): void {
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM feed_membership WHERE account = ? AND feed = ?')
        .run(account, feed);

      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO feed_membership (account, id, feed, seen_at) VALUES (?, ?, ?, ?)',
      );

      for (const id of ids) insert.run(account, id, feed, at);
    });
  }

  /** Idempotently appends activity; events are keyed so re-extraction never duplicates. */
  recordActivity(account: string, events: ActivityEvent[]): number {
    if (events.length === 0) return 0;

    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO activity_events (account, key, pr_id, repository, number, kind, actor, at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let added = 0;

    this.transaction(() => {
      for (const event of events) {
        const result = insert.run(
          account,
          event.key,
          event.prId,
          event.repository,
          event.number,
          event.kind,
          event.actor,
          event.at,
          JSON.stringify(event.data ?? {}),
        );

        added += Number(result.changes);
      }
    });

    return added;
  }

  activity(account: string, since = '1970-01-01T00:00:00.000Z'): ActivityEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM activity_events WHERE account = ? AND at >= ? ORDER BY at')
        .all(account, since) as Record<string, unknown>[]
    ).map((row) => ({
      key: String(row.key),
      prId: String(row.pr_id),
      repository: String(row.repository),
      number: Number(row.number),
      kind: String(row.kind) as ActivityEvent['kind'],
      actor: row.actor === null ? null : String(row.actor),
      at: String(row.at),
      data: JSON.parse(String(row.data)) as Record<string, unknown>,
    }));
  }

  lastQueueSampleAt(account: string): string | null {
    const row = this.db
      .prepare('SELECT MAX(at) AS at FROM queue_samples WHERE account = ?')
      .get(account) as { at: string | null };

    return row.at;
  }

  saveQueueSample(account: string, sample: QueueSample): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO queue_samples (account, at, attention, waiting, authored_blocked, oldest_attention_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        account,
        sample.at,
        sample.attention,
        sample.waiting,
        sample.authoredBlocked,
        sample.oldestAttentionAt,
      );
  }

  queueSamples(account: string, since: string): QueueSample[] {
    return (
      this.db
        .prepare('SELECT * FROM queue_samples WHERE account = ? AND at >= ? ORDER BY at')
        .all(account, since) as Record<string, unknown>[]
    ).map((row) => ({
      at: String(row.at),
      attention: Number(row.attention),
      waiting: Number(row.waiting),
      authoredBlocked: Number(row.authored_blocked),
      oldestAttentionAt: row.oldest_attention_at === null ? null : String(row.oldest_attention_at),
    }));
  }

  /** Removes cached PRs and local triage for one account (demo reset). */
  clearAccount(account: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM snapshots WHERE account = ?').run(account);
      this.db.prepare('DELETE FROM triage WHERE account = ?').run(account);

      for (const table of [
        'pr_sync',
        'feed_membership',
        'activity_events',
        'queue_samples',
        'draft_comments',
        'review_drafts',
        'ai_runs',
        'notification_log',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE account = ?`).run(account);
      }
    });
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT data FROM settings WHERE key = ?').get(key);

    return row ? (JSON.parse(String(row.data)) as T) : null;
  }

  saveStatus(status: SyncStatus): void {
    if (!status.account) return;

    this.setSetting(`status:${status.account.login}`, { ...status, syncing: false });
    this.setSetting('lastAccount', status.account.login);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, data) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }
}
