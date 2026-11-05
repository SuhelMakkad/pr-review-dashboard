import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SyncService } from '../sync/service.js';

const updateSchema = z
  .object({
    account: z.string().min(1).max(100),
    note: z.string().max(30_000).optional(),
    seenReplyKeys: z.array(z.string().max(250)).max(10_000).optional(),
    snoozeUntil: z.iso.datetime().nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();

export function registerPullRoutes(app: FastifyInstance, service: SyncService): void {
  app.get('/api/status', async () => service.status);
  app.get('/api/pulls', async () => service.list());

  app.get<{ Params: { id: string } }>('/api/pulls/:id', async (request, reply) => {
    const detail = service.detail(request.params.id);

    return (
      detail ??
      reply.code(404).send({ error: 'This PR is no longer tracked for the active account.' })
    );
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
