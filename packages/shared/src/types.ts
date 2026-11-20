import type { Forge } from '@/accounts.js';

export type CiState = 'success' | 'failure' | 'pending' | 'none';
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
/** Why a PR is tracked: one of the GitHub search feeds, or `manual` when you added it yourself. */
export type Source = 'requested' | 'assigned' | 'reviewed' | 'authored' | 'mentioned' | 'manual';

/** Sources found by searching GitHub. `manual` is never searched for. */
export type FeedSource = Exclude<Source, 'manual'>;

export const FEED_SOURCES: FeedSource[] = [
  'requested',
  'assigned',
  'reviewed',
  'authored',
  'mentioned',
];

/** Sources that put a PR in the reviewer inbox (authored PRs live in the author view). */
export const REVIEW_SOURCES: Source[] = [
  'requested',
  'assigned',
  'reviewed',
  'mentioned',
  'manual',
];
export type AttentionKind =
  'first_review' | 'changed' | 'requested_again' | 'reply' | 'dismissed' | 'mention';
export type Queue = 'attention' | 'waiting' | 'caught_up' | 'snoozed' | 'all';

export interface Actor {
  login: string;
  avatarUrl?: string;
  /**
   * The account's own profile page, set for the signed-in GitLab account. Its parent is the
   * instance's web address, relative URL root included (`https://example.com/gitlab`).
   */
  webUrl?: string;
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
  /** The forge's id for the review or note that gave it, where it has one. */
  id?: string;
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
  /**
   * Identifies the diff of the file that `viewerViewedState` is about, where the forge's viewed
   * state follows the diff itself (GitLab: a fingerprint of it); absent where it does not.
   */
  viewedKey?: string;
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
  /**
   * The commit the target branch pointed to when this snapshot was read, in the same read as the
   * rest of it (last, where a read takes several requests). Null when there is no such branch;
   * absent where it was not or could not be read.
   */
  baseTipOid?: string | null;
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

/** What the current account's forge supports, where GitHub and GitLab differ. */
export interface ForgeCapabilities {
  /** Submitting a review that requests changes (GitHub; GitLab 19.2 and later). */
  requestChanges: boolean;
}

export interface SyncStatus {
  account: Actor | null;
  /** Absent until the first sync, and for GitHub: everything is supported. */
  capabilities?: ForgeCapabilities;
  teams: string[];
  syncing: boolean;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessfulSync: string | null;
  nextSyncAt: string | null;
  retryAt: string | null;
  error: string | null;
  warnings: string[];
  /**
   * Set on every status the server sends, never stored: the server process that sent it, and how
   * many status changes it had made by then. Of two statuses from one process, the higher
   * revision is the newer, whichever arrived last.
   */
  bootId?: string;
  revision?: number;
}

/**
 * An account signed in to the GitHub CLI or the GitLab CLI that Review Desk can switch to. `login`
 * is the account key: a GitHub login, or `username@host` for GitLab (see `accounts.ts`).
 */
export interface GitHubAccount {
  login: string;
  forge: Forge;
  /** `github.com`, or the GitLab host the account belongs to. */
  host: string;
  /** The account Review Desk works as now. */
  current: boolean;
  /**
   * The CLI's own account for that host, which `gh` or `glab` uses in a terminal. The GitLab CLI
   * keeps one account per host, so every GitLab account is its host's CLI account.
   */
  cliActive: boolean;
  /** False when the CLI could not verify this sign-in. */
  ok: boolean;
  /** GitHub actions queued as this account that are still being sent. */
  inProgress: number;
}

export interface GitHubAccountList {
  /** False when this server cannot change accounts; `accounts` is then empty. */
  switchable: boolean;
  accounts: GitHubAccount[];
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
