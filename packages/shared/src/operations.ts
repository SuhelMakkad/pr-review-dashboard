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
  | {
      type: 'viewed';
      path: string;
      viewed: boolean;
      /**
       * The diff you marked, as the page showed it (else the PR as the server had it). It is not
       * marked once the PR shows another diff. Absent in actions saved before it existed.
       */
      target?: ViewedTarget;
    }
  | { type: 'reviewers'; logins: string[] }
  | { type: 'discard'; reviewId: string; restoreOperationId?: string }
  /** A finished full review, posted automatically because Settings asked for it. */
  | {
      type: 'ai_review';
      runId: string;
      expectedHeadOid: string;
      body: string;
      /** Older queued operations without an event post a conversation comment. */
      event?: 'APPROVE' | 'COMMENT';
      /**
       * What the post rests on, checked again before every send. Posts queued before Review Desk
       * checked a review's inputs have none, and wait for you before any approval.
       */
      basis?: AiPostBasis;
    };

/** The reviewed diff, discussion and permissions an automatic AI review post was decided on. */
export interface AiPostBasis {
  /** The reviewed diff is `mergeBaseOid..expectedHeadOid`, for a PR targeting `baseRefName`. */
  baseRefName: string;
  mergeBaseOid: string;
  /** `publicationFingerprint` of the PR the review read. */
  fingerprint: string;
  /**
   * The same without your reviews, which an approval changes: what the summary sent after its
   * approval (where the two are separate writes) is checked against. Absent on posts queued
   * before it existed, whose summary then waits for you.
   */
  summaryFingerprint?: string;
  /** The open threads the review read, resolved before approving; never any others. */
  threadIds: string[];
  /** What Settings allowed when the review finished. Settings must still allow it when sent. */
  grants: { approve: boolean; resolve: boolean };
}

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
  /**
   * Something may already be on the forge: stopping or reopening needs your confirmation, after
   * you have checked.
   */
  confirmStop?: boolean;
  savedPendingReview?: {
    body: string;
    comments: { id: string; body: string; path: string; line: number | null; url: string }[];
  };
}

export interface OperationReceipt {
  operation: GitHubOperation;
}

/** What the receipt route answers for an id an action was received under. */
export interface CommandReceipt {
  kind: 'local' | 'forge';
  /** The PR and action it was received for: a receipt settles only an attempt that names both. */
  prId: string;
  type: GitHubAction['type'];
  status: OperationStatus;
  /** For a finished operation, the draft versions its last write to the draft left. */
  draft?: { revision: number; generation: number };
}

/**
 * A submit or discard id you stopped waiting for, with the decision made then: not admitted, as
 * complete receipt history showed; or unknown, history having been lost. Either way, never after.
 */
export interface AbandonedReceipt {
  kind: 'abandoned';
  prId: string;
  type: 'review' | 'discard';
  decision: 'not-admitted' | 'unknown';
}

/** What stopping a command answers: admitted already, with its receipt, or its decision. */
export type AbandonOutcome =
  { outcome: 'admitted'; receipt: CommandReceipt } | { outcome: AbandonedReceipt['decision'] };

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

/** A diff of one file, as a viewed mark names it: the PR's head and base, and the file's own key. */
export interface ViewedTarget {
  headOid: string;
  baseOid: string | null;
  /** The file's `viewedKey`, where the forge identifies each file's diff (GitLab). */
  fileKey?: string;
}

/**
 * True when a view of the PR at `revision`, whose file has `fileKey`, shows the diff `target`
 * names: by the file's own key where either side has one, else by the same head and base.
 */
export function showsViewedTarget(
  target: ViewedTarget,
  revision: { headOid: string; baseOid: string | null },
  fileKey: string | undefined,
): boolean {
  if (target.fileKey !== undefined || fileKey !== undefined)
    return target.fileKey !== undefined && target.fileKey === fileKey;

  return target.headOid === revision.headOid && target.baseOid === revision.baseOid;
}
