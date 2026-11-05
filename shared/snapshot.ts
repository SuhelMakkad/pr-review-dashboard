import type { PullRequestSnapshot } from './types.js';

/** Bumped whenever snapshots gain fields that require a refetch of cached PRs. */
export const SNAPSHOT_VERSION = 2;

/** Fills fields added after a snapshot was cached, so older blobs keep working. */
export function normalizeSnapshot(raw: PullRequestSnapshot): PullRequestSnapshot {
  return {
    ...raw,
    baseOid: raw.baseOid ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    conversation: raw.conversation ?? [],
    forcePushes: raw.forcePushes ?? [],
    verdicts: raw.verdicts ?? [],
    pendingReview: raw.pendingReview ?? null,
  };
}

/** True when a cached snapshot predates the current version and should be refetched in full. */
export function isLegacySnapshot(raw: Pick<PullRequestSnapshot, 'version'>): boolean {
  return (raw.version ?? 1) < SNAPSHOT_VERSION;
}
