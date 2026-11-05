import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyTriage } from '../../shared/attention.js';
import type { LocalTriageState, PullRequestSnapshot, SyncStatus } from '../../shared/types.js';
import { migrate } from './migrations.js';

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
      .map((row) => JSON.parse(String(row.data)) as PullRequestSnapshot);
  }

  snapshot(account: string, id: string): PullRequestSnapshot | null {
    const row = this.db
      .prepare('SELECT data FROM snapshots WHERE account = ? AND id = ?')
      .get(account, id);

    return row ? (JSON.parse(String(row.data)) as PullRequestSnapshot) : null;
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

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT data FROM settings WHERE key = ?').get(key);

    return row ? (JSON.parse(String(row.data)) as T) : null;
  }

  saveStatus(status: SyncStatus): void {
    if (!status.account) return;

    this.setSetting(`status:${status.account.login}`, { ...status, syncing: false });
    this.setSetting('lastAccount', status.account.login);
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
