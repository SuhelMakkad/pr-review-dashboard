export class ReviewError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A write for an account other than the one in use: it is never made, and nothing is queued. */
export function accountNotActive(account: string, selected: string | null): ReviewError {
  return new ReviewError(
    'ACCOUNT_NOT_ACTIVE',
    409,
    selected
      ? `You're using ${selected} now. Switch back to ${account} to do this.`
      : `Switch back to ${account} to do this.`,
    { account, selected },
  );
}

/**
 * The legacy routes' and AI's answer for the same refusal, kept until they move to account paths:
 * `ACCOUNT_CHANGED`, with its old wording.
 */
export function legacyAccountError(error: unknown): unknown {
  return error instanceof ReviewError && error.code === 'ACCOUNT_NOT_ACTIVE'
    ? new ReviewError('ACCOUNT_CHANGED', 409, 'GitHub account changed. Refresh before writing.')
    : error;
}
