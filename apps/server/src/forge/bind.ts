import { forgeTraits, type ForgeTraits } from '@review-desk/shared/traits';
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

/** The forge's traits; a test's stand-in that declares none is taken as GitHub. */
export function declaredTraits(api: GitHubApi): ForgeTraits {
  return api.traits ?? forgeTraits.github;
}

/**
 * The forge's account check, where its traits call for one (`checksAccount`: glab signs each
 * request in for itself); null where each call carries its own account (GitHub).
 */
export function accountCheck(api: GitHubApi): ((account: string) => Promise<void>) | null {
  return declaredTraits(api).checksAccount && api.verifyAccount
    ? api.verifyAccount.bind(api)
    : null;
}
