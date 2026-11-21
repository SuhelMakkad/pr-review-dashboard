import type { FastifyInstance, FastifyReply } from 'fastify';
import { routes } from '@review-desk/shared/contract';
import { say } from '@/messages.js';
import { failed, ok, serve, type Failed } from '@/http/serve.js';
import { AccountUnavailable } from '@/forge/account.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { ReviewError } from '@/review/errors.js';
import type { SyncService } from '@/sync/service.js';

/** `:account` in a scoped path: an account key, GitHub `login` or GitLab `user@host`. */
export interface AccountParams {
  account: string;
}

/**
 * The account a scoped route serves, or null with a 404 sent when this app has never worked as it.
 * Exported for the other scoped routes (diff, tickets).
 */
export function knownAccount(
  service: SyncService,
  params: AccountParams,
  reply: FastifyReply,
): string | null {
  const account = params.account;

  if (account.length > 0 && account.length <= 200 && service.knows(account)) return account;

  reply
    .code(404)
    .send({ error: 'Review Desk has not used this account.', code: 'UNKNOWN_ACCOUNT' });

  return null;
}

/** What a failed live read answers: the account unavailable, rate limited, or the forge. */
export function readFailure(error: unknown): Failed {
  if (error instanceof AccountUnavailable)
    return failed(409, { error: error.message, code: error.code });

  if (error instanceof ReviewError)
    return failed(error.status, { error: error.wording, code: error.code });

  if (error instanceof GitHubError && error.outcome === 'rate_limit')
    return failed(429, { error: safeError(error), code: 'RATE_LIMITED', retryAt: error.retryAt });

  return failed(502, { error: safeError(error) });
}

/** What a failed queue change answers; anything else is not its to answer. */
function queueFailure(error: unknown): Failed {
  if (error instanceof AccountUnavailable)
    return failed(409, { error: error.message, code: error.code });

  if (error instanceof ReviewError)
    return failed(error.status, { error: error.wording, code: error.code });

  if (error instanceof GitHubError && error.outcome === 'rate_limit')
    return failed(429, { error: safeError(error), code: 'RATE_LIMITED', retryAt: error.retryAt });

  if (error instanceof GitHubError)
    return failed(502, { error: safeError(error), code: 'GITHUB_ERROR' });

  throw error;
}

export function registerPullRoutes(app: FastifyInstance, service: SyncService): void {
  // Each serves exactly the account in its path, whichever account is selected, so a request
  // finishes for the account it was made for even if another window switches meanwhile.
  const serving = { sync: service };

  serve(app, routes.pulls, ({ account }) => ok(200, service.listFor(account)), serving);
  serve(app, routes.mine, ({ account }) => ok(200, service.mineFor(account)), serving);

  serve(
    app,
    routes.detail,
    ({ account, params }) => {
      const detail = service.detailFor(account, params.id);

      return detail ? ok(200, detail) : failed(404, { error: say('pull.untracked-for-account') });
    },
    serving,
  );

  serve(
    app,
    routes.refresh,
    async ({ account, params }) => {
      const detail = await service.refresh(params.id, account);

      return detail ? ok(200, detail) : failed(404, { error: say('pull.not-found') });
    },
    { ...serving, errors: readFailure },
  );

  serve(
    app,
    routes.triage,
    ({ account, params, body }) => {
      if (body.snoozeUntil && Date.parse(body.snoozeUntil) <= service.clock.now())
        return failed(400, { error: 'Choose a snooze time in the future.' });

      const detail = service.updateFor(account, params.id, body);

      return detail ? ok(200, detail) : failed(404, { error: say('pull.not-found') });
    },
    serving,
  );

  serve(
    app,
    routes.track,
    async ({ account, body }) =>
      ok(200, await service.track(account, body.repository, body.number, body.host, body.gitlab)),
    { ...serving, errors: queueFailure },
  );

  serve(
    app,
    routes.untrack,
    ({ account, params, body }) => ok(200, service.untrack(account, params.id, body.membershipId)),
    { ...serving, errors: queueFailure },
  );

  // Not any one account's: the selected account's sync, and the status every window shows.
  serve(app, routes.status, () => ok(200, service.sentStatus), serving);

  serve(
    app,
    routes.sync,
    () => {
      void service.sync();

      return ok(202, service.sentStatus);
    },
    serving,
  );
}
