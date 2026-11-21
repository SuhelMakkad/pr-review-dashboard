import type {
  BodyOf,
  JsonRoute,
  PathParams,
  QueuedRoute,
  ResponseOf,
  Route,
} from '@review-desk/shared/contract';
import type { z } from 'zod';
import { api } from '@/lib/api';
import { githubCommand } from '@/lib/operation-command';

type Declared<R> =
  R extends JsonRoute<infer _M, infer _P, infer Q, infer B, infer _R>
    ? { query: Q extends z.ZodType ? z.input<Q> : undefined; body: BodyOf<B> }
    : never;

/**
 * A route's address: each `:name` replaced by its value, encoded, and the query appended with its
 * empty values left out. Commands' saved IDs are keyed by it, so it is built as it always was.
 */
export function pathOf<R extends Route>(
  route: R,
  params: PathParams<R['path']>,
  query?: Record<string, string | number | null | undefined>,
): string {
  const values = params as Record<string, string>;
  const path = route.path.replace(/:(\w+)/g, (_, name: string) =>
    encodeURIComponent(values[name]!),
  );
  const search = new URLSearchParams(
    Object.entries(query ?? {}).flatMap(([key, value]) =>
      value === undefined || value === null || value === '' ? [] : [[key, String(value)]],
    ),
  ).toString();

  return search ? `${path}?${search}` : path;
}

type Options<R extends JsonRoute> = {
  params: PathParams<R['path']>;
  signal?: AbortSignal;
  /** An unreadable answer is an error, never an empty success (see `api`). */
  strict?: boolean;
} & (Declared<R>['query'] extends undefined
  ? { query?: never }
  : { query?: Declared<R>['query'] }) &
  ([Declared<R>['body']] extends [never] ? { body?: never } : { body: Declared<R>['body'] });

/** Calls one route of the contract; its answer is typed by the route. */
export function call<R extends JsonRoute>(route: R, options: Options<R>): Promise<ResponseOf<R>> {
  return api<ResponseOf<R>>(
    pathOf(route, options.params, options.query as Record<string, string | number> | undefined),
    {
      method: route.method,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.strict ? { strict: true } : {}),
    },
  );
}

/**
 * Queues an action through one route of the contract. Its ID is kept across a lost response
 * (`githubCommand`), under the same key as before: the same address and the body as given, the
 * ID added after.
 */
export function command<R extends QueuedRoute>(
  route: R,
  params: PathParams<R['path']>,
  body: Omit<Declared<R>['body'], 'operationId'>,
): Promise<ResponseOf<R>> {
  return githubCommand<ResponseOf<R>>(
    pathOf(route, params),
    body as Record<string, unknown>,
    route.method as 'POST' | 'DELETE',
  );
}
