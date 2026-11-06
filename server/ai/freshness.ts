import { createHash } from 'node:crypto';
import type { ReviewDraft } from '../../shared/review.js';
import type { PullRequestSnapshot } from '../../shared/types.js';

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Ignore refresh times, viewed files and checks: they do not change the review's evidence. */
export function reviewFingerprint(pr: PullRequestSnapshot): string {
  return fingerprint({
    baseOid: pr.baseOid,
    headOid: pr.headOid,
    title: pr.title,
    body: pr.body,
    reviews: pr.reviews,
    threads: pr.threads,
    conversation: pr.conversation,
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
