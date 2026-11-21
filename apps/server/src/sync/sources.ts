import { FEED_SOURCES, type Source } from '@review-desk/shared/types';

/** Canonical order for a PR's sources. */
const SOURCE_ORDER: Source[] = [...FEED_SOURCES, 'manual'];

/** `sources` in canonical order. */
export const ordered = (sources: Iterable<Source>) =>
  SOURCE_ORDER.filter((source) => [...sources].includes(source));
