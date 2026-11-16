import type { DraftComment, NewDraftComment, ReviewEvent, SubmitReviewRequest } from './review.js';

export type OperationStatus =
  'queued' | 'running' | 'waiting' | 'checking' | 'needs_attention' | 'succeeded' | 'cancelled';

export interface FrozenReview {
  body: string;
  event: ReviewEvent;
  comments: DraftComment[];
  githubReviewId: string | null;
}

export type GitHubAction =
  | { type: 'review'; review: SubmitReviewRequest; draft: FrozenReview }
  | { type: 'comment'; comment: NewDraftComment; expectedHeadOid: string }
  | { type: 'reply'; threadId: string; body: string }
  | { type: 'resolve'; threadId: string; resolved: boolean }
  | { type: 'viewed'; path: string; viewed: boolean }
  | { type: 'reviewers'; logins: string[] }
  | { type: 'discard'; reviewId: string; restoreOperationId?: string }
  /** A finished full review, posted as a conversation comment because Settings asked for it. */
  | { type: 'ai_review'; runId: string; expectedHeadOid: string; body: string };

export type OperationControl = 'cancel' | 'retry' | 'check' | 'reopen' | 'dismiss' | 'restore';

export interface GitHubOperation {
  id: string;
  account: string;
  prId: string;
  repository: string;
  number: number;
  title: string;
  prUrl: string;
  action: GitHubAction;
  status: OperationStatus;
  progress: string;
  error: { code: string; message: string } | null;
  result: { url?: string; pending?: boolean; submittedComments?: number } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  retryAt: string | null;
  dismissedAt: string | null;
  controls: OperationControl[];
  savedPendingReview?: {
    body: string;
    comments: { id: string; body: string; path: string; line: number | null; url: string }[];
  };
}

export interface OperationReceipt {
  operation: GitHubOperation;
}

export interface OperationList {
  items: GitHubOperation[];
  nextCursor: string | null;
}

export const operationLabels: Record<GitHubAction['type'], string> = {
  review: 'Submit review',
  comment: 'Post comment',
  reply: 'Reply to thread',
  resolve: 'Update thread resolution',
  viewed: 'Update file viewed state',
  reviewers: 'Request reviewers',
  discard: 'Discard pending review',
  ai_review: 'Post AI review',
};

export const operationInProgress = (status: OperationStatus) =>
  ['queued', 'running', 'waiting', 'checking'].includes(status);

export const operationUnsettled = (status: OperationStatus) =>
  operationInProgress(status) || status === 'needs_attention';
