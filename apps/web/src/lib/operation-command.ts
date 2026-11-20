import type { OperationReceipt } from '@review-desk/shared/operations';
import { api, ApiError } from '@/lib/api';
import { storage } from '@/lib/storage';

const STORAGE_KEY = 'review-desk-pending-command-ids';
let pending = new Map<string, string>();

/**
 * The key a command saved by an earlier version, on a legacy route that named its account in the
 * body, has on that account's own route: the same action, so its ID is sent again there.
 */
export function scopedKey(key: string): string {
  try {
    const { path, body, method } = JSON.parse(key) as {
      path: string;
      body: Record<string, unknown>;
      method: string;
    };
    const { account, ...rest } = body;

    if (typeof account !== 'string' || !/^\/api\/(pulls|threads)\//.test(path)) return key;

    return JSON.stringify({
      path: `/api/accounts/${encodeURIComponent(account)}${path.slice('/api'.length)}`,
      body: rest,
      method,
    });
  } catch {
    return key;
  }
}

try {
  pending = new Map(
    (JSON.parse(storage.get(STORAGE_KEY) ?? '[]') as [string, string][]).map(([key, id]) => [
      scopedKey(key),
      id,
    ]),
  );
} catch {
  // An invalid saved identifier must not prevent opening the application.
}

/**
 * Refusals that did nothing and can be retried as they are: the same action, sent again, keeps
 * its ID, so a retry after an earlier answer was lost is recognised.
 */
const RETRYABLE = new Set([
  'SESSION_EXPIRED',
  'ACCOUNT_NOT_ACTIVE',
  'ACCOUNT_UNAVAILABLE',
  'RATE_LIMITED',
  // A reply's PR kept changing while it was read again to find the thread.
  'QUEUE_CHANGED',
]);

/** Keep the command ID after an uncertain acceptance response, including across reloads. */
export async function githubCommand<T = OperationReceipt>(
  path: string,
  body: Record<string, unknown>,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<T> {
  const key = JSON.stringify({ path, body, method });
  const operationId = pending.get(key) ?? crypto.randomUUID();

  pending.set(key, operationId);
  storage.set(STORAGE_KEY, JSON.stringify([...pending]));

  try {
    const result = await api<T>(path, { method, body: { ...body, operationId } });

    pending.delete(key);
    storage.set(STORAGE_KEY, JSON.stringify([...pending]));

    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      !RETRYABLE.has(error.code ?? '')
    ) {
      pending.delete(key);
      storage.set(STORAGE_KEY, JSON.stringify([...pending]));
    }

    throw error;
  }
}
