import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { knownAccount, type AccountParams } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

export type ScopedRequest = FastifyRequest<{
  Params: Record<string, string>;
  Querystring: Record<string, string | undefined>;
}>;

export function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(value);

  if (!result.success) {
    void reply.code(400).send({ error: 'Invalid request.', details: z.flattenError(result.error) });
    return null;
  }

  return result.data;
}

/**
 * The request a route parses, with its account: from the body on a legacy route, from the path
 * on an account's own (`scoped`), where the body must not name one. Both give exactly the same
 * object, so an action ID accepted through one is replayed through the other.
 */
export function input<T>(
  schema: z.ZodType<T>,
  request: ScopedRequest,
  reply: FastifyReply,
  scoped: string | null,
): T | null {
  if (scoped === null) return parse(schema, request.body, reply);

  const body = request.body ?? {};

  if (typeof body !== 'object' || Array.isArray(body) || 'account' in body) {
    void reply.code(400).send({ error: 'Invalid request: the path names the account.' });
    return null;
  }

  return parse(schema, { ...body, account: scoped }, reply);
}

/**
 * Serves each route twice: as the legacy route, whose request names the account, and under
 * `/api/accounts/:account`, whose path does. `work` gets the path's account, or null on the
 * legacy route. An account this app never worked as is not served.
 */
export function scopedRoutes(app: FastifyInstance, sync: SyncService) {
  return function serve(
    method: 'get' | 'put' | 'post' | 'patch' | 'delete',
    path: string,
    work: (request: ScopedRequest, reply: FastifyReply, scoped: string | null) => Promise<unknown>,
  ) {
    app[method](path, (request, reply) => work(request as ScopedRequest, reply, null));
    app[method](`/api/accounts/:account${path.slice('/api'.length)}`, (request, reply) => {
      const account = knownAccount(sync, request.params as AccountParams, reply);

      return account ? work(request as ScopedRequest, reply, account) : reply;
    });
  };
}
