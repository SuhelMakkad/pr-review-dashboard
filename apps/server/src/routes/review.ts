import { forForge } from '@review-desk/shared/accounts';
import type { GitHubAction } from '@review-desk/shared/operations';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { safeError } from '@/github/errors.js';
import { legacyAccountError } from '@/review/errors.js';
import { ReviewError, type ReviewService } from '@/review/service.js';
import type { OperationQueue } from '@/operations/queue.js';
import { knownAccount, readError, type AccountParams } from '@/routes/pulls.js';
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

/**
 * Runs `work`, answering its refusal in the account's forge's words. The legacy routes keep their
 * answer for an account not in use (`ACCOUNT_CHANGED`) until they go.
 */
async function handle(
  reply: FastifyReply,
  account: string,
  scoped: string | null,
  work: () => Promise<unknown>,
) {
  const worded = (text: string) => forForge(text, account);

  try {
    return (await work()) ?? { ok: true };
  } catch (raw) {
    const error = scoped === null ? legacyAccountError(raw) : raw;

    if (error instanceof ReviewError) {
      return reply
        .code(error.status)
        .send({ error: worded(error.message), code: error.code, ...error.details });
    }

    if (error instanceof Error && error.message === 'ACCOUNT_CHANGED') {
      return reply.code(409).send({
        error: worded('GitHub account changed. Refresh before writing.'),
        code: 'ACCOUNT_CHANGED',
      });
    }

    return reply.code(500).send({ error: safeError(error) });
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(value);

  if (!result.success) {
    void reply.code(400).send({ error: 'Invalid request.', details: z.flattenError(result.error) });
    return null;
  }

  return result.data;
}

type Request = FastifyRequest<{
  Params: Record<string, string>;
  Querystring: Record<string, string | undefined>;
}>;

/**
 * The request a route parses, with its account: from the body on a legacy route, from the path
 * on an account's own (`scoped`), where the body must not name one. Both give exactly the same
 * object, so an action ID accepted through one is replayed through the other.
 */
function input<T>(
  schema: z.ZodType<T>,
  request: Request,
  reply: FastifyReply,
  scoped: string | null,
): T | null {
  if (scoped === null) return parse(schema, request.body, reply);

  const body = request.body ?? {};

  if (typeof body !== 'object' || Array.isArray(body) || 'account' in body) {
    void reply.code(400).send({ error: 'Invalid request: the path names the account.' });
    return null;
  }

  return parse(schema, { ...body, account: scoped }, reply);
}

export function registerReviewRoutes(
  app: FastifyInstance,
  reviews: ReviewService,
  queue: OperationQueue,
  sync: SyncService,
): void {
  /**
   * Serves `path` twice: as the legacy route, whose request names the account, and under
   * `/api/accounts/:account`, whose path does. `work` gets the path's account, or null on the
   * legacy route.
   */
  function serve(
    method: 'get' | 'put' | 'post' | 'patch' | 'delete',
    path: string,
    work: (request: Request, reply: FastifyReply, scoped: string | null) => Promise<unknown>,
  ) {
    app[method](path, (request, reply) => work(request as Request, reply, null));
    app[method](`/api/accounts/:account${path.slice('/api'.length)}`, (request, reply) => {
      const account = knownAccount(sync, request.params as AccountParams, reply);

      return account ? work(request as Request, reply, account) : reply;
    });
  }

  serve('get', '/api/pulls/:id/draft', async (request, reply, scoped) => {
    const account = scoped ?? String(request.query.account ?? '');

    return handle(reply, account, scoped, async () => reviews.draft(account, request.params.id));
  });

  serve('put', '/api/pulls/:id/draft', async (request, reply, scoped) => {
    const draft = input(schemas.draft, request, reply, scoped);

    return (
      draft &&
      handle(reply, draft.account, scoped, () =>
        reviews.saveDraft(draft.account, request.params.id, draft),
      )
    );
  });

  serve('delete', '/api/pulls/:id/draft', async (request, reply, scoped) => {
    const discard = input(schemas.discard, request, reply, scoped);
    const prId = request.params.id;

    return (
      discard &&
      handle(reply, discard.account, scoped, async () => {
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

  serve('post', '/api/pulls/:id/draft/comments', async (request, reply, scoped) => {
    const comment = input(schemas.comment, request, reply, scoped);

    return (
      comment &&
      handle(reply, comment.account, scoped, () => reviews.addComment(request.params.id, comment))
    );
  });

  serve('patch', '/api/pulls/:id/draft/comments/:cid', async (request, reply, scoped) => {
    const edit = input(schemas.edit, request, reply, scoped);

    return (
      edit &&
      handle(reply, edit.account, scoped, () =>
        reviews.updateComment(edit.account, request.params.id, request.params.cid!, edit.body),
      )
    );
  });

  serve('delete', '/api/pulls/:id/draft/comments/:cid', async (request, reply, scoped) => {
    const target = input(schemas.accountOnly, request, reply, scoped);

    return (
      target &&
      handle(reply, target.account, scoped, () =>
        reviews.deleteComment(target.account, request.params.id, request.params.cid!),
      )
    );
  });

  serve('post', '/api/pulls/:id/review', async (request, reply, scoped) => {
    const submit = input(schemas.submit, request, reply, scoped);
    const prId = request.params.id;

    return (
      submit &&
      handle(reply, submit.account, scoped, async () => {
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

  serve('post', '/api/pulls/:id/comments', async (request, reply, scoped) => {
    const comment = input(schemas.now, request, reply, scoped);

    return (
      comment &&
      handle(reply, comment.account, scoped, async () =>
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

  serve('post', '/api/pulls/:id/viewed', async (request, reply, scoped) => {
    const viewed = input(schemas.viewed, request, reply, scoped);

    return (
      viewed &&
      handle(reply, viewed.account, scoped, async () =>
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

  serve('post', '/api/pulls/:id/reviewers', async (request, reply, scoped) => {
    const reviewers = input(schemas.reviewers, request, reply, scoped);

    return (
      reviewers &&
      handle(reply, reviewers.account, scoped, async () =>
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
    scoped: string | null,
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

    return handle(reply, account, scoped, async () => {
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

  serve('post', '/api/threads/:threadId/replies', async (request, reply, scoped) => {
    const answer = input(schemas.reply, request, reply, scoped);

    return (
      answer &&
      onThread(reply, scoped, answer, {
        type: 'reply',
        threadId: request.params.threadId!,
        body: answer.body,
      })
    );
  });

  serve('post', '/api/threads/:threadId/resolution', async (request, reply, scoped) => {
    const resolution = input(schemas.resolve, request, reply, scoped);

    return (
      resolution &&
      onThread(reply, scoped, resolution, {
        type: 'resolve',
        threadId: request.params.threadId!,
        resolved: resolution.resolved,
      })
    );
  });
}
