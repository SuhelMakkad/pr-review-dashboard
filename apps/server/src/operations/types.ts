import type { GitHubOperation } from '@review-desk/shared/operations';
import type { ReviewReceipt } from '@/github/api.js';

export interface MutationStep {
  method: string;
  args: unknown[];
  startedAt: string;
  completedAt: string | null;
  result: unknown;
  uncertain: boolean;
}

export interface OperationRecord extends Omit<GitHubOperation, 'controls'> {
  requestKey: string;
  attempts: number;
  steps: MutationStep[];
  pendingReviewBackup?: ReviewReceipt;
  /** Keep approval resolutions in the same order when replaying completed mutation steps. */
  approvalThreadIds?: string[];
}
