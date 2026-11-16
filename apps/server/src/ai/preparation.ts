import { createHash } from 'node:crypto';
import type { DraftComment, PrepareReviewOptions, ReviewDraft } from '@review-desk/shared/review';
import { ReviewError } from '@/review/errors.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function preparedCommentFingerprint(comment: DraftComment): string {
  return hash([
    comment.path,
    comment.line,
    comment.side,
    comment.startLine,
    comment.startSide,
    comment.subjectType,
    comment.body,
    comment.origin,
    comment.anchorOid,
  ]);
}

/** Includes summary edits and ownership, unlike the evidence fingerprint used by AI summaries. */
export function preparationRevision(draft: ReviewDraft): string {
  return hash({
    body: draft.body,
    event: draft.event,
    comments: draft.comments.map((comment) => [
      comment.id,
      preparedCommentFingerprint(comment),
      comment.status,
      comment.githubThreadId ?? null,
    ]),
    preparedReview: draft.preparedReview ?? null,
    pendingReview: draft.githubPendingReview,
    operationId: draft.activeOperationId ?? null,
  });
}

export function draftChanged(): ReviewError {
  return new ReviewError(
    'DRAFT_CHANGED',
    409,
    'This draft changed while preparing the review. Check the saved draft and try again.',
  );
}

/** Plan a replacement without modifying the draft. The caller applies it in one transaction. */
export function planPreparation(
  draft: ReviewDraft,
  summary: string,
  options: PrepareReviewOptions,
) {
  const previous = draft.preparedReview;
  const content = previous?.content;
  const owned = content
    ? draft.comments.filter((comment) => content.comments.some((item) => item.id === comment.id))
    : previous
      ? draft.comments.filter((comment) => comment.origin === 'ai')
      : [];

  if (
    previous &&
    (draft.githubPendingReview || owned.some((comment) => comment.status === 'pushed'))
  )
    throw new ReviewError(
      'PENDING_REVIEW',
      409,
      'Finish or discard the pending GitHub review before replacing this prepared review.',
    );

  const start = content ? draft.body.indexOf(content.summary) : -1;
  const summaryIntact = Boolean(
    content && start !== -1 && start === draft.body.lastIndexOf(content.summary),
  );
  const commentsIntact = owned.every(
    (comment) =>
      content?.comments.find((item) => item.id === comment.id)?.fingerprint ===
      preparedCommentFingerprint(comment),
  );
  const needsConfirmation = Boolean(previous && (!content || !summaryIntact || !commentsIntact));

  if (options.replace && options.expectedDraftRevision !== preparationRevision(draft))
    throw draftChanged();

  if (needsConfirmation && !options.replace)
    throw new ReviewError(
      'PREPARED_REVIEW_EDITED',
      409,
      content
        ? 'Your prepared review has edits. Replacing it will save the current draft before updating its summary and selected findings. Independent comments stay.'
        : 'This draft was prepared by an older version. Replacing it will save the current draft before updating its summary and AI comments. Manually added comments stay.',
      { draftRevision: preparationRevision(draft) },
    );

  const body = !previous
    ? draft.body.includes(summary)
      ? draft.body
      : summary.startsWith(draft.body)
        ? summary
        : [draft.body, summary].filter(Boolean).join('\n\n')
    : summaryIntact
      ? draft.body.slice(0, start) + summary + draft.body.slice(start + content!.summary.length)
      : summary;
  const previousDrafts = [...(previous?.previousDrafts ?? [])];

  if (needsConfirmation)
    previousDrafts.push({
      body: draft.body,
      comments: draft.comments,
      savedAt: new Date().toISOString(),
    });

  return { body, removeIds: owned.map((comment) => comment.id), previousDrafts };
}
