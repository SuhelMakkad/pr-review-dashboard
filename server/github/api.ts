import type { Actor, PullRequestSnapshot, Source } from '../../shared/types.js';

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

/**
 * Domain-level GitHub access. The real client (`GitHub`) implements it over the gh CLI; demo mode
 * implements it from an in-memory scenario so the UI and services run without GitHub.
 */
export interface GitHubApi {
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
}
