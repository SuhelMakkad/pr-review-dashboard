import type { Side } from '@review-desk/shared/review';
import type { Forge } from '@review-desk/shared/accounts';
import type { PullRequestSnapshot } from '@review-desk/shared/types';

/**
 * The values the forge port takes and answers, the same for every forge. The GitHub modules
 * re-export them under their original paths.
 */

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

export interface ThreadInput {
  path: string;
  body: string;
  line?: number | null;
  side?: Side;
  startLine?: number | null;
  startSide?: Side | null;
  subjectType?: 'LINE' | 'FILE';
}

/**
 * The PR revision whose diff of a file a viewed write marked: its head and base commits, as a
 * snapshot records them. Null when the forge cannot say, or for an unmark, which holds for every
 * revision.
 */
export interface ViewedRevision {
  headOid: string;
  baseOid: string | null;
  /**
   * The `viewedKey` of the file's diff that was marked, where the forge knows it (GitLab). It
   * decides on its own: a snapshot's head and base and its files are not always read together.
   */
  fileKey?: string;
}

/**
 * An account signed in to the GitHub CLI (github.com) or the GitLab CLI (any GitLab host). `login`
 * is the account key: the GitHub login, or `username@host` for GitLab.
 */
export interface CliAccount {
  login: string;
  forge: Forge;
  host: string;
  /** The CLI's own account for that host, which `gh` or `glab` uses in a terminal. */
  cliActive: boolean;
  /** False when the CLI could not verify this sign-in. */
  ok: boolean;
}
