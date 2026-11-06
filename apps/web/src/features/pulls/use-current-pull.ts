import { useParams } from '@tanstack/react-router';
import type { PullRequestItem } from '@review-desk/shared/types';
import { sameRef, type PrRef } from '../../lib/pr-ref';
import { useMine, usePulls } from '../../lib/queries';

/** The PR named by the current route, if any (inbox reading pane or PR pages). */
export function useRouteRef(): PrRef | null {
  const params = useParams({ strict: false }) as { owner?: string; repo?: string; number?: string };
  const number = Number(params.number);

  return params.owner && params.repo && Number.isInteger(number)
    ? { owner: params.owner, repo: params.repo, number }
    : null;
}

/**
 * Resolves the route's PR from the reviewer inbox, or from your own PRs. Authored PRs are adapted
 * to the inbox item shape (they never carry review reasons).
 */
export function useCurrentPull(): {
  ref: PrRef | null;
  item: PullRequestItem | null;
  authored: boolean;
} {
  const ref = useRouteRef();
  const pulls = usePulls();
  const mine = useMine();
  const reviewing = ref
    ? (pulls.data?.items.find((candidate) => sameRef(candidate, ref)) ?? null)
    : null;

  if (reviewing || !ref) return { ref, item: reviewing, authored: false };

  const own = mine.data?.items.find((candidate) => sameRef(candidate, ref));

  if (!own) return { ref, item: null, authored: false };

  return {
    ref,
    authored: true,
    item: {
      id: own.id,
      number: own.number,
      title: own.title,
      url: own.url,
      repository: own.repository,
      author: { login: mine.data?.account ?? '' },
      isDraft: own.isDraft,
      additions: own.additions,
      deletions: own.deletions,
      changedFiles: own.changedFiles,
      updatedAt: own.updatedAt,
      fetchedAt: own.updatedAt,
      ci: own.ci,
      sources: ['authored'],
      requestedVia: [],
      latestReview: null,
      unresolvedThreads: own.unresolvedThreads,
      reasons: [],
      queue: 'caught_up',
      attentionAt: own.updatedAt,
      activityKeys: [],
      unreadReplyKeys: [],
      hasNote: own.hasNote,
      snoozedUntil: null,
      doneAt: null,
      createdAt: own.createdAt,
      headRefName: own.headRefName,
      tickets: own.tickets,
    },
  };
}
