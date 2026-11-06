/** Review drafting and submission contract between the workspace and the server. */

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export type Side = 'LEFT' | 'RIGHT';

export interface DraftComment {
  id: string;
  path: string;
  /** Null for a comment on the whole file. */
  line: number | null;
  side: Side;
  startLine: number | null;
  startSide: Side | null;
  subjectType: 'LINE' | 'FILE';
  body: string;
  origin: 'user' | 'ai';
  /** Head commit the line numbers refer to. */
  anchorOid: string;
  /** `pushed`: already added to the GitHub pending review during an interrupted submit. */
  status: 'draft' | 'pushed' | 'stale';
  createdAt: string;
  updatedAt: string;
  githubThreadId?: string | null;
}

export interface ReviewDraft {
  prId: string;
  body: string;
  event: ReviewEvent;
  comments: DraftComment[];
  updatedAt: string | null;
  preparedReview?: { runId: string; preparedAt: string; indices: number[] } | null;
  /** A pending review that already exists on GitHub (started there or by an interrupted submit). */
  githubPendingReview: { id: string; commentCount: number } | null;
  activeOperationId?: string | null;
}

export interface NewDraftComment {
  account: string;
  path: string;
  line: number | null;
  side?: Side;
  startLine?: number | null;
  startSide?: Side | null;
  body: string;
  origin?: 'user' | 'ai';
}

export interface SubmitReviewRequest {
  account: string;
  event: ReviewEvent;
  body: string;
  /** The head the reviewer looked at; a moved head needs explicit confirmation. */
  expectedHeadOid: string;
  allowNewHead?: boolean;
}

export interface SubmitReviewResult {
  reviewUrl: string;
  submittedComments: number;
}

export const reviewEventLabels: Record<ReviewEvent, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
};
