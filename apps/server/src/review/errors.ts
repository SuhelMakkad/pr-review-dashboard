import { render, type Wording } from '@/messages.js';

/** A refusal: its code and status, and what it says, worded for the account it is shown to. */
export class ReviewError extends Error {
  /** What the refusal says; `message` holds it in GitHub's words, for logs. */
  readonly wording: Wording;

  constructor(
    readonly code: string,
    readonly status: number,
    message: Wording,
    readonly details: Record<string, unknown> = {},
  ) {
    super(render(message, null));
    this.wording = message;
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
