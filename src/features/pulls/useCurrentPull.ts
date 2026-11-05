import { useParams } from '@tanstack/react-router';
import type { PullRequestItem } from '../../../shared/types';
import { sameRef, type PrRef } from '../../lib/prRef';
import { usePulls } from '../../lib/queries';

/** The PR named by the current route, if any (inbox reading pane or full PR page). */
export function useRouteRef(): PrRef | null {
  const params = useParams({ strict: false }) as { owner?: string; repo?: string; number?: string };
  const number = Number(params.number);

  return params.owner && params.repo && Number.isInteger(number)
    ? { owner: params.owner, repo: params.repo, number }
    : null;
}

export function useCurrentPull(): { ref: PrRef | null; item: PullRequestItem | null } {
  const ref = useRouteRef();
  const pulls = usePulls();
  const item = ref
    ? (pulls.data?.items.find((candidate) => sameRef(candidate, ref)) ?? null)
    : null;

  return { ref, item };
}
