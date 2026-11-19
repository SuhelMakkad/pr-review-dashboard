import type { GitHubOperation } from '@review-desk/shared/operations';
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

export interface OperationRecord extends Omit<GitHubOperation, 'controls'> {
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
}
