import { forForge } from '@review-desk/shared/accounts';
import type { GitHubAction } from '@review-desk/shared/operations';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { safeError } from '@/github/errors.js';
import { ReviewError, type ReviewService } from '@/review/service.js';
import type { OperationQueue } from '@/operations/queue.js';
import { readError } from '@/routes/pulls.js';
import { input, scopedRoutes } from '@/routes/scoped.js';
import type { SyncService } from '@/sync/service.js';

const account = z.string().min(1).max(100);
const body = z.string().trim().min(1).max(65_536);
const side = z.enum(['LEFT', 'RIGHT']);
const event = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
const line = z.number().int().positive().nullable();
const operationId = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9-]+$/);

const newComment = z
  .object({
    account,
    path: z.string().min(1).max(1000),
    line,
    side: side.optional(),
    startLine: line.optional(),
    startSide: side.nullable().optional(),
    body,
    origin: z.enum(['user', 'ai']).optional(),
    revision: z
      .object({
        headOid: z.string().min(7).max(64),
        baseOid: z.string().min(7).max(64).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

const schemas = {
  draft: z
    .object({ account, body: z.string().max(65_536).optional(), event: event.optional() })
    .strict(),
  comment: newComment,
  edit: z.object({ account, body }).strict(),
  accountOnly: z.object({ account }).strict(),
  discard: z.object({ account, operationId }).strict(),
  submit: z
    .object({
      account,
      event,
      body: z.string().max(65_536),
      expectedHeadOid: z.string().min(7).max(64),
      allowNewHead: z.boolean().optional(),
      operationId,
    })
    .strict(),
  now: newComment
    .extend({ path: z.string().max(1000), operationId, expectedHeadOid: z.string().min(7).max(64) })
    .strict(),
  reply: z.object({ account, prId: z.string().min(1), body, operationId }).strict(),
  resolve: z
    .object({ account, prId: z.string().min(1), resolved: z.boolean(), operationId })
    .strict(),
  viewed: z
    .object({
      account,
      path: z.string().min(1).max(1000),
      viewed: z.boolean(),
      /** The diff the page showed when you marked the file: its PR head and base, and file key. */
      target: z
        .object({
          headOid: z.string().min(7).max(64),
          baseOid: z.string().min(7).max(64).nullable(),
          fileKey: z.string().min(1).max(200).optional(),
        })
        .strict()
        .optional(),
      operationId,
    })
    .strict(),
  reviewers: z
    .object({
      account,
      operationId,
      logins: z
        // GitHub logins, and GitLab usernames, which can also contain `.` and `_`.
        .array(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/))
        .min(1)
        .max(15),
    })
    .strict(),
};

/** Runs `work`, answering its refusal in the account's forge's words. */
async function handle(reply: FastifyReply, account: string, work: () => Promise<unknown>) {
  const worded = (text: string) => forForge(text, account);

  try {
    return (await work()) ?? { ok: true };
  } catch (error) {
    if (error instanceof ReviewError) {
      return reply
        .code(error.status)
        .send({ error: worded(error.message), code: error.code, ...error.details });
    }

    return reply.code(500).send({ error: safeError(error) });
  }
}

export function registerReviewRoutes(
  app: FastifyInstance,
  reviews: ReviewService,
  queue: OperationQueue,
  sync: SyncService,
): void {
  const serve = scopedRoutes(app, sync);

  serve('get', '/api/pulls/:id/draft', async (request, reply, login) => {
    return handle(reply, login, async () => reviews.draft(login, request.params.id));
  });

  serve('put', '/api/pulls/:id/draft', async (request, reply, login) => {
    const draft = input(schemas.draft, request, reply, login);

    return (
      draft &&
      handle(reply, draft.account, () => reviews.saveDraft(draft.account, request.params.id, draft))
    );
  });

  serve('delete', '/api/pulls/:id/draft', async (request, reply, login) => {
    const discard = input(schemas.discard, request, reply, login);
    const prId = request.params.id;

    return (
      discard &&
      handle(reply, discard.account, async () => {
        const replay = queue.replay(discard.account, discard.operationId, {
          prId,
          request: discard,
          type: 'discard',
        });

        if (replay) return reply.code(202).send(replay);

        // Nothing on the forge: cleared at once, in this turn, never calling it.
        if (reviews.clearLocal(discard.account, prId)) return { ok: true };

        const reviewId = reviews.drafts.draft(discard.account, prId)!.githubReviewId!;

        return reply
          .code(202)
          .send(
            queue.enqueue(
              discard.account,
              prId,
              discard.operationId,
              { type: 'discard', reviewId },
              discard,
            ),
          );
      })
    );
  });

  serve('post', '/api/pulls/:id/draft/comments', async (request, reply, login) => {
    const comment = input(schemas.comment, request, reply, login);

    return (
      comment &&
      handle(reply, comment.account, () => reviews.addComment(request.params.id, comment))
    );
  });

  serve('patch', '/api/pulls/:id/draft/comments/:cid', async (request, reply, login) => {
    const edit = input(schemas.edit, request, reply, login);

    return (
      edit &&
      handle(reply, edit.account, () =>
        reviews.updateComment(edit.account, request.params.id, request.params.cid!, edit.body),
      )
    );
  });

  serve('delete', '/api/pulls/:id/draft/comments/:cid', async (request, reply, login) => {
    const target = input(schemas.accountOnly, request, reply, login);

    return (
      target &&
      handle(reply, target.account, () =>
        reviews.deleteComment(target.account, request.params.id, request.params.cid!),
      )
    );
  });

  serve('post', '/api/pulls/:id/review', async (request, reply, login) => {
    const submit = input(schemas.submit, request, reply, login);
    const prId = request.params.id;

    return (
      submit &&
      handle(reply, submit.account, async () => {
        // A retry of an accepted review returns its receipt, whatever has changed since.
        const replay = queue.replay(submit.account, submit.operationId, {
          prId,
          request: submit,
          type: 'review',
        });

        if (replay) return reply.code(202).send(replay);

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

        return reply.code(202).send(
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
      })
    );
  });

  serve('post', '/api/pulls/:id/comments', async (request, reply, login) => {
    const comment = input(schemas.now, request, reply, login);

    return (
      comment &&
      handle(reply, comment.account, async () =>
        reply
          .code(202)
          .send(
            queue.enqueue(
              comment.account,
              request.params.id,
              comment.operationId,
              { type: 'comment', comment, expectedHeadOid: comment.expectedHeadOid },
              comment,
            ),
          ),
      )
    );
  });

  serve('post', '/api/pulls/:id/viewed', async (request, reply, login) => {
    const viewed = input(schemas.viewed, request, reply, login);

    return (
      viewed &&
      handle(reply, viewed.account, async () =>
        reply.code(202).send(
          queue.enqueue(
            viewed.account,
            request.params.id,
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
      )
    );
  });

  serve('post', '/api/pulls/:id/reviewers', async (request, reply, login) => {
    const reviewers = input(schemas.reviewers, request, reply, login);

    return (
      reviewers &&
      handle(reply, reviewers.account, async () =>
        reply
          .code(202)
          .send(
            queue.enqueue(
              reviewers.account,
              request.params.id,
              reviewers.operationId,
              { type: 'reviewers', logins: reviewers.logins },
              reviewers,
            ),
          ),
      )
    );
  });

  /**
   * Queues a reply or resolution on a thread of the request's PR. A replay is answered first; a
   * thread the stored PR does not show yet is looked for once more in a fresh read, after which
   * the replay and the account in use are checked again, since the read was awaited.
   */
  async function onThread(
    reply: FastifyReply,
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

    return handle(reply, account, async () => {
      const replay = admit();

      if (replay) return reply.code(202).send(replay);

      if (!shown()) {
        let failure: { error: unknown } | null = null;

        await sync.refresh(prId, account).catch((error: unknown) => {
          failure = { error };
        });

        const late = admit();

        if (late) return reply.code(202).send(late);
        if (failure) return readError(reply, (failure as { error: unknown }).error);

        if (!sync.detailFor(account, prId))
          throw new ReviewError('NOT_FOUND', 404, 'This PR is no longer tracked.');
        if (!shown()) throw new ReviewError('NOT_FOUND', 404, 'That thread is not on this PR.');
      }

      return reply.code(202).send(queue.enqueue(account, prId, operationId, action, request));
    });
  }

  serve('post', '/api/threads/:threadId/replies', async (request, reply, login) => {
    const answer = input(schemas.reply, request, reply, login);

    return (
      answer &&
      onThread(reply, answer, {
        type: 'reply',
        threadId: request.params.threadId!,
        body: answer.body,
      })
    );
  });

  serve('post', '/api/threads/:threadId/resolution', async (request, reply, login) => {
    const resolution = input(schemas.resolve, request, reply, login);

    return (
      resolution &&
      onThread(reply, resolution, {
        type: 'resolve',
        threadId: request.params.threadId!,
        resolved: resolution.resolved,
      })
    );
  });
}
