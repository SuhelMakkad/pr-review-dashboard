import type { OperationReceipt } from '@review-desk/shared/operations';
import { api, ApiError } from '@/lib/api';

/**
 * Each command's id is kept, across reloads, under its own storage key: setting or forgetting one
 * never rewrites another, so no tab's change can undo another's. Earlier versions kept every id
 * in one shared map (`LEGACY_KEY`): it is only read now. An id of it retired here is marked under a
 * key of its own, by that very id (`RETIRED`), apart from the ids in use, so nothing sent for the
 * same action later can ever clear that mark.
 */
const PREFIX = 'review-desk-pending-command:';
const RETIRED = 'review-desk-retired-command:';
const LEGACY_KEY = 'review-desk-pending-command-ids';

/**
 * Ids this tab set and has not cleared, saved or not: a retry here reuses its id even when
 * storage could not be written. Never written back to storage.
 */
const memory = new Map<string, string>();
/** Shared-map ids retired in this tab whose mark could not be saved: still retired here. */
const retiredHere = new Set<string>();

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

const read = (name: string): string | null => {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
};

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

/** Whether a shared-map id was retired: its own mark, read directly, or this tab's record. */
const retired = (id: string) => retiredHere.has(id) || read(RETIRED + id) !== null;

/** `id`, unless it is a retired one: wherever it was read from, a retired id is never reused. */
const usable = (id: string | null | undefined) =>
  id !== null && id !== undefined && !retired(id) ? id : undefined;

/**
 * The id saved for `key` now: its own entry's, else the shared map's, either only unless retired
 * (a tab may have saved a copy of an id another had just retired).
 */
function savedId(key: string): string | undefined {
  const own = read(PREFIX + key);

  return own !== null ? usable(own) : usable(legacyMap().get(key));
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
 * Forgets `id` for `key`: its own entry removed while it is still that id, and, when it is an id
 * the shared map held (`retire`), that id retired by a mark of its own, written for that very id
 * whatever the map reads now (kept in this tab when the mark could not be saved). True once every
 * change is saved.
 */
function forget(key: string, id: string, retire: boolean): boolean {
  if (memory.get(key) === id) memory.delete(key);

  let saved = true;

  try {
    if (localStorage.getItem(PREFIX + key) === id) localStorage.removeItem(PREFIX + key);
  } catch {
    saved = false;
  }

  if (retire) {
    try {
      localStorage.setItem(RETIRED + id, '1');
    } catch {
      retiredHere.add(id);
      saved = false;
    }
  }

  return saved;
}

/**
 * The ids an earlier version kept, in its shared map, for actions now owned elsewhere (a draft's
 * submit and discard, which its writer sends), each read directly against its own retirement mark:
 * with its key, to be forgotten once its new owner recorded it.
 */
export function legacyIds(path: string, method: 'POST' | 'DELETE'): { key: string; id: string }[] {
  return [...legacyMap()].flatMap(([key, id]) => {
    if (retired(id)) return [];

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
  return forget(key, id, true);
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
  // Saved before, by this tab or another, or held by this tab though it could not be saved: never
  // a retired one.
  const operationId = savedId(key) ?? usable(memory.get(key)) ?? crypto.randomUUID();
  // One the earlier versions' map held: retired once it settles, so it is never reused.
  const retire = legacyMap().get(key) === operationId;

  save(key, operationId);

  try {
    const result = await api<T>(path, { method, body: { ...body, operationId } });

    forget(key, operationId, retire);

    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      !RETRYABLE.has(error.code ?? '')
    ) {
      forget(key, operationId, retire);
    }

    throw error;
  }
}
