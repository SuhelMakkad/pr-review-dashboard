import { forForge } from '@review-desk/shared/accounts';
import type { GitHubAction } from '@review-desk/shared/operations';
import { routes } from '@review-desk/shared/contract';
import type { FastifyInstance } from 'fastify';
import { safeError } from '@/github/errors.js';
import { failed, ok, serve, type Failed } from '@/http/serve.js';
import { ReviewError, type ReviewService } from '@/review/service.js';
import type { OperationQueue } from '@/operations/queue.js';
import { readFailure } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

/** A refusal in the account's forge's words, with its code and details; anything else, the server's. */
function reviewFailure(error: unknown, account: string): Failed {
  if (error instanceof ReviewError)
    return failed(error.status, {
      error: forForge(error.message, account),
      code: error.code,
      ...error.details,
    });

  return failed(500, { error: safeError(error) });
}

export function registerReviewRoutes(
  app: FastifyInstance,
  reviews: ReviewService,
  queue: OperationQueue,
  sync: SyncService,
): void {
  const serving = { sync, errors: reviewFailure };

  serve(
    app,
    routes.draft,
    ({ account, params }) => ok(200, reviews.draft(account, params.id)),
    serving,
  );

  serve(
    app,
    routes.saveDraft,
    async ({ params, body }) => ok(200, await reviews.saveDraft(body.account, params.id, body)),
    serving,
  );

  serve(
    app,
    routes.discard,
    ({ params, body: discard }) => {
      const prId = params.id;
      const expected = { prId, request: discard, type: 'discard' as const };

      // A local discard of this ID answers as it did, before anything else is checked or touched.
      if (queue.replayedLocally(discard.account, discard.operationId, expected))
        return ok(200, { ok: true as const });

      const replay = queue.replay(discard.account, discard.operationId, expected);

      if (replay) return ok(202, replay);

      // Nothing on the forge: cleared at once, in this turn, never calling it, with a receipt.
      if (
        queue.writeLocally(
          discard.account,
          prId,
          discard.operationId,
          { type: 'discard', reviewId: '' },
          discard,
          () => reviews.clearLocal(discard.account, prId),
        )
      )
        return ok(200, { ok: true as const });

      const reviewId = reviews.drafts.draft(discard.account, prId)!.githubReviewId!;

      return ok(
        202,
        queue.enqueue(
          discard.account,
          prId,
          discard.operationId,
          { type: 'discard', reviewId },
          discard,
        ),
      );
    },
    serving,
  );

  serve(
    app,
    routes.addComment,
    async ({ params, body }) => ok(200, await reviews.addComment(params.id, body)),
    serving,
  );

  serve(
    app,
    routes.editComment,
    async ({ params, body }) =>
      ok(200, await reviews.updateComment(body.account, params.id, params.cid, body.body)),
    serving,
  );

  serve(
    app,
    routes.deleteComment,
    async ({ params, body }) => {
      await reviews.deleteComment(body.account, params.id, params.cid);

      return ok(200, { ok: true as const });
    },
    serving,
  );

  serve(
    app,
    routes.submit,
    ({ params, body: submit }) => {
      const prId = params.id;
      // A retry of an accepted review returns its receipt, whatever has changed since.
      const replay = queue.replay(submit.account, submit.operationId, {
        prId,
        request: submit,
        type: 'review',
      });

      if (replay) return ok(202, replay);

      reviews.assertSelected(submit.account);
      reviews.assertVerdictSupported(submit.account, submit.event);

      const draft = reviews.drafts.draft(submit.account, prId);
      const pending = reviews.draft(submit.account, prId).githubPendingReview;
      const frozen = {
        body: submit.body,
        event: submit.event,
        comments: draft?.comments ?? [],
        githubReviewId: draft?.githubReviewId ?? pending?.id ?? null,
      };

      return ok(
        202,
        queue.enqueue(
          submit.account,
          prId,
          submit.operationId,
          {
            type: 'review',
            review: {
              account: submit.account,
              event: submit.event,
              body: submit.body,
              expectedHeadOid: submit.expectedHeadOid,
            },
            draft: frozen,
          },
          submit,
        ),
      );
    },
    serving,
  );

  serve(
    app,
    routes.commentNow,
    ({ params, body: comment }) =>
      ok(
        202,
        queue.enqueue(
          comment.account,
          params.id,
          comment.operationId,
          { type: 'comment', comment, expectedHeadOid: comment.expectedHeadOid },
          comment,
        ),
      ),
    serving,
  );

  serve(
    app,
    routes.viewed,
    ({ params, body: viewed }) =>
      ok(
        202,
        queue.enqueue(
          viewed.account,
          params.id,
          viewed.operationId,
          {
            type: 'viewed',
            path: viewed.path,
            viewed: viewed.viewed,
            ...(viewed.target ? { target: viewed.target } : {}),
          },
          viewed,
        ),
      ),
    serving,
  );

  serve(
    app,
    routes.reviewers,
    ({ params, body: reviewers }) =>
      ok(
        202,
        queue.enqueue(
          reviewers.account,
          params.id,
          reviewers.operationId,
          { type: 'reviewers', logins: reviewers.logins },
          reviewers,
        ),
      ),
    serving,
  );

  /**
   * Queues a reply or resolution on a thread of the request's PR. A replay is answered first; a
   * thread the stored PR does not show yet is looked for once more in a fresh read, after which
   * the replay and the account in use are checked again, since the read was awaited. A read that
   * failed answers as a failed read does.
   */
  async function onThread(
    request: { account: string; prId: string; operationId: string },
    action: Extract<GitHubAction, { type: 'reply' | 'resolve' }>,
  ) {
    const { account, prId, operationId } = request;
    const admit = () => {
      const replay = queue.replay(account, operationId, {
        prId,
        request,
        type: action.type,
        threadId: action.threadId,
      });

      if (!replay) reviews.assertSelected(account);

      return replay;
    };
    const shown = () =>
      sync.detailFor(account, prId)?.snapshot.threads.some(({ id }) => id === action.threadId);
    const replay = admit();

    if (replay) return ok(202, replay);

    if (!shown()) {
      let failure: { error: unknown } | null = null;

      await sync.refresh(prId, account).catch((error: unknown) => {
        failure = { error };
      });

      const late = admit();

      if (late) return ok(202, late);
      if (failure) return readFailure((failure as { error: unknown }).error);

      if (!sync.detailFor(account, prId))
        throw new ReviewError('NOT_FOUND', 404, 'This PR is no longer tracked.');
      if (!shown()) throw new ReviewError('NOT_FOUND', 404, 'That thread is not on this PR.');
    }

    return ok(202, queue.enqueue(account, prId, operationId, action, request));
  }

  serve(
    app,
    routes.reply,
    ({ params, body: answer }) =>
      onThread(answer, { type: 'reply', threadId: params.threadId, body: answer.body }),
    serving,
  );

  serve(
    app,
    routes.resolve,
    ({ params, body: resolution }) =>
      onThread(resolution, {
        type: 'resolve',
        threadId: params.threadId,
        resolved: resolution.resolved,
      }),
    serving,
  );
}
