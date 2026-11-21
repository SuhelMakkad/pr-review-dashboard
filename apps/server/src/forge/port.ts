import type { ReviewEvent } from '@review-desk/shared/review';
import type { ForgeTraits } from '@review-desk/shared/traits';
import type {
  Actor,
  FeedSource,
  ForgeCapabilities,
  PullRequestSnapshot,
  Source,
} from '@review-desk/shared/types';
import type {
  BlobText,
  CompareResult,
  DetectOptions,
  DetectResult,
  PinnedFiles,
  RateBudget,
  RemoteFile,
  ResolvedPull,
  ReviewReceipt,
} from '@/github/api.js';
import type { ThreadInput, ViewedRevision } from '@/github/write.js';

/**
 * The forge port: what the app asks of GitHub and GitLab alike, under neutral names. The GitHub
 * modules re-export these as `GitHubApi`, `GitHubWrites` and `GitHubError`, so callers move over
 * one at a time.
 */

/** A forge's failure: a rate limit with when to retry, a rejection, or the forge unavailable. */
export class ForgeError extends Error {
  constructor(
    message: string,
    readonly retryAt: string | null = null,
    readonly status: number | null = null,
    readonly outcome: 'unknown' | 'rejected' | 'unavailable' | 'rate_limit' | 'auth' = 'unknown',
  ) {
    super(message);
  }
}

/**
 * One history search, for one inclusive window of days (`YYYY-MM-DD`): the PRs `login` reviewed,
 * by when they were last updated, or those it authored, by when they were created. With
 * `repositories`, only PRs in those (GitHub `owner/repo`, GitLab `group/project`); otherwise any.
 */
export type HistoryQuery =
  | { kind: 'reviewed'; login: string; from: string; to: string; repositories?: string[] }
  | { kind: 'authored'; login: string; from: string; to: string; repositories?: string[] };

/** The forge's writes used by the review workspace and enabled automations. */
export interface ForgeWrites {
  approveReview(
    prId: string,
    commitOid: string,
    body: string,
  ): Promise<{ id: string; url: string }>;
  addPendingReview(prId: string, commitOid: string): Promise<string>;
  addReviewThread(reviewId: string, thread: ThreadInput): Promise<string>;
  submitReview(
    reviewId: string,
    event: ReviewEvent,
    body: string,
  ): Promise<{ id: string; url: string }>;
  deleteReview(reviewId: string): Promise<void>;
  commentNow(
    prId: string,
    commitOid: string,
    thread: ThreadInput,
  ): Promise<{ id: string; url: string }>;
  replyToThread(
    threadId: string,
    body: string,
  ): Promise<{ id: string; url: string; pending: boolean }>;
  setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
  /**
   * `expected`: the file's diff the mark is for (its `viewedKey`). A forge that can check it
   * refuses the mark when the file's diff is another one now (GitLab); GitHub cannot, and ignores
   * it.
   */
  setFileViewed(
    prId: string,
    path: string,
    viewed: boolean,
    expected?: { fileKey: string },
  ): Promise<ViewedRevision | null>;
  addConversationComment(prId: string, body: string): Promise<{ id: string; url: string }>;
  /** Adds (never removes) requested reviewers; re-requesting someone asks them again. */
  requestReviews(prId: string, logins: string[]): Promise<void>;
}

/**
 * Domain-level forge access, whichever forge it is. `GitHub` implements it over the gh CLI and
 * `GitLab` over glab; demo mode implements it from an in-memory scenario.
 */
export interface ForgePort extends ForgeWrites {
  /**
   * This forge with every call made as `login`, for as long as the work that holds it runs,
   * whatever is selected meanwhile. Absent where a forge cannot tell accounts apart (a test's
   * stand-in): it is then its own binding (see `bindForge`).
   */
  as?(login: string): ForgePort;

  /**
   * With no account selected: whose the credentials in use right now are, with this forge bound to
   * them for the rest of the work, so it stays that account's even if the CLI switches meanwhile.
   */
  discoverIdentity?(): Promise<{ identity: Actor; forge: ForgePort }>;

  /**
   * Refuses (`AccountUnavailable`) when the forge is signed in as someone other than `account`.
   * GitLab only: each GitHub call carries the named account's own token, so it needs no check.
   */
  verifyAccount?(account: string): Promise<void>;

  /** What this forge is like (see `ForgeTraits`); a demo or test forge can declare its own. */
  readonly traits: ForgeTraits;
  reviewReceipt(id: string): Promise<ReviewReceipt | null>;
  identity(): Promise<Actor>;
  /** Where the forge differs from GitHub; absent means everything is supported. */
  capabilities?(): Promise<ForgeCapabilities>;
  teams(): Promise<string[]>;
  discover(login: string, source: FeedSource): Promise<string[]>;
  /** Finds a PR by repository and number; null when it does not exist or cannot be seen. */
  resolvePull(repository: string, number: number): Promise<ResolvedPull | null>;
  detect(
    ids: string[],
    options?: DetectOptions,
  ): Promise<{ results: DetectResult[]; budget: RateBudget | null }>;
  snapshot(
    id: string,
    login: string,
    sources: Source[],
    previous?: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot>;
  /** Files changed by the PR (base...head) with their patches. */
  pullFiles(repository: string, number: number): Promise<RemoteFile[]>;
  /**
   * Where the forge's viewed state follows each file's diff (GitLab): the files of exactly this
   * revision, keyed for viewed marks (see `PinnedFiles`). Null, or absent, where viewed state is
   * per file whatever its diff (GitHub).
   */
  pinnedFiles?(
    repository: string,
    number: number,
    revision: { headOid: string; baseOid: string | null },
  ): Promise<PinnedFiles | null>;
  /** Three-dot comparison; null when either commit is unknown to GitHub. */
  compare(repository: string, base: string, head: string): Promise<CompareResult | null>;
  /** The commit `branch` points to now; null when there is no such branch. */
  branchHead(repository: string, branch: string): Promise<string | null>;
  /**
   * The comment `author` left in the conversation of PR `prId` that starts with `marker`, read
   * through every page (a snapshot keeps only the latest ones). The PR is named by its id, which
   * a renamed or moved repository keeps. Null when there is none; throws when not every page
   * could be read, so absence is never assumed.
   */
  markedComment(
    prId: string,
    author: string,
    marker: string,
  ): Promise<{ id: string; url: string } | null>;
  /** The ids of the PRs `query` finds, open or closed; used to backfill history. */
  searchPullIds(query: HistoryQuery): Promise<string[]>;
  /** Light snapshots (requests, your reviews, verdicts) for many PRs, for review history. */
  history(ids: string[], login: string): Promise<PullRequestSnapshot[]>;
  /** File contents at commits; null entries for paths that do not exist there. */
  blobs(
    repository: string,
    requests: { oid: string; path: string }[],
  ): Promise<(BlobText | null)[]>;
}
