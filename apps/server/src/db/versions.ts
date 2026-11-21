import { and, eq, sql } from 'drizzle-orm';
import { draftVersions } from '@/db/schema.js';
import type { Store } from '@/db/store.js';

/** A PR's draft versions (see `draftVersions`). */
export interface DraftVersions {
  revision: number;
  generation: number;
  observation: number;
}

/** The PR's draft versions: 0 each until its draft first changes, or its first snapshot. */
export function draftVersionsOf(store: Store, account: string, prId: string): DraftVersions {
  const row = store.db
    .select({
      revision: draftVersions.revision,
      generation: draftVersions.generation,
      observation: draftVersions.observation,
    })
    .from(draftVersions)
    .where(and(eq(draftVersions.account, account), eq(draftVersions.prId, prId)))
    .get();

  return row ?? { revision: 0, generation: 0, observation: 0 };
}

/**
 * Raises the PR's versions, in the caller's transaction: the revision always, the generation for
 * a clear, lock or unlock, the observation for a committed snapshot.
 */
export function raiseVersions(
  store: Store,
  account: string,
  prId: string,
  raise: { revision?: boolean; generation?: boolean; observation?: boolean },
): void {
  const by = (field: boolean | undefined) => (field ? 1 : 0);

  store.db
    .insert(draftVersions)
    .values({
      account,
      prId,
      revision: by(raise.revision),
      generation: by(raise.generation),
      observation: by(raise.observation),
    })
    .onConflictDoUpdate({
      target: [draftVersions.account, draftVersions.prId],
      set: {
        revision: sql`${draftVersions.revision} + ${by(raise.revision)}`,
        generation: sql`${draftVersions.generation} + ${by(raise.generation)}`,
        observation: sql`${draftVersions.observation} + ${by(raise.observation)}`,
      },
    })
    .run();
}

/**
 * What a draft write is checked against, and records, in the transaction that commits it, after
 * every await its handler makes (see `routes/claims.ts`).
 */
export interface WriteFence {
  /** Refuses the write (`DRAFT_REVISION_CONFLICT`) unless the draft is still at its base. */
  check(): void;
  /** Records the write's claim committed with `body`, the answer a retry of it gets. */
  committed(body: unknown): void;
}
