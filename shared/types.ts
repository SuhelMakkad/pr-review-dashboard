export type CiState = 'success' | 'failure' | 'pending' | 'none';
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
export type Source = 'requested' | 'assigned' | 'reviewed';
export type AttentionKind = 'first_review' | 'changed' | 'requested_again' | 'reply' | 'dismissed';
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
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ThreadComment[];
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
  files: { path: string; additions: number; deletions: number }[];
  checks: Check[];
  ci: CiState;
  fetchedAt: string;
}

export interface LocalTriageState {
  note: string;
  seenReplyKeys: string[];
  snoozedUntil: string | null;
  snoozedActivityKeys: string[];
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
}
