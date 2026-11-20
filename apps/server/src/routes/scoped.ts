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
 * The request a route parses, with the path's account in it: the body must not name one. The
 * account stays part of the parsed request, as it was when legacy routes read it from the body,
 * so an action accepted before them is replayed by the same fingerprint.
 */
export function input<T>(
  schema: z.ZodType<T>,
  request: ScopedRequest,
  reply: FastifyReply,
  account: string,
): T | null {
  const body = request.body ?? {};

  if (typeof body !== 'object' || Array.isArray(body) || 'account' in body) {
    void reply.code(400).send({ error: 'Invalid request: the path names the account.' });
    return null;
  }

  return parse(schema, { ...body, account }, reply);
}

/**
 * Serves each route under `/api/accounts/:account`, for the account its path names. An account
 * this app never worked as is not served.
 */
export function scopedRoutes(app: FastifyInstance, sync: SyncService) {
  return function serve(
    method: 'get' | 'put' | 'post' | 'patch' | 'delete',
    path: string,
    work: (request: ScopedRequest, reply: FastifyReply, account: string) => Promise<unknown>,
  ) {
    app[method](`/api/accounts/:account${path.slice('/api'.length)}`, (request, reply) => {
      const account = knownAccount(sync, request.params as AccountParams, reply);

      return account ? work(request as ScopedRequest, reply, account) : reply;
    });
  };
}
