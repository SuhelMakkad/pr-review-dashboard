import type { ReviewNotification } from '@/notify.js';
import type { SyncStatus } from '@/types.js';
import type { OperationStatus } from '@/operations.js';

/** Events pushed to the browser over `GET /api/events` (Server-Sent Events). */
export type ServerEvent =
  | { type: 'hello'; bootId: string; account: string | null; demo: boolean }
  | { type: 'resync' }
  | { type: 'status'; status: SyncStatus }
  | { type: 'pulls.changed'; ids: string[] }
  | { type: 'triage.updated'; id: string }
  | { type: 'draft.updated'; id: string }
  | {
      type: 'operation.updated';
      account: string;
      prId: string;
      operationId: string;
      status: OperationStatus;
    }
  /** `runId` is absent when no run changed, such as when an automatic restart is rescheduled. */
  | { type: 'ai.updated'; prId: string; runId?: string }
  | { type: 'notify'; notifications: ReviewNotification[] }
  | { type: 'insights.updated' };

export type ServerEventType = ServerEvent['type'];
