import { emptyTriage } from '@review-desk/shared/attention';
import { normalizeSnapshot } from '@review-desk/shared/snapshot';
import type { LocalTriageState, PullRequestSnapshot } from '@review-desk/shared/types';

/**
 * How the store reads the JSON documents it keeps, written as they are. Every legacy shape is told
 * apart by its shape alone, so no document carries a stored version of its format.
 */

/**
 * A cached PR: one cached before a field existed gains its default. Its `version` stays as
 * stored, so `isLegacySnapshot` still asks for a full refetch of a snapshot older than the app.
 */
export const snapshotCodec = {
  decode: (raw: PullRequestSnapshot): PullRequestSnapshot => normalizeSnapshot(raw),
};

/** A PR's local triage, over the empty triage: fields added since read as their defaults. */
export const triageCodec = {
  decode: (raw: Partial<LocalTriageState>): LocalTriageState => ({ ...emptyTriage(), ...raw }),
};
