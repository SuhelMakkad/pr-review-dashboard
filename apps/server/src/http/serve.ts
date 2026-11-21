import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  As,
  ErrorBody,
  JsonRoute,
  Method,
  PathParams,
  RedirectRoute,
  Reply,
} from '@review-desk/shared/contract';
import { render, type Wording } from '@/messages.js';
import { knownAccount, type AccountParams } from '@/routes/pulls.js';
import { input, type ScopedRequest } from '@/routes/scoped.js';
import type { SyncService } from '@/sync/service.js';

/** A refusal's body before `serve` words its message for the request's account. */
export type FailedBody = Omit<ErrorBody, 'error'> & { error: Wording };

/** A refusal a handler returns, or an area's error mapper makes of what a handler threw. */
export interface Failed {
  failed: true;
  /** An HTTP error status, 400 to 599: never a success, which only `ok` sends, as declared. */
  status: number;
  body: FailedBody;
}

export const failed = (status: number, body: FailedBody): Failed => {
  if (!Number.isInteger(status) || status < 400 || status > 599)
    throw new Error(`A refusal needs an error status, not ${status}.`);

  return { failed: true, status, body };
};

/** A success the route declares: this status, with the body it carries. */
export const ok = <S extends number, B>(status: S, body: B) => ({ status, body });

type BodyValue<B> = B extends { canonical: infer S extends z.ZodType }
  ? z.output<S>
  : B extends { schema: infer S extends z.ZodType }
    ? z.output<S>
    : undefined;

type QueryValue<Q> = Q extends z.ZodType ? z.output<Q> : Record<string, never>;

/** The route's own body and query, as declared: none where it declares none. */
type Declared<R> =
  R extends JsonRoute<Method, string, infer Q, infer B, Record<number, As<unknown>>>
    ? { query: QueryValue<Q>; body: BodyValue<B> }
    : never;

/** What a handler is given: the request as the route's contract parsed it. */
export interface Parsed<R extends JsonRoute> {
  params: PathParams<R['path']>;
  query: Declared<R>['query'];
  body: Declared<R>['body'];
  /** The account the path names, on an account route; empty otherwise. */
  account: string;
  request: FastifyRequest;
}

export interface Serving {
  sync: SyncService;
  /** Maps what a handler throws to its answer, for the request's account; it rethrows the rest. */
  errors?: (error: unknown, account: string) => Failed;
}

const isAccountRoute = (path: string) => path.startsWith('/api/accounts/:account/');

/**
 * Serves one route of the contract. Before the handler runs: an account route's account must be
 * one this app has worked as; the query and body are parsed by the route's schemas, a canonical
 * body with the path's account in it (and none of its own). The handler answers with one of the
 * successes the route declares, or a refusal; `serve` sends it.
 */
export function serve<R extends JsonRoute>(
  app: FastifyInstance,
  route: R,
  handler: (parsed: Parsed<R>) => Promise<Reply<R> | Failed> | Reply<R> | Failed,
  serving: Serving,
): void {
  app.route({
    method: route.method,
    url: route.path,
    handler: async (request, reply) => {
      const params = request.params as Record<string, string>;
      let account = '';

      if (isAccountRoute(route.path)) {
        const known = knownAccount(serving.sync, params as unknown as AccountParams, reply);

        if (!known) return reply;

        account = known;
      }

      let query: unknown = {};

      if (route.query) {
        const parsed = route.query.safeParse(request.query ?? {});

        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: 'Invalid request.', details: z.flattenError(parsed.error) });

        query = parsed.data;
      }

      let body: unknown;

      if (route.body && 'canonical' in route.body) {
        body = input(route.body.canonical, request as ScopedRequest, reply, account);

        if (body === null) return reply;
      } else if (route.body) {
        const parsed = route.body.schema.safeParse(request.body);

        if (!parsed.success) {
          const invalid = route.body.invalid ?? { error: 'Invalid request.', details: true };

          return reply.code(400).send({
            error: invalid.error,
            ...(invalid.details ? { details: z.flattenError(parsed.error) } : {}),
          });
        }

        body = parsed.data;
      }

      let answer: Reply<R> | Failed;

      try {
        answer = await handler({
          params: params as PathParams<R['path']>,
          query: query as Declared<R>['query'],
          body: body as Declared<R>['body'],
          account,
          request,
        });
      } catch (error) {
        if (!serving.errors) throw error;

        answer = serving.errors(error, account);
      }

      // A refusal in the words of the account the path names, else of the account in use.
      const sent =
        'failed' in answer
          ? {
              ...answer.body,
              error: render(answer.body.error, account || serving.sync.status.account?.login),
            }
          : answer.body;

      return reply.code(answer.status).send(sent);
    },
  });
}

/** Serves a route that sends the browser elsewhere: the handler gives the address. */
export function serveRedirect<R extends RedirectRoute>(
  app: FastifyInstance,
  route: R,
  handler: (request: FastifyRequest) => Promise<string> | string,
): void {
  app.get(route.path, async (request, reply) =>
    reply.redirect(await handler(request), route.status),
  );
}
