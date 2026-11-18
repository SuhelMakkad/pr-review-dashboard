import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
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

/** Maps queue-change failures to `{ error, code }` responses. */
function queueError(reply: FastifyReply, error: unknown) {
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
  app.get('/api/status', async () => service.status);
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
      return reply.code(502).send({ error: safeError(error) });
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

    return reply.code(202).send(service.status);
  });

  app.patch<{ Params: { id: string } }>('/api/pulls/:id/triage', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);

    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'Invalid triage update.', details: parsed.error.flatten() });

    if (parsed.data.snoozeUntil && Date.parse(parsed.data.snoozeUntil) <= Date.now()) {
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
