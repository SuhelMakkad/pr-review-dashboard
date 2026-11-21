import { session } from '@/lib/session';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Calls the local API. Writes carry the per-launch session token; an expired session reloads. A
 * cancelled request (`signal`) rejects with its abort, never as an unreachable server.
 */
export async function api<T>(
  path: string,
  options: {
    method?: Method;
    body?: unknown;
    signal?: AbortSignal;
    /**
     * An answer that cannot be read is an error (`UNREADABLE`), never an empty success: a draft
     * write's outcome is only what its answer says.
     */
    strict?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const signal = options.signal;
  const init: RequestInit =
    method === 'GET'
      ? { ...(signal ? { signal } : {}) }
      : {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Review-Desk': '1',
            'X-Review-Desk-Session': session.token(),
          },
          body: JSON.stringify(options.body ?? {}),
          ...(signal ? { signal } : {}),
        };

  let response: Response;

  try {
    response = await fetch(path, init);
  } catch (error) {
    if (signal?.aborted) throw error;

    throw new ApiError('Review Desk is not reachable. Is `pnpm start` still running?', 0);
  }

  const result = (await response.json().catch((error: unknown) => {
    if (signal?.aborted) throw error;
    if (options.strict)
      throw new ApiError('The answer could not be read.', response.status, 'UNREADABLE');

    return {};
  })) as Record<string, unknown> & {
    error?: string;
    code?: string;
  };

  if (!response.ok) {
    if (result.code === 'SESSION_EXPIRED') window.location.reload();

    throw new ApiError(
      result.error ?? 'The local server could not complete this request.',
      response.status,
      result.code,
      result,
    );
  }

  return result as T;
}
