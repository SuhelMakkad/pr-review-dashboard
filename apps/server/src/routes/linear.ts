import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeError } from '@/github/errors.js';
import type { LinearService } from '@/linear/service.js';
import type { SyncService } from '@/sync/service.js';

const callbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
  iss: z.string().max(200).optional(),
});

export function registerLinearRoutes(
  app: FastifyInstance,
  service: SyncService,
  linear: LinearService,
): void {
  app.get('/api/linear/status', async () => linear.status());

  app.post('/api/linear/connect', async (request, reply) => {
    // Linear must send the browser back to the address it is using now. That is its Origin: in
    // development Vite proxies the API with the API port as Host. The security hook already
    // limited both headers to this machine's allowed ports.
    const origin = request.headers.origin;
    const port = new URL(origin && origin !== 'null' ? origin : `http://${request.headers.host}`)
      .port;
    const redirectUri = `http://127.0.0.1:${port}/api/linear/callback`;

    try {
      return { url: await linear.connect(redirectUri) };
    } catch (error) {
      return reply.code(502).send({ error: safeError(error) });
    }
  });

  // Linear sends the browser here after sign-in. The one-time state from /connect is what ties the
  // response to a sign-in this app started, so a forged link cannot connect another account.
  app.get('/api/linear/callback', async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    const connected = query.success ? await linear.callback(query.data) : false;

    return reply.redirect(`/settings?linear=${connected ? 'connected' : 'failed'}`, 303);
  });

  app.post('/api/linear/disconnect', async () => {
    await linear.disconnect();

    return linear.status();
  });

  app.get<{ Params: { id: string } }>('/api/pulls/:id/tickets', async (request, reply) => {
    const detail = service.detail(request.params.id);

    if (!detail) return reply.code(404).send({ error: 'This PR is no longer tracked.' });

    return linear.ticketsFor(detail.snapshot);
  });
}
