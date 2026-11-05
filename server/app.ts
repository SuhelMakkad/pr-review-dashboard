import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import type { SyncService } from './sync.js';

const updateSchema = z
  .object({
    account: z.string().min(1).max(100),
    note: z.string().max(30_000).optional(),
    seenReplyKeys: z.array(z.string().max(250)).max(10_000).optional(),
    snoozeUntil: z.iso.datetime().nullable().optional(),
  })
  .strict();

export async function createApp(service: SyncService, webRoot?: string) {
  const app = Fastify({ logger: false, bodyLimit: 100_000 });

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    const allowedHosts = new Set([
      '127.0.0.1:4317',
      '127.0.0.1:4318',
      'localhost:4317',
      'localhost:4318',
    ]);

    if (!host || !allowedHosts.has(host.toLowerCase())) {
      await reply.code(403).send({ error: 'Review Desk accepts local requests only.' });
      return;
    }

    const origin = request.headers.origin;

    if (
      origin &&
      ![
        'http://127.0.0.1:4317',
        'http://localhost:4317',
        'http://127.0.0.1:4318',
        'http://localhost:4318',
      ].includes(origin)
    ) {
      await reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
      return;
    }

    if (
      ['POST', 'PATCH'].includes(request.method) &&
      (!request.headers['content-type']?.startsWith('application/json') ||
        request.headers['x-review-desk'] !== '1')
    ) {
      await reply.code(403).send({ error: 'A local JSON request is required.' });
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');

    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

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

  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Unknown API route.' })
        : reply.sendFile('index.html'),
    );
  }

  return app;
}
