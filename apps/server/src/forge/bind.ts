import type { Actor } from '@review-desk/shared/types';
import type { GitHubApi } from '@/github/api.js';

/** `api` with every call made as `login` (see `GitHubApi.as`); a stand-in is its own binding. */
export function bindForge(api: GitHubApi, login: string): GitHubApi {
  return api.as?.(login) ?? api;
}

/** With no account selected: whose the credentials in use are, and `api` bound to them. */
export async function discoverIdentity(
  api: GitHubApi,
): Promise<{ identity: Actor; forge: GitHubApi }> {
  if (api.discoverIdentity) return api.discoverIdentity();

  return { identity: await api.identity(), forge: api };
}
