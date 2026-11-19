import type {
  Actor,
  FeedSource,
  ForgeCapabilities,
  PullRequestSnapshot,
  Source,
} from '@review-desk/shared/types';
import type { GitHubWrites } from '@/github/write.js';

export interface RateBudget {
  limit: number;
  remaining: number;
  resetAt: string;
  cost: number;
}

/** Change-detection result; `state` and `fingerprint` are null when the PR is not visible. */
export interface DetectResult {
  id: string;
  state: PullRequestSnapshot['state'] | null;
  fingerprint: string | null;
}

/** What change detection may use from the stored snapshots. */
export interface DetectOptions {
  /**
   * PRs whose stored snapshot has CI still running. A forge whose change detection does not see CI
   * results (GitLab) reads their pipelines too. Taken from saved snapshots, never from reads that
   * might not be saved.
   */
  ciPending?: ReadonlySet<string>;
}

export interface ResolvedPull {
  id: string;
  state: PullRequestSnapshot['state'];
}

export interface RemoteFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  sha: string | null;
  /** The forge left the patch out for its size (GitLab says so; GitHub only omits it). */
  tooLarge?: boolean;
  /**
   * Identifies this very diff for viewed marks, where the forge's viewed state follows the diff
   * (GitLab). Computed from the same record as `patch` (see `pinnedFiles`), so it names the diff
   * that is rendered.
   */
  viewedKey?: string;
}

/** A PR's files as `pinnedFiles` lists them. */
export interface PinnedFiles {
  files: RemoteFile[];
  /**
   * True when the files are exactly the revision asked for, from the forge's immutable record of
   * it, and keyed; false when no such record exists and they come unkeyed from the live diff.
   */
  pinned: boolean;
  /**
   * True when `files` is the revision's whole list, not one the forge cut short for its size, and
   * `mergeBaseOid` is the commit its diffs start from.
   */
  complete?: boolean;
  mergeBaseOid?: string;
}

export interface CompareResult {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  mergeBaseOid: string | null;
  files: RemoteFile[];
  /**
   * True when `files` is every file the commits change; absent where the forge may stop listing
   * them without saying so.
   */
  filesComplete?: boolean;
  /** `committedAt` is the committer date, which a rebase or amend renews. */
  commits: { oid: string; parents: string[]; committedAt: string | null }[];
}

export interface BlobText {
  text: string | null;
  isBinary: boolean;
  isTruncated: boolean;
  byteSize: number;
}

export interface ReviewReceipt {
  id: string;
  state: string;
  url: string;
  body: string;
  commitOid: string | null;
  comments: { id: string; body: string; path: string; line: number | null; url: string }[];
}

/**
 * Domain-level GitHub access. The real client (`GitHub`) implements it over the gh CLI; demo mode
 * implements it from an in-memory scenario so the UI and services run without GitHub.
 */
export interface GitHubApi extends GitHubWrites {
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
  /** PR node ids matching a search (open or closed); used to backfill history. */
  searchPullIds(query: string): Promise<string[]>;
  /** Light snapshots (requests, your reviews, verdicts) for many PRs, for review history. */
  history(ids: string[], login: string): Promise<PullRequestSnapshot[]>;
  /** File contents at commits; null entries for paths that do not exist there. */
  blobs(
    repository: string,
    requests: { oid: string; path: string }[],
  ): Promise<(BlobText | null)[]>;
}
