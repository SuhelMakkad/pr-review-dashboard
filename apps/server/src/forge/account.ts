import { GitHubError } from '@/github/errors.js';

/**
 * A forge CLI is signed in as someone other than the account a read was for. Nothing from that
 * read is kept; routes answer `409 ACCOUNT_UNAVAILABLE`.
 */
export class AccountUnavailable extends Error {
  readonly code = 'ACCOUNT_UNAVAILABLE';

  constructor(
    readonly account: string,
    readonly signedInAs: string | null,
  ) {
    super(
      signedInAs
        ? `The GitLab CLI is signed in as ${signedInAs}, not ${account}. Sign in as ${account} again or switch accounts.`
        : `${account} is not available: sign in to it again or switch accounts.`,
    );
  }
}

/**
 * A rate limit that cannot be tied to the account it was met for (glab may have been signed in as
 * someone else): passed on as an ordinary failure with no deadline, so no caller saves it as that
 * account's cooldown.
 */
export function unattributed(error: unknown): unknown {
  if (!(error instanceof GitHubError) || error.outcome !== 'rate_limit') return error;

  return new GitHubError(
    `${error.message} Review Desk could not confirm which GitLab account it was for, so it will try again.`,
    null,
    error.status,
    'unknown',
  );
}
