import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { OperationQueue } from '@/operations/queue.js';
import { ReviewError } from '@/review/errors.js';
import { safeError } from '@/github/errors.js';
import { knownAccount, type AccountParams } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

const commands = z.enum(['cancel', 'retry', 'check', 'reopen', 'dismiss', 'restore']);

/**
 * Activity: any account's actions can be read, and stopped or hidden; the commands that schedule
 * forge work need the account in use.
 */
export function registerOperationRoutes(
  app: FastifyInstance,
  queue: OperationQueue,
  sync: SyncService,
): void {
  async function handle(reply: FastifyReply, work: () => unknown) {
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

  app.get<{ Params: AccountParams; Querystring: { cursor?: string } }>(
    '/api/accounts/:account/operations',
    async (request, reply) => {
      const account = knownAccount(sync, request.params, reply);

      return account ? handle(reply, () => queue.list(account, request.query.cursor)) : reply;
    },
  );

  app.get<{ Params: AccountParams & { id: string } }>(
    '/api/accounts/:account/operations/:id',
    async (request, reply) => {
      const account = knownAccount(sync, request.params, reply);

      return account
        ? handle(reply, () => ({ operation: queue.get(account, request.params.id) }))
        : reply;
    },
  );

  app.post<{ Params: AccountParams & { id: string; command: string } }>(
    '/api/accounts/:account/operations/:id/:command',
    async (request, reply) => {
      const account = knownAccount(sync, request.params, reply);

      if (!account) return reply;

      const body = z
        .object({ confirm: z.boolean().optional() })
        .strict()
        .safeParse(request.body ?? {});
      const command = commands.safeParse(request.params.command);

      if (!body.success || !command.success)
        return reply.code(400).send({ error: 'Invalid operation command.' });
      if (command.data === 'restore' && !body.data.confirm)
        return reply.code(400).send({
          error: 'Confirm removing the pending GitHub review before restoring its draft.',
        });

      return handle(reply, () =>
        queue.control(account, request.params.id, command.data, body.data.confirm),
      );
    },
  );
}
