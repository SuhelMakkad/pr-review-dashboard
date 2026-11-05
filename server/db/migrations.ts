import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * Ordered schema history. Never edit a released migration; append a new one instead.
 * Version 1 is the v1 schema, so databases created by Review Desk v1 upgrade in place.
 */
export const migrations: Migration[] = [
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
];

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };

  return Number(row.user_version);
}

function backupPath(databasePath: string, version: number): string {
  const directory = dirname(databasePath);
  const base = join(directory, `backup-v${version}.sqlite`);

  return existsSync(base) ? join(directory, `backup-v${version}-${Date.now()}.sqlite`) : base;
}

/**
 * Applies pending migrations, each in its own immediate transaction. An existing on-disk database
 * is copied with VACUUM INTO before its first pending migration, so an upgrade can be undone.
 */
export function migrate(db: DatabaseSync, databasePath: string, list = migrations): number {
  const current = schemaVersion(db);
  const pending = list.filter((migration) => migration.version > current);

  if (pending.length === 0) return current;

  if (current > 0 && databasePath !== ':memory:') {
    db.prepare('VACUUM INTO ?').run(backupPath(databasePath, current));
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
