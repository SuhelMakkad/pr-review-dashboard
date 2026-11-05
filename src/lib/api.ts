import { session } from './session';

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

/** Calls the local API. Writes carry the per-launch session token; an expired session reloads. */
export async function api<T>(
  path: string,
  options: { method?: Method; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const init: RequestInit =
    method === 'GET'
      ? {}
      : {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Review-Desk': '1',
            'X-Review-Desk-Session': session.token(),
          },
          body: JSON.stringify(options.body ?? {}),
        };

  let response: Response;

  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('Review Desk is not reachable. Is `pnpm start` still running?', 0);
  }

  const result = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
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
