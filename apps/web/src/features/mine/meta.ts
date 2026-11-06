import type { AuthorGroup, AuthorItem, BlockerKind } from '@review-desk/shared/author';

export const groupMeta: Record<AuthorGroup, { label: string; hint: string }> = {
  needs_you: { label: 'Needs you', hint: 'Something only you can unblock.' },
  waiting: {
    label: 'Waiting on reviewers',
    hint: 'Your move is done; reviewers or checks are next.',
  },
  ready: { label: 'Ready to merge', hint: 'Approved and passing.' },
  draft: { label: 'Drafts', hint: 'Not yet ready for review.' },
};

export const groupOrder: AuthorGroup[] = ['needs_you', 'waiting', 'ready', 'draft'];

export const blockerTone: Record<BlockerKind, string> = {
  ci_failing: 'fail',
  conflicts: 'fail',
  behind: 'pending',
  changes_requested: 'rerequest',
  unanswered_threads: 'reply',
  no_reviewers: 'first',
  awaiting_review: 'neutral',
  ci_pending: 'pending',
  blocked: 'neutral',
};

/** Review-time target used to flag long waits on reviewers. */
export const SLA_HOURS = 24;

export function waitState(
  item: Pick<AuthorItem, 'waitingSince'>,
  now = Date.now(),
): { hours: number; tone: 'ok' | 'pending' | 'fail' } | null {
  if (!item.waitingSince) return null;

  const hours = Math.floor((now - Date.parse(item.waitingSince)) / 3_600_000);

  return { hours, tone: hours >= SLA_HOURS * 2 ? 'fail' : hours >= SLA_HOURS ? 'pending' : 'ok' };
}
