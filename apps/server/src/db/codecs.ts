import { emptyTriage } from '@review-desk/shared/attention';
import { normalizeSnapshot } from '@review-desk/shared/snapshot';
import type { LocalTriageState, PullRequestSnapshot } from '@review-desk/shared/types';

/**
 * How the store reads the JSON documents it keeps, written as they are, with no version envelope
 * around them. Older shapes are told apart by their shape. A snapshot also keeps the `version`
 * field it always had, which marks one cached before the app's current snapshot version.
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
