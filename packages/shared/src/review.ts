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

/**
 * A PR's draft versions. `revision` rises with every change to the draft and `generation` with
 * every clear, lock and unlock; `observation` rises with every snapshot of the PR, ordering
 * `githubPendingReview`. A draft write can name the revision and generation it saw, and is
 * refused (`DRAFT_REVISION_CONFLICT`) when the draft has moved on.
 */
export interface DraftVersions {
  revision: number;
  generation: number;
  observation: number;
}

/** A guarded draft write's outcome, as its answer and the attempt lookup carry it. */
export interface DraftAttempt {
  id: string;
  state: 'pending' | 'committed' | 'refused';
}

export interface ReviewDraft {
  prId: string;
  /** The draft's versions when it was read. Absent from answers of older servers. */
  versions?: DraftVersions;
  body: string;
  event: ReviewEvent;
  comments: DraftComment[];
  updatedAt: string | null;
  preparedReview?: {
    runId: string;
    preparedAt: string;
    indices: number[];
    /** Only content created by this preparation may be replaced by another preparation. */
    content?: { summary: string; comments: { id: string; fingerprint: string }[] };
    previousDrafts?: { body: string; comments: DraftComment[]; savedAt: string }[];
  } | null;
  /** A pending review that already exists on GitHub (started there or by an interrupted submit). */
  githubPendingReview: { id: string; commentCount: number } | null;
  activeOperationId?: string | null;
}

export interface PrepareReviewOptions {
  replace?: boolean;
  /** Confirmation applies only to the exact draft the user was shown. */
  expectedDraftRevision?: string;
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
  /** The PR revision of the diff the line was picked in; refused when the PR is another now. */
  revision?: { headOid: string; baseOid: string | null };
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
