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
 * The saved ids as storage holds them now: another tab may have added or forgotten some since this
 * one read them. This tab's own copy when storage cannot be read.
 */
function current(): Map<string, string> {
  try {
    const text = localStorage.getItem(STORAGE_KEY);

    return new Map(
      (JSON.parse(text ?? '[]') as [string, string][]).map(([key, id]) => [scopedKey(key), id]),
    );
  } catch {
    return new Map(pending);
  }
}

/**
 * Sets (`id`) or forgets (null; only while it is still `only`, when given) one saved id, in storage
 * as it is now, every other entry kept: one tab's change never undoes another's. True once saved.
 */
function update(key: string, id: string | null, only?: string): boolean {
  const next = current();

  if (id !== null) next.set(key, id);
  else if (only === undefined || next.get(key) === only) next.delete(key);

  pending = next;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));

    return true;
  } catch {
    return false;
  }
}

/**
 * The ids an earlier version kept for actions now owned elsewhere (a draft's submit and discard,
 * which its writer sends): each with its key, to be forgotten once its new owner recorded it.
 */
export function legacyIds(path: string, method: 'POST' | 'DELETE'): { key: string; id: string }[] {
  return [...current()].flatMap(([key, id]) => {
    try {
      const sent = JSON.parse(key) as { path: string; method: string };

      return sent.path === path && sent.method === method ? [{ key, id }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Forgets an id its new owner recorded, only that entry, only while it is still that id: true once
 * the deletion is saved, false if it was not.
 */
export function forgetLegacy(key: string, id: string): boolean {
  return update(key, null, id);
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
  const operationId = current().get(key) ?? crypto.randomUUID();

  update(key, operationId);

  try {
    const result = await api<T>(path, { method, body: { ...body, operationId } });

    update(key, null, operationId);

    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      !RETRYABLE.has(error.code ?? '')
    ) {
      update(key, null, operationId);
    }

    throw error;
  }
}
