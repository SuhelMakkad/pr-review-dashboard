import type { DatabaseSync } from 'node:sqlite';
import { writeBackup } from '@/db/backups.js';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * The schema history from before Drizzle, frozen at version 5. It now only brings older databases
 * up to version 5, which is identical to Drizzle's baseline migration; new schema changes go in
 * `server/db/schema.ts` and `drizzle/`. Version 1 is the v1 schema, so databases created by Review
 * Desk v1 upgrade in place.
 */
export const legacyMigrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY (account, id)
        );
        CREATE TABLE IF NOT EXISTS triage (
          account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY (account, id)
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      `);
    },
  },
  {
    version: 2,
    name: 'sync-v2-and-activity',
    up(db) {
      db.exec(`
        CREATE TABLE pr_sync (
          account TEXT NOT NULL, id TEXT NOT NULL,
          fingerprint TEXT, last_full_at TEXT, next_full_at TEXT,
          PRIMARY KEY (account, id)
        );
        CREATE TABLE feed_membership (
          account TEXT NOT NULL, id TEXT NOT NULL, feed TEXT NOT NULL, seen_at TEXT NOT NULL,
          PRIMARY KEY (account, id, feed)
        );
        CREATE TABLE activity_events (
          account TEXT NOT NULL, key TEXT NOT NULL, pr_id TEXT NOT NULL,
          repository TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL,
          actor TEXT, at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (account, key)
        );
        CREATE INDEX activity_events_by_time ON activity_events (account, at);
        CREATE TABLE queue_samples (
          account TEXT NOT NULL, at TEXT NOT NULL,
          attention INTEGER NOT NULL, waiting INTEGER NOT NULL, authored_blocked INTEGER NOT NULL,
          oldest_attention_at TEXT,
          PRIMARY KEY (account, at)
        );
      `);
    },
  },
  {
    version: 3,
    name: 'review-drafts',
    up(db) {
      db.exec(`
        CREATE TABLE review_drafts (
          account TEXT NOT NULL, pr_id TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '', event TEXT NOT NULL DEFAULT 'COMMENT',
          github_review_id TEXT, updated_at TEXT NOT NULL,
          PRIMARY KEY (account, pr_id)
        );
        CREATE TABLE draft_comments (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, pr_id TEXT NOT NULL,
          path TEXT NOT NULL, line INTEGER, side TEXT NOT NULL DEFAULT 'RIGHT',
          start_line INTEGER, start_side TEXT, subject_type TEXT NOT NULL DEFAULT 'LINE',
          body TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'user', anchor_oid TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft', github_thread_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX draft_comments_by_pr ON draft_comments (account, pr_id, created_at);
      `);
    },
  },
  {
    version: 4,
    name: 'ai-runs',
    up(db) {
      db.exec(`
        CREATE TABLE ai_runs (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, pr_id TEXT NOT NULL, task TEXT NOT NULL,
          provider TEXT NOT NULL, model TEXT, effort TEXT NOT NULL, head_oid TEXT NOT NULL,
          prompt_version INTEGER NOT NULL, cache_key TEXT NOT NULL, status TEXT NOT NULL,
          progress TEXT, result TEXT, error TEXT, usage TEXT,
          created_at TEXT NOT NULL, finished_at TEXT
        );
        CREATE INDEX ai_runs_by_pr ON ai_runs (account, pr_id, task, created_at);
        CREATE INDEX ai_runs_by_key ON ai_runs (cache_key, created_at);
      `);
    },
  },
  {
    version: 5,
    name: 'notification-log',
    up(db) {
      db.exec(`
        CREATE TABLE notification_log (
          account TEXT NOT NULL, key TEXT NOT NULL, pr_id TEXT NOT NULL,
          channel TEXT NOT NULL, sent_at TEXT NOT NULL,
          PRIMARY KEY (account, key)
        );
      `);
    },
  },
];

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };

  return Number(row.user_version);
}

/**
 * Applies pending migrations, each in its own immediate transaction. An existing on-disk database
 * is copied with VACUUM INTO before its first pending migration, so an upgrade can be undone.
 */
export function migrate(db: DatabaseSync, databasePath: string, list = legacyMigrations): number {
  const current = schemaVersion(db);
  const pending = list.filter((migration) => migration.version > current);

  if (pending.length === 0) return current;

  if (current > 0 && databasePath !== ':memory:') {
    writeBackup(db, databasePath, `v${current}`);
  }

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');

    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');

      throw new Error(
        `Database migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return pending.at(-1)!.version;
}
