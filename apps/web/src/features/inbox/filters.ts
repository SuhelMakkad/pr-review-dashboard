import { z } from 'zod';
import type { PullRequestItem } from '../../../../../packages/shared/src/types';

/** Queue filters live in the URL so views are shareable and survive reloads and Back. */
export const inboxSearchSchema = z.object({
  q: z.string().max(200).optional().catch(undefined),
  repo: z.string().max(200).optional().catch(undefined),
  author: z.string().max(100).optional().catch(undefined),
  reason: z
    .enum(['first_review', 'changed', 'requested_again', 'reply', 'mention', 'dismissed'])
    .optional()
    .catch(undefined),
  ci: z.enum(['success', 'failure', 'pending', 'none']).optional().catch(undefined),
  draft: z.enum(['hide', 'only']).optional().catch(undefined),
});

export type InboxSearch = z.infer<typeof inboxSearchSchema>;

export const activeFilterCount = (search: InboxSearch) =>
  [search.repo, search.author, search.reason, search.ci, search.draft].filter(Boolean).length;

export function matchesFilters(item: PullRequestItem, search: InboxSearch): boolean {
  if (search.repo && item.repository !== search.repo) return false;
  if (search.author && item.author.login !== search.author) return false;
  if (search.reason && !item.reasons.some((reason) => reason.kind === search.reason)) return false;
  if (search.ci && item.ci !== search.ci) return false;
  if (search.draft === 'hide' && item.isDraft) return false;
  if (search.draft === 'only' && !item.isDraft) return false;

  if (search.q) {
    const haystack =
      `${item.title} #${item.number} ${item.repository} ${item.author.login} ${item.headRefName}`.toLowerCase();

    return search.q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => haystack.includes(term.replace(/^#/, '#')));
  }

  return true;
}
