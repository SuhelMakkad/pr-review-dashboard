import type { GitHubOperation } from '@review-desk/shared/operations';
import type { Intent } from '@/operations/intent.js';
import type { Wording } from '@/messages.js';
import type { ReviewReceipt } from '@/github/api.js';

export interface MutationStep {
  method: string;
  args: unknown[];
  startedAt: string;
  completedAt: string | null;
  result: unknown;
  uncertain: boolean;
  /** Completed from the forge's own response, not inferred from its state afterwards. */
  acknowledged?: boolean;
}

export interface OperationRecord extends Omit<GitHubOperation, 'controls' | 'progress' | 'error'> {
  /**
   * What Activity says of the action, and why it failed: catalog messages, or text from before
   * the catalog (written for GitHub). Each is worded for the row's account when it is shown.
   */
  progress: Wording;
  error: { code: string; message: Wording } | null;
  /**
   * Every write the action will make, declared before the first was sent (see `intent.ts`).
   * Absent for rows from before intents, and until the first write is declared.
   */
  intent?: Intent;
  /**
   * `local`: the receipt of a write made locally that answered an outbox ID, such as discarding a
   * draft with nothing on the forge. Kept only so a retry of that ID answers as the first time;
   * Activity never shows one. Absent for forge operations, rows from before receipts included.
   */
  kind?: 'local';
  requestKey: string;
  attempts: number;
  steps: MutationStep[];
  pendingReviewBackup?: ReviewReceipt;
  /** Keep approval resolutions in the same order when replaying completed mutation steps. */
  approvalThreadIds?: string[];
  /**
   * How the action's writes are split into steps. 2: an automatic approval and its summary are
   * separate steps where the forge's approval carries no text (GitLab). Absent for rows from
   * before plans were versioned, which sent both in one `approveReview` step.
   */
  plan?: 2;
  /**
   * Plan 2: the forge's id for the approval this post gave (GitLab: its note), recorded when its
   * summary is first checked. The summary goes only with that approval, never a replacement.
   */
  approvalId?: string;
}
