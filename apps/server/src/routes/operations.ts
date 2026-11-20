import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { OperationQueue } from '@/operations/queue.js';
import { legacyAccountError, ReviewError } from '@/review/errors.js';
import { safeError } from '@/github/errors.js';
import { knownAccount, type AccountParams } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

const commands = z.enum(['cancel', 'retry', 'check', 'reopen', 'dismiss', 'restore']);

/**
 * Activity: any account's actions can be read, and stopped or hidden; the commands that schedule
 * forge work need the account in use. Each route is served twice: legacy, with the account in the
 * query or body, and under `/api/accounts/:account`, with it in the path.
 */
export function registerOperationRoutes(
  app: FastifyInstance,
  queue: OperationQueue,
  sync: SyncService,
): void {
  async function handle(reply: FastifyReply, scoped: boolean, work: () => unknown) {
    try {
      return await work();
    } catch (raw) {
      const error = scoped ? raw : legacyAccountError(raw);

      if (error instanceof ReviewError)
        return reply
          .code(error.status)
          .send({ error: error.message, code: error.code, ...error.details });

      return reply.code(500).send({ error: safeError(error) });
    }
  }

  const list = (
    account: string,
    cursor: string | undefined,
    reply: FastifyReply,
    scoped: boolean,
  ) => handle(reply, scoped, () => queue.list(account, cursor));

  const one = (account: string, id: string, reply: FastifyReply, scoped: boolean) =>
    handle(reply, scoped, () => ({ operation: queue.get(account, id) }));

  async function command(
    account: string,
    params: { id: string; command: string },
    confirm: boolean | undefined,
    reply: FastifyReply,
    scoped: boolean,
  ) {
    const parsed = commands.safeParse(params.command);

    if (!parsed.success) return reply.code(400).send({ error: 'Invalid operation command.' });
    if (parsed.data === 'restore' && !confirm)
      return reply.code(400).send({
        error: 'Confirm removing the pending GitHub review before restoring its draft.',
      });

    return handle(reply, scoped, () => queue.control(account, params.id, parsed.data, confirm));
  }

  app.get<{ Querystring: { account?: string; cursor?: string } }>(
    '/api/operations',
    async (request, reply) =>
      list(String(request.query.account ?? ''), request.query.cursor, reply, false),
  );

  app.get<{ Params: AccountParams; Querystring: { cursor?: string } }>(
    '/api/accounts/:account/operations',
    async (request, reply) => {
      const account = knownAccount(sync, request.params, reply);

      return account ? list(account, request.query.cursor, reply, true) : reply;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { account?: string } }>(
    '/api/operations/:id',
    async (request, reply) =>
      one(String(request.query.account ?? ''), request.params.id, reply, false),
  );

  app.get<{ Params: AccountParams & { id: string } }>(
    '/api/accounts/:account/operations/:id',
    async (request, reply) => {
      const account = knownAccount(sync, request.params, reply);

      return account ? one(account, request.params.id, reply, true) : reply;
    },
  );

  app.post<{ Params: { id: string; command: string } }>(
    '/api/operations/:id/:command',
    async (request, reply) => {
      const body = z
        .object({ account: z.string().min(1), confirm: z.boolean().optional() })
        .strict()
        .safeParse(request.body);

      if (!body.success) return reply.code(400).send({ error: 'Invalid operation command.' });

      return command(body.data.account, request.params, body.data.confirm, reply, false);
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

      if (!body.success) return reply.code(400).send({ error: 'Invalid operation command.' });

      return command(account, request.params, body.data.confirm, reply, true);
    },
  );
}
