import { settings } from '@/db/schema.js';
import type { Store } from '@/db/store.js';

/** Stores `value` under `key` as given, as an older version could have: nothing is checked. */
export function storeRaw(store: Store, key: string, value: unknown): void {
  store.db
    .insert(settings)
    .values({ key, data: value })
    .onConflictDoUpdate({ target: settings.key, set: { data: value } })
    .run();
}
