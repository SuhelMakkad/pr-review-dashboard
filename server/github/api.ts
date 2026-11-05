import type { Actor, PullRequestSnapshot, Source } from '../../shared/types.js';

/**
 * Domain-level GitHub access. The real client (`GitHub`) implements it over the gh CLI; demo mode
 * implements it from an in-memory scenario so the UI and services run without GitHub.
 */
export interface GitHubApi {
  identity(): Promise<Actor>;
  teams(): Promise<string[]>;
  discover(login: string, source: Source): Promise<string[]>;
  snapshot(
    id: string,
    login: string,
    sources: Source[],
    previous?: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot>;
}
