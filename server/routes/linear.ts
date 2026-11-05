import type { FastifyInstance } from 'fastify';
import type { LinearService } from '../linear/service.js';
import type { SyncService } from '../sync/service.js';

export function registerLinearRoutes(
  app: FastifyInstance,
  service: SyncService,
  linear: LinearService,
): void {
  app.get('/api/linear/status', async () => linear.status());

  app.get<{ Params: { id: string } }>('/api/pulls/:id/tickets', async (request, reply) => {
    const detail = service.detail(request.params.id);

    if (!detail) return reply.code(404).send({ error: 'This PR is no longer tracked.' });

    return linear.ticketsFor(detail.snapshot);
  });
}
