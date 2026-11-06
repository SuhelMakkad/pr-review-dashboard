import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OperationQueue } from '@/operations/queue.js';
import { ReviewError } from '@/review/errors.js';
import { safeError } from '@/github/errors.js';

export function registerOperationRoutes(app: FastifyInstance, queue: OperationQueue): void {
  async function handle(work: () => unknown, reply: import('fastify').FastifyReply) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ReviewError)
        return reply
          .code(error.status)
          .send({ error: error.message, code: error.code, ...error.details });

      return reply.code(500).send({ error: safeError(error) });
    }
  }

  app.get<{ Querystring: { account?: string; cursor?: string } }>(
    '/api/operations',
    async (request, reply) =>
      handle(() => queue.list(String(request.query.account ?? ''), request.query.cursor), reply),
  );

  app.get<{ Params: { id: string }; Querystring: { account?: string } }>(
    '/api/operations/:id',
    async (request, reply) =>
      handle(
        () => ({ operation: queue.get(String(request.query.account ?? ''), request.params.id) }),
        reply,
      ),
  );

  app.post<{ Params: { id: string; command: string } }>(
    '/api/operations/:id/:command',
    async (request, reply) => {
      const body = z
        .object({ account: z.string().min(1), confirm: z.boolean().optional() })
        .strict()
        .safeParse(request.body);
      const command = z
        .enum(['cancel', 'retry', 'check', 'reopen', 'dismiss', 'restore'])
        .safeParse(request.params.command);

      if (!body.success || !command.success)
        return reply.code(400).send({ error: 'Invalid operation command.' });
      if (command.data === 'restore' && !body.data.confirm)
        return reply.code(400).send({
          error: 'Confirm removing the pending GitHub review before restoring its draft.',
        });

      return handle(
        () => queue.control(body.data.account, request.params.id, command.data, body.data.confirm),
        reply,
      );
    },
  );
}
