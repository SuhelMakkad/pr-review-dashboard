import type { FastifyInstance } from 'fastify';
import { routes } from '@review-desk/shared/contract';
import { z } from 'zod';
import type { OperationQueue } from '@/operations/queue.js';
import { ReviewError } from '@/review/errors.js';
import { safeError } from '@/github/errors.js';
import { failed, ok, serve, type Failed } from '@/http/serve.js';
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
  const serving = { sync, errors: reviewFailure };

  serve(
    app,
    routes.operations,
    ({ account, query }) => ok(200, queue.list(account, query.cursor)),
    serving,
  );

  serve(
    app,
    routes.operation,
    ({ account, params }) => ok(200, { operation: queue.get(account, params.id) }),
    serving,
  );

  serve(
    app,
    routes.operationCommand,
    async ({ account, params, body }) => {
      const command = commands.safeParse(params.command);

      if (!command.success) return failed(400, { error: 'Invalid operation command.' });
      if (command.data === 'restore' && !body.confirm)
        return failed(400, {
          error: 'Confirm removing the pending GitHub review before restoring its draft.',
        });

      return ok(200, await queue.control(account, params.id, command.data, body.confirm));
    },
    serving,
  );
}

/** A refusal with its code and details; anything else, the server's own failure. */
function reviewFailure(error: unknown): Failed {
  if (error instanceof ReviewError)
    return failed(error.status, { error: error.message, code: error.code, ...error.details });

  return failed(500, { error: safeError(error) });
}
