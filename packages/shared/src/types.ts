export type CiState = 'success' | 'failure' | 'pending' | 'none';
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
export type Source = 'requested' | 'assigned' | 'reviewed' | 'authored' | 'mentioned';

/** Feeds that put a PR in the reviewer inbox (authored PRs live in the author view). */
export const REVIEW_SOURCES: Source[] = ['requested', 'assigned', 'reviewed', 'mentioned'];
export type AttentionKind =
  'first_review' | 'changed' | 'requested_again' | 'reply' | 'dismissed' | 'mention';
export type Queue = 'attention' | 'waiting' | 'caught_up' | 'snoozed' | 'all';

export interface Actor {
  login: string;
  avatarUrl?: string;
}

export interface Review {
  id: string;
  state: ReviewState;
  submittedAt: string;
  updatedAt: string;
  commitOid: string | null;
  body: string;
  url: string;
}

export interface Reviewer {
  kind: 'user' | 'team';
  login: string;
  name: string;
}

export interface RequestEvent {
  id: string;
  createdAt: string;
  removed: boolean;
  reviewer: Reviewer | null;
}

export interface ThreadComment {
  id: string;
  author: Actor;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  replyToId: string | null;
  diffHunk?: string;
  commitOid?: string | null;
  originalCommitOid?: string | null;
}

export type DiffSide = 'LEFT' | 'RIGHT';

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ThreadComment[];
  diffSide?: DiffSide;
  startLine?: number | null;
  originalLine?: number | null;
  subjectType?: 'LINE' | 'FILE';
  viewerCanReply?: boolean;
  viewerCanResolve?: boolean;
}

/** A top-level PR conversation comment (not attached to code). */
export interface ConversationComment {
  id: string;
  author: Actor;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface ForcePush {
  id: string;
  createdAt: string;
  beforeOid: string | null;
  afterOid: string | null;
  actor: string | null;
}

/** Latest approve / request-changes per reviewer (any reviewer, not only the viewer). */
export interface ReviewerVerdict {
  login: string;
  state: ReviewState;
  submittedAt: string;
  commitOid: string | null;
}

export interface PullFile {
  path: string;
  additions: number;
  deletions: number;
  changeType?: string;
  viewerViewedState?: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
}

export interface Check {
  name: string;
  state: CiState;
  url: string | null;
}

export interface PullRequestSnapshot {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  repository: string;
  author: Actor;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  updatedAt: string;
  headOid: string;
  headCommittedAt: string;
  headObservedAt: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  mergeable: string;
  sources: Source[];
  reviewRequests: Reviewer[];
  requestEvents: RequestEvent[];
  reviews: Review[];
  threads: ReviewThread[];
  files: PullFile[];
  checks: Check[];
  ci: CiState;
  fetchedAt: string;
  /** Snapshot format version; absent on v1 blobs. */
  version?: number;
  /** Fields below arrived with snapshot v2; older cached blobs are normalised on read. */
  baseOid: string | null;
  mergeStateStatus: string | null;
  conversation: ConversationComment[];
  forcePushes: ForcePush[];
  verdicts: ReviewerVerdict[];
  /** The viewer's own pending (unsubmitted) review on GitHub, if any. */
  pendingReview: { id: string; createdAt: string; commentCount: number } | null;
}

export interface LocalTriageState {
  note: string;
  seenReplyKeys: string[];
  snoozedUntil: string | null;
  snoozedActivityKeys: string[];
  /** Set by "done until new activity"; cleared automatically when a new activity key appears. */
  doneAt: string | null;
  doneActivityKeys: string[];
}

export interface AttentionReason {
  kind: AttentionKind;
  label: string;
  at: string;
  key: string;
  url?: string;
}

export interface PullRequestItem {
  id: string;
  number: number;
  title: string;
  url: string;
  repository: string;
  author: Actor;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  fetchedAt: string;
  ci: CiState;
  sources: Source[];
  requestedVia: string[];
  latestReview: Review | null;
  unresolvedThreads: number;
  reasons: AttentionReason[];
  queue: Exclude<Queue, 'all'>;
  attentionAt: string;
  activityKeys: string[];
  unreadReplyKeys: string[];
  hasNote: boolean;
  snoozedUntil: string | null;
  /** When the PR was marked done; null when it is not (or no longer) done. */
  doneAt: string | null;
  createdAt: string;
  headRefName: string;
  /** Ticket identifiers found in the branch, title or description (e.g. Linear issues). */
  tickets: string[];
}

export interface SyncStatus {
  account: Actor | null;
  teams: string[];
  syncing: boolean;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulSync: string | null;
  nextSyncAt: string | null;
  retryAt: string | null;
  error: string | null;
  warnings: string[];
}

export interface PullRequestList {
  account: string | null;
  items: PullRequestItem[];
}

export interface PullRequestDetail {
  account: string;
  snapshot: PullRequestSnapshot;
  item: PullRequestItem;
  triage: LocalTriageState;
}

export interface TriageUpdate {
  account: string;
  note?: string;
  seenReplyKeys?: string[];
  snoozeUntil?: string | null;
  done?: boolean;
}
