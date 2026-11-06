import type { Actor, PullRequestSnapshot, Source } from '@review-desk/shared/types';
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

export interface RemoteFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  sha: string | null;
}

export interface CompareResult {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  mergeBaseOid: string | null;
  files: RemoteFile[];
  commits: { oid: string; parents: string[] }[];
}

export interface BlobText {
  text: string | null;
  isBinary: boolean;
  isTruncated: boolean;
  byteSize: number;
}

/**
 * Domain-level GitHub access. The real client (`GitHub`) implements it over the gh CLI; demo mode
 * implements it from an in-memory scenario so the UI and services run without GitHub.
 */
export interface GitHubApi extends GitHubWrites {
  identity(): Promise<Actor>;
  teams(): Promise<string[]>;
  discover(login: string, source: Source): Promise<string[]>;
  detect(ids: string[]): Promise<{ results: DetectResult[]; budget: RateBudget | null }>;
  snapshot(
    id: string,
    login: string,
    sources: Source[],
    previous?: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot>;
  /** Files changed by the PR (base...head) with their patches. */
  pullFiles(repository: string, number: number): Promise<RemoteFile[]>;
  /** Three-dot comparison; null when either commit is unknown to GitHub. */
  compare(repository: string, base: string, head: string): Promise<CompareResult | null>;
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
