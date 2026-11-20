import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountUnavailable } from '@/forge/account.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { ReviewError } from '@/review/errors.js';
import type { SyncService } from '@/sync/service.js';

const updateSchema = z
  .object({
    account: z.string().min(1).max(100),
    note: z.string().max(30_000).optional(),
    seenReplyKeys: z.array(z.string().max(250)).max(10_000).optional(),
    snoozeUntil: z.iso.datetime().nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();

/** Undo names the membership its add made; Remove names none, and removes the current one. */
const untrackSchema = z.object({ membershipId: z.uuid().optional() }).strict();

/** Adding by hand for the account the path names. */
const scopedTrackSchema = z
  .object({
    repository: z
      .string()
      .max(400)
      .regex(/^[\w.-]+(?:\/[\w.-]+)+$/),
    number: z.number().int().positive().max(1_000_000_000),
    host: z
      .string()
      .max(255)
      .regex(/^[\w.-]+(?::\d{1,5})?$/)
      .optional(),
    gitlab: z.boolean().optional(),
  })
  .strict();

/** Triage for the account the path names, so the body carries no account of its own. */
const scopedUpdateSchema = updateSchema.omit({ account: true });

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

/** Maps a failed live read to its response: the account unavailable, rate limited, or the forge. */
export function readError(reply: FastifyReply, error: unknown) {
  if (error instanceof AccountUnavailable)
    return reply.code(409).send({ error: error.message, code: error.code });

  if (error instanceof ReviewError)
    return reply.code(error.status).send({ error: error.message, code: error.code });

  if (error instanceof GitHubError && error.outcome === 'rate_limit')
    return reply
      .code(429)
      .send({ error: safeError(error), code: 'RATE_LIMITED', retryAt: error.retryAt });

  return reply.code(502).send({ error: safeError(error) });
}

/** Maps queue-change failures to `{ error, code }` responses. */
function queueError(reply: FastifyReply, error: unknown) {
  if (error instanceof AccountUnavailable)
    return reply.code(409).send({ error: error.message, code: error.code });

  if (error instanceof ReviewError)
    return reply.code(error.status).send({ error: error.message, code: error.code });

  if (error instanceof GitHubError && error.outcome === 'rate_limit')
    return reply
      .code(429)
      .send({ error: safeError(error), code: 'RATE_LIMITED', retryAt: error.retryAt });

  if (error instanceof GitHubError)
    return reply.code(502).send({ error: safeError(error), code: 'GITHUB_ERROR' });

  throw error;
}

export function registerPullRoutes(app: FastifyInstance, service: SyncService): void {
  // Scoped: each serves exactly the account in its path, whichever account is selected, so a
  // request finishes for the account it was made for even if another window switches meanwhile.
  app.get<{ Params: AccountParams }>('/api/accounts/:account/pulls', async (request, reply) => {
    const account = knownAccount(service, request.params, reply);

    return account ? service.listFor(account) : reply;
  });

  app.get<{ Params: AccountParams }>('/api/accounts/:account/mine', async (request, reply) => {
    const account = knownAccount(service, request.params, reply);

    return account ? service.mineFor(account) : reply;
  });

  app.get<{ Params: AccountParams & { id: string } }>(
    '/api/accounts/:account/pulls/:id',
    async (request, reply) => {
      const account = knownAccount(service, request.params, reply);

      if (!account) return reply;

      return (
        service.detailFor(account, request.params.id) ??
        reply.code(404).send({ error: 'This PR is no longer tracked for this account.' })
      );
    },
  );

  app.post<{ Params: AccountParams & { id: string } }>(
    '/api/accounts/:account/pulls/:id/refresh',
    async (request, reply) => {
      const account = knownAccount(service, request.params, reply);

      if (!account) return reply;

      try {
        return (
          (await service.refresh(request.params.id, account)) ??
          reply.code(404).send({ error: 'PR not found.' })
        );
      } catch (error) {
        return readError(reply, error);
      }
    },
  );

  app.patch<{ Params: AccountParams & { id: string } }>(
    '/api/accounts/:account/pulls/:id/triage',
    async (request, reply) => {
      const account = knownAccount(service, request.params, reply);

      if (!account) return reply;

      const parsed = scopedUpdateSchema.safeParse(request.body);

      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: 'Invalid triage update.', details: z.flattenError(parsed.error) });

      if (parsed.data.snoozeUntil && Date.parse(parsed.data.snoozeUntil) <= service.clock.now())
        return reply.code(400).send({ error: 'Choose a snooze time in the future.' });

      return (
        service.updateFor(account, request.params.id, parsed.data) ??
        reply.code(404).send({ error: 'PR not found.' })
      );
    },
  );

  app.post<{ Params: AccountParams }>(
    '/api/accounts/:account/pulls/track',
    async (request, reply) => {
      const account = knownAccount(service, request.params, reply);

      if (!account) return reply;

      const parsed = scopedTrackSchema.safeParse(request.body);

      if (!parsed.success)
        return reply.code(400).send({
          error:
            'Enter a PR as owner/repo#123, a GitLab MR as group/project!123, or a link to either.',
          details: z.flattenError(parsed.error),
        });

      const { repository, number, host, gitlab } = parsed.data;

      try {
        return await service.track(account, repository, number, host, gitlab);
      } catch (error) {
        return queueError(reply, error);
      }
    },
  );

  app.delete<{ Params: AccountParams & { id: string } }>(
    '/api/accounts/:account/pulls/:id/track',
    async (request, reply) => {
      const account = knownAccount(service, request.params, reply);

      if (!account) return reply;

      const parsed = untrackSchema.safeParse(request.body ?? {});

      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: 'Invalid request.', details: z.flattenError(parsed.error) });

      try {
        return service.untrack(account, request.params.id, parsed.data.membershipId);
      } catch (error) {
        return queueError(reply, error);
      }
    },
  );

  // Not any one account's: the selected account's sync, and the status every window shows.
  app.get('/api/status', async () => service.sentStatus);

  app.post('/api/sync', async (_request, reply) => {
    void service.sync();

    return reply.code(202).send(service.sentStatus);
  });
}
