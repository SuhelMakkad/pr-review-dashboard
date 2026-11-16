import { createHash } from 'node:crypto';
import type { ReviewDraft } from '@review-desk/shared/review';
import type { PullRequestSnapshot } from '@review-desk/shared/types';

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Opens every AI review the dashboard posts, so it can recognise its own comments later. */
export const postedReviewMarker = (runId: string) => `<!-- review-desk:ai-review run=${runId} -->`;

const postedReviewPrefix = '<!-- review-desk:ai-review ';

/**
 * Ignore refresh times, viewed files and checks: they do not change the review's evidence. Neither
 * does an AI review this account posted from a run: it repeats that run, so it is not new
 * discussion, and counting it would mark the review it came from out of date.
 */
export function reviewFingerprint(pr: PullRequestSnapshot, account: string): string {
  const posted = (comment: PullRequestSnapshot['conversation'][number]) =>
    comment.author.login.toLowerCase() === account.toLowerCase() &&
    comment.body.startsWith(postedReviewPrefix);

  return fingerprint({
    baseOid: pr.baseOid,
    headOid: pr.headOid,
    title: pr.title,
    body: pr.body,
    reviews: pr.reviews,
    threads: pr.threads,
    conversation: pr.conversation.filter((comment) => !posted(comment)),
    requests: pr.requestEvents,
  });
}

export function draftFingerprint(draft: ReviewDraft): string {
  return fingerprint({
    event: draft.event,
    comments: draft.comments
      .filter((comment) => comment.status !== 'stale')
      .map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        anchorOid: comment.anchorOid,
      })),
  });
}
