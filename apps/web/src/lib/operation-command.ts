import type { OperationReceipt } from '@review-desk/shared/operations';
import { api, ApiError } from '@/lib/api';

/**
 * Each command's id is kept, across reloads, under its own storage key: setting or forgetting one
 * never rewrites another, so no tab's change can undo another's. Earlier versions kept every id
 * in one shared map (`LEGACY_KEY`): it is only read now, and an id of it forgotten here is marked
 * so under its own key, never written back into it.
 */
const PREFIX = 'review-desk-pending-command:';
const LEGACY_KEY = 'review-desk-pending-command-ids';
/** The mark an id of the shared map leaves once forgotten here. */
const FORGOTTEN = '!';

/**
 * Ids this tab set and has not cleared, saved or not: a retry here reuses its id even when
 * storage could not be written. Never written back to storage.
 */
const memory = new Map<string, string>();

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

/** The earlier versions' shared map, as storage holds it now; empty when unreadable. */
function legacyMap(): Map<string, string> {
  try {
    return new Map(
      (JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]') as [string, string][]).map(
        ([key, id]) => [scopedKey(key), id],
      ),
    );
  } catch {
    return new Map();
  }
}

/** What storage holds for `key` now under its own entry: an id, its forgotten mark, or nothing. */
function entry(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

/** The id saved for `key` now: its own entry's, else the shared map's unless forgotten here. */
function savedId(key: string): string | undefined {
  const own = entry(key);

  if (own !== null) return own.startsWith(FORGOTTEN) ? undefined : own;

  return legacyMap().get(key);
}

/** Every id saved now, by key. */
function savedIds(): Map<string, string> {
  const ids = new Map<string, string>();
  const forgotten = new Set<string>();

  try {
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);

      if (!name?.startsWith(PREFIX)) continue;

      const value = localStorage.getItem(name) ?? '';
      const key = name.slice(PREFIX.length);

      if (value.startsWith(FORGOTTEN)) forgotten.add(key);
      else ids.set(key, value);
    }
  } catch {
    // Unreadable: only what this tab holds.
  }

  for (const [key, id] of legacyMap()) if (!ids.has(key) && !forgotten.has(key)) ids.set(key, id);

  return ids;
}

/** Saves `id` for `key`, under its own entry; kept in this tab either way. True once saved. */
function save(key: string, id: string): boolean {
  memory.set(key, id);

  try {
    localStorage.setItem(PREFIX + key, id);

    return true;
  } catch {
    return false;
  }
}

/**
 * Forgets `id` for `key`, only while it is still that id: its own entry removed, or, for an id the
 * shared map holds, marked forgotten. True once the change is saved.
 */
function forget(key: string, id: string): boolean {
  if (memory.get(key) === id) memory.delete(key);

  try {
    const own = entry(key);

    if (own !== null && own !== id) return true;

    if (legacyMap().get(key) === id) localStorage.setItem(PREFIX + key, FORGOTTEN + id);
    else localStorage.removeItem(PREFIX + key);

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
  return [...savedIds()].flatMap(([key, id]) => {
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
  return forget(key, id);
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
  // Saved before, by this tab or another, or held by this tab though it could not be saved.
  const operationId = savedId(key) ?? memory.get(key) ?? crypto.randomUUID();

  save(key, operationId);

  try {
    const result = await api<T>(path, { method, body: { ...body, operationId } });

    forget(key, operationId);

    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      !RETRYABLE.has(error.code ?? '')
    ) {
      forget(key, operationId);
    }

    throw error;
  }
}
