import type { GitHubAction } from '@review-desk/shared/operations';
import { routes } from '@review-desk/shared/contract';
import type { FastifyInstance } from 'fastify';
import { ABANDONED } from '@/db/draft-writes.js';
import { parseAttemptId, provable, sealOf } from '@/db/claim-ids.js';
import { draftVersionsOf, type WriteFence } from '@/db/versions.js';
import {
  attemptOf,
  claimed,
  fenceFor,
  idConflict,
  invalidAttempt,
  type WriteGuard,
} from '@/routes/claims.js';
import { say } from '@/messages.js';
import { safeError } from '@/github/errors.js';
import { failed, ok, serve, type Failed } from '@/http/serve.js';
import { ReviewError, type ReviewService } from '@/review/service.js';
import type { OperationQueue } from '@/operations/queue.js';
import { readFailure } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

/** A refusal with its code and details; anything else, the server's. */
function reviewFailure(error: unknown): Failed {
  if (error instanceof ReviewError)
    return failed(error.status, { error: error.wording, code: error.code, ...error.details });

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

  const store = sync.store;
  /** A draft write under its guard: claimed by its id, fenced by its base (see `claims.ts`). */
  const guarded = <B extends object>(
    account: string,
    prId: string,
    body: WriteGuard,
    request: unknown,
    run: (fence: WriteFence) => Promise<B>,
  ) =>
    claimed(
      store,
      {
        account,
        prId,
        kind: 'write',
        guard: {
          writeId: body.writeId,
          baseRevision: body.baseRevision,
          baseGeneration: body.baseGeneration,
        },
        request,
        current: () => reviews.draft(account, prId),
      },
      run,
      reviewFailure,
    ) as never;

  /**
   * Refuses a first admission (a submit or discard) unless the draft is still the one the user
   * acted on: with the draft it changed into, so the web can show it.
   */
  const assertBase = (account: string, prId: string, base: WriteGuard) => {
    try {
      fenceFor(store, account, prId, base).check();
    } catch (error) {
      if (!(error instanceof ReviewError)) throw error;

      // The draft and its versions from one read, in the admitting transaction.
      const draft = reviews.draft(account, prId);

      throw new ReviewError(error.code, error.status, error.wording, {
        ...error.details,
        ...(draft.versions
          ? { revision: draft.versions.revision, generation: draft.versions.generation }
          : {}),
        draft,
      });
    }
  };

  serve(
    app,
    routes.saveDraft,
    ({ params, body }) =>
      guarded(
        body.account,
        params.id,
        body,
        { route: 'saveDraft', prId: params.id, body },
        (fence) =>
          reviews.saveDraft(body.account, params.id, { body: body.body, event: body.event }, fence),
      ),
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

      // Admitted only for the draft the user acted on: checked in the transaction that clears or
      // locks it.
      const fence = () => assertBase(discard.account, prId, discard);

      // Nothing on the forge: cleared at once, in this turn, never calling it, with a receipt.
      if (
        queue.writeLocally(
          discard.account,
          prId,
          discard.operationId,
          { type: 'discard', reviewId: '' },
          discard,
          () => {
            fence();

            return reviews.clearLocal(discard.account, prId);
          },
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
          fence,
        ),
      );
    },
    serving,
  );

  serve(
    app,
    routes.addComment,
    ({ params, body }) => {
      const { writeId: _id, baseRevision: _base, baseGeneration: _generation, ...input } = body;

      return guarded(
        body.account,
        params.id,
        body,
        { route: 'addComment', prId: params.id, body },
        (fence) => reviews.addComment(params.id, input, { fence }),
      );
    },
    serving,
  );

  serve(
    app,
    routes.editComment,
    ({ params, body }) =>
      guarded(
        body.account,
        params.id,
        body,
        { route: 'editComment', prId: params.id, cid: params.cid, body },
        (fence) => reviews.updateComment(body.account, params.id, params.cid, body.body, fence),
      ),
    serving,
  );

  serve(
    app,
    routes.deleteComment,
    ({ params, body }) =>
      guarded(
        body.account,
        params.id,
        body,
        { route: 'deleteComment', prId: params.id, cid: params.cid, body },
        async (fence) => {
          await reviews.deleteComment(body.account, params.id, params.cid, fence);

          return { ok: true as const };
        },
      ),
    serving,
  );

  serve(
    app,
    routes.draftAttempt,
    ({ account, params, query }) => {
      const parsed = parseAttemptId(params.attemptId, account, store.draftWrites.secret());

      if (parsed.kind === 'invalid') return invalidAttempt();

      // One read: the claim, else whether a late arrival could still commit at that base, and
      // whether its history proves it never arrived.
      const answer = store.transaction(() => {
        const claim = store.draftWrites.find(account, params.attemptId);

        if (claim) {
          // Another PR's, or another kind's: never this attempt's answer.
          if (claim.prId !== params.id || (query.kind && claim.kind !== query.kind)) return null;

          return {
            attempt: {
              ...attemptOf(claim),
              ...(claim.state === 'pending' ? {} : { result: claim.result }),
            },
          };
        }

        // Fenced once the draft has moved past the base: a base it has not reached yet could
        // still be met, and the write commit then.
        const versions = draftVersionsOf(store, account, params.id);
        const fenced =
          query.base !== undefined &&
          (versions.revision > query.base ||
            (query.generation !== undefined && versions.generation > query.generation));

        return {
          arrived: false as const,
          fenced,
          provable: provable(parsed, store.draftWrites.watermarkOf(account)),
        };
      });

      return answer ? ok(200, answer) : idConflict();
    },
    serving,
  );

  serve(
    app,
    routes.claimCheckpoint,
    ({ account }) => {
      const checkpoint = store.draftWrites.checkpoint();

      return ok(200, {
        checkpoint,
        seal: sealOf(store.draftWrites.secret(), account, checkpoint),
      });
    },
    serving,
  );

  // Stops waiting for an attempt: answered by its claim if it was received, else never admitted.
  serve(
    app,
    routes.abandonDraftAttempt,
    ({ account, params, body }) => {
      const parsed = parseAttemptId(params.attemptId, account, store.draftWrites.secret());

      if (parsed.kind === 'invalid') return invalidAttempt();

      // In one turn with any claim of the id: received already (its state answers), or never after.
      const answer = store.transaction(() => {
        const claim = store.draftWrites.find(account, params.attemptId);

        if (claim) {
          if (claim.prId !== params.id || claim.kind !== body.kind) return null;
          if (claim.state === 'pending') return { outcome: 'pending' as const };

          // A stop answered before: its decision again.
          if (claim.fingerprint === ABANDONED) {
            const decision = (claim.result as { body?: { decision?: string } }).body?.decision;

            return {
              outcome:
                decision === 'not-admitted' ? ('not-admitted' as const) : ('unknown' as const),
            };
          }

          return {
            outcome: claim.state,
            attempt: { ...attemptOf(claim), result: claim.result },
          };
        }

        const decision = provable(parsed, store.draftWrites.watermarkOf(account))
          ? ('not-admitted' as const)
          : ('unknown' as const);

        store.draftWrites.abandon({
          account,
          id: params.attemptId,
          prId: params.id,
          kind: body.kind,
          decision,
          createdAt: new Date().toISOString(),
        });

        return { outcome: decision };
      });

      return answer ? ok(200, answer) : idConflict();
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

      // Admitted only for the draft the user acted on, and the pending review it showed (the one
      // frozen into the action: the draft's own before the forge's), in the admitting transaction.
      const fence = () => {
        assertBase(submit.account, prId, submit);

        if (
          submit.expectedPendingReviewId !== undefined &&
          submit.expectedPendingReviewId !== frozen.githubReviewId
        )
          throw new ReviewError(
            'PENDING_REVIEW_CHANGED',
            409,
            say('outbox.pending-review-changed'),
            {
              draft: reviews.draft(submit.account, prId),
            },
          );
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
          fence,
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
        throw new ReviewError('NOT_FOUND', 404, say('pull.untracked'));
      if (!shown()) throw new ReviewError('NOT_FOUND', 404, say('pull.thread-elsewhere'));
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
