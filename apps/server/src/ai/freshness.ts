import { createHash } from 'node:crypto';
import { isSameUser } from '@review-desk/shared/accounts';
import type { ReviewDraft } from '@review-desk/shared/review';
import type { PullRequestSnapshot } from '@review-desk/shared/types';

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Identifies each automatically posted approval or conversation comment. */
export const postedReviewMarker = (runId: string) => `<!-- review-desk:ai-review run=${runId} -->`;

const postedReviewPrefix = '<!-- review-desk:ai-review ';

/**
 * Ignore refresh times, viewed files and checks: they do not change the review's evidence. Neither
 * does an AI review this account posted from a run: it repeats that run, so it is not new
 * discussion, and counting it would mark the review it came from out of date.
 */
export function reviewFingerprint(pr: PullRequestSnapshot, account: string): string {
  const posted = (comment: PullRequestSnapshot['conversation'][number]) =>
    isSameUser(comment.author.login, account) && comment.body.startsWith(postedReviewPrefix);

  return fingerprint({
    baseOid: pr.baseOid,
    headOid: pr.headOid,
    title: pr.title,
    body: pr.body,
    reviews: pr.reviews.filter((review) => !review.body.startsWith(postedReviewPrefix)),
    threads: pr.threads,
    conversation: pr.conversation.filter((comment) => !posted(comment)),
    requests: pr.requestEvents,
  });
}

/**
 * What an automatic post of run `runId` as `account` rests on: the reviewed diff and every
 * review, verdict, comment and thread, including other runs' posts. Only this run's own post is
 * left out (a comment of `account`'s carrying its marker; reviews are only ever `account`'s own),
 * as are `account`'s own verdicts, which its approval changes. Threads it resolved (with the
 * forge's acknowledgement) count as they were reviewed while they stay resolved: a thread
 * reopened after that is new discussion. Fields that follow the viewer's rights (`viewerCan*`),
 * which resolving changes, are left out.
 */
export function publicationFingerprint(
  pr: PullRequestSnapshot,
  runId: string,
  account: string,
  resolved: ReadonlySet<string> = new Set(),
): string {
  const marker = postedReviewMarker(runId);

  return fingerprint({
    headOid: pr.headOid,
    baseOid: pr.baseOid,
    baseRefName: pr.baseRefName,
    title: pr.title,
    body: pr.body,
    requests: pr.requestEvents,
    // What each says, never when it changed: GitLab renews its notes' times when a discussion is
    // resolved, and reviews and verdicts read from those notes take their times from them.
    reviews: pr.reviews
      .filter((review) => !review.body.startsWith(marker))
      .map((review) => ({
        id: review.id,
        state: review.state,
        commitOid: review.commitOid,
        body: review.body,
      })),
    verdicts: (pr.verdicts ?? [])
      .filter((verdict) => !isSameUser(verdict.login, account))
      .map((verdict) => ({
        login: verdict.login,
        state: verdict.state,
        commitOid: verdict.commitOid,
      })),
    conversation: pr.conversation
      .filter(
        (comment) =>
          !(isSameUser(comment.author.login, account) && comment.body.startsWith(marker)),
      )
      .map((comment) => ({ id: comment.id, author: comment.author.login, body: comment.body })),
    threads: pr.threads.map((thread) => ({
      id: thread.id,
      isResolved: resolved.has(thread.id) && thread.isResolved ? false : thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      // No timestamps here either; an edit changes the body.
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        author: comment.author.login,
        body: comment.body,
      })),
    })),
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
