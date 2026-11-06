import type { OperationReceipt } from '@review-desk/shared/operations';
import { api, ApiError } from '@/lib/api';
import { storage } from '@/lib/storage';

const STORAGE_KEY = 'review-desk-pending-command-ids';
let pending = new Map<string, string>();

try {
  pending = new Map(JSON.parse(storage.get(STORAGE_KEY) ?? '[]') as [string, string][]);
} catch {
  // An invalid saved identifier must not prevent opening the application.
}

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
      error.code !== 'SESSION_EXPIRED'
    ) {
      pending.delete(key);
      storage.set(STORAGE_KEY, JSON.stringify([...pending]));
    }

    throw error;
  }
}
