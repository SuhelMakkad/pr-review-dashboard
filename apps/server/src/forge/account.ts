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
