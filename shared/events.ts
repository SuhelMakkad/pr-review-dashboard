import type { SyncStatus } from './types.js';

/** Events pushed to the browser over `GET /api/events` (Server-Sent Events). */
export type ServerEvent =
  | { type: 'hello'; bootId: string; account: string | null; demo: boolean }
  | { type: 'resync' }
  | { type: 'status'; status: SyncStatus }
  | { type: 'pulls.changed'; ids: string[] }
  | { type: 'triage.updated'; id: string };

export type ServerEventType = ServerEvent['type'];
