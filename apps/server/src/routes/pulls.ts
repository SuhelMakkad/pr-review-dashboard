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

const trackSchema = z
  .object({
    account: z.string().min(1).max(100),
    // `owner/repo` on GitHub; GitLab projects can sit in nested groups (`group/sub/project`).
    repository: z
      .string()
      .max(400)
      .regex(/^[\w.-]+(?:\/[\w.-]+)+$/),
    number: z.number().int().positive().max(1_000_000_000),
    /** The host of a pasted link (`github.com`, or a GitLab host, port included). */
    host: z
      .string()
      .max(255)
      .regex(/^[\w.-]+(?::\d{1,5})?$/)
      .optional(),
    /** True for a GitLab reference (`group/project!123` or an MR link). */
    gitlab: z.boolean().optional(),
  })
  .strict();

const untrackSchema = z.object({ account: z.string().min(1).max(100) }).strict();

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

  // Legacy, for the selected account; they go once the web uses only the scoped routes.

  app.get('/api/status', async () => service.sentStatus);
  app.get('/api/pulls', async () => service.list());
  app.get('/api/mine', async () => service.mine());

  app.get<{ Params: { id: string } }>('/api/pulls/:id', async (request, reply) => {
    const detail = service.detail(request.params.id);

    return (
      detail ??
      reply.code(404).send({ error: 'This PR is no longer tracked for the active account.' })
    );
  });

  app.post<{ Params: { id: string } }>('/api/pulls/:id/refresh', async (request, reply) => {
    try {
      const detail = await service.refresh(request.params.id);

      return detail ?? reply.code(404).send({ error: 'PR not found.' });
    } catch (error) {
      return readError(reply, error);
    }
  });

  app.post('/api/pulls/track', async (request, reply) => {
    const parsed = trackSchema.safeParse(request.body);

    if (!parsed.success)
      return reply.code(400).send({
        error:
          'Enter a PR as owner/repo#123, a GitLab MR as group/project!123, or a link to either.',
        details: z.flattenError(parsed.error),
      });

    const { account, repository, number, host, gitlab } = parsed.data;

    try {
      return await service.track(account, repository, number, host, gitlab);
    } catch (error) {
      return queueError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/pulls/:id/track', async (request, reply) => {
    const parsed = untrackSchema.safeParse(request.body);

    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'Invalid request.', details: z.flattenError(parsed.error) });

    try {
      return service.untrack(parsed.data.account, request.params.id);
    } catch (error) {
      return queueError(reply, error);
    }
  });

  app.post('/api/sync', async (_request, reply) => {
    void service.sync();

    return reply.code(202).send(service.sentStatus);
  });

  app.patch<{ Params: { id: string } }>('/api/pulls/:id/triage', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);

    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'Invalid triage update.', details: parsed.error.flatten() });

    // The app's clock, which also decides when the snooze ends.
    if (parsed.data.snoozeUntil && Date.parse(parsed.data.snoozeUntil) <= service.clock.now()) {
      return reply.code(400).send({ error: 'Choose a snooze time in the future.' });
    }

    try {
      const result = service.update(request.params.id, parsed.data);

      return result ?? reply.code(404).send({ error: 'PR not found.' });
    } catch (error) {
      if (error instanceof Error && error.message === 'ACCOUNT_CHANGED')
        return reply
          .code(409)
          .send({ error: 'GitHub account changed. Refresh before updating this PR.' });

      throw error;
    }
  });
}
