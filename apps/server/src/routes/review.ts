import { forForge } from '@review-desk/shared/accounts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { safeError } from '@/github/errors.js';
import { ReviewError, type ReviewService } from '@/review/service.js';
import type { OperationQueue } from '@/operations/queue.js';

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
    .object({ account, path: z.string().min(1).max(1000), viewed: z.boolean(), operationId })
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

async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
  // Messages are written for GitHub; a GitLab account's read as GitLab's.
  const request = reply.request as { body?: unknown; query?: unknown };
  const account =
    (request.body as { account?: string } | undefined)?.account ??
    (request.query as { account?: string } | undefined)?.account;
  const worded = (text: string) => forForge(text, account);

  try {
    return (await work()) ?? { ok: true };
  } catch (error) {
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

type IdParams = { Params: { id: string } };

export function registerReviewRoutes(
  app: FastifyInstance,
  reviews: ReviewService,
  queue: OperationQueue,
): void {
  app.get<IdParams & { Querystring: { account?: string } }>(
    '/api/pulls/:id/draft',
    async (request, reply) =>
      handle(reply, async () =>
        reviews.draft(String(request.query.account ?? ''), request.params.id),
      ),
  );

  app.put<IdParams>('/api/pulls/:id/draft', async (request, reply) => {
    const input = parse(schemas.draft, request.body, reply);

    return input && handle(reply, () => reviews.saveDraft(input.account, request.params.id, input));
  });

  app.delete<IdParams>('/api/pulls/:id/draft', async (request, reply) => {
    const input = parse(schemas.discard, request.body, reply);

    return (
      input &&
      handle(reply, async () => {
        const replay = queue.find(input.account, input.operationId);
        if (replay)
          return reply
            .code(202)
            .send(
              queue.enqueue(
                input.account,
                request.params.id,
                input.operationId,
                replay.action,
                input,
              ),
            );

        const draft = reviews.drafts.draft(input.account, request.params.id);
        if (!draft?.githubReviewId) {
          await reviews.discard(input.account, request.params.id);
          return { ok: true };
        }

        return reply
          .code(202)
          .send(
            queue.enqueue(
              input.account,
              request.params.id,
              input.operationId,
              { type: 'discard', reviewId: draft.githubReviewId },
              input,
            ),
          );
      })
    );
  });

  app.post<IdParams>('/api/pulls/:id/draft/comments', async (request, reply) => {
    const input = parse(schemas.comment, request.body, reply);

    return input && handle(reply, () => reviews.addComment(request.params.id, input));
  });

  app.patch<{ Params: { id: string; cid: string } }>(
    '/api/pulls/:id/draft/comments/:cid',
    async (request, reply) => {
      const input = parse(schemas.edit, request.body, reply);

      return (
        input &&
        handle(reply, () =>
          reviews.updateComment(input.account, request.params.id, request.params.cid, input.body),
        )
      );
    },
  );

  app.delete<{ Params: { id: string; cid: string } }>(
    '/api/pulls/:id/draft/comments/:cid',
    async (request, reply) => {
      const input = parse(schemas.accountOnly, request.body, reply);

      return (
        input &&
        handle(reply, () =>
          reviews.deleteComment(input.account, request.params.id, request.params.cid),
        )
      );
    },
  );

  app.post<IdParams>('/api/pulls/:id/review', async (request, reply) => {
    const input = parse(schemas.submit, request.body, reply);

    return (
      input &&
      handle(reply, async () => {
        reviews.assertVerdictSupported(input.account, input.event);

        const draft = reviews.drafts.draft(input.account, request.params.id);
        const pending = reviews.draft(input.account, request.params.id).githubPendingReview;
        const frozen = {
          body: input.body,
          event: input.event,
          comments: draft?.comments ?? [],
          githubReviewId: draft?.githubReviewId ?? pending?.id ?? null,
        };

        return reply.code(202).send(
          queue.enqueue(
            input.account,
            request.params.id,
            input.operationId,
            {
              type: 'review',
              review: {
                account: input.account,
                event: input.event,
                body: input.body,
                expectedHeadOid: input.expectedHeadOid,
              },
              draft: frozen,
            },
            input,
          ),
        );
      })
    );
  });

  app.post<IdParams>('/api/pulls/:id/comments', async (request, reply) => {
    const input = parse(schemas.now, request.body, reply);

    return (
      input &&
      handle(reply, async () =>
        reply
          .code(202)
          .send(
            queue.enqueue(
              input.account,
              request.params.id,
              input.operationId,
              { type: 'comment', comment: input, expectedHeadOid: input.expectedHeadOid },
              input,
            ),
          ),
      )
    );
  });

  app.post<IdParams>('/api/pulls/:id/viewed', async (request, reply) => {
    const input = parse(schemas.viewed, request.body, reply);

    return (
      input &&
      handle(reply, async () =>
        reply
          .code(202)
          .send(
            queue.enqueue(
              input.account,
              request.params.id,
              input.operationId,
              { type: 'viewed', path: input.path, viewed: input.viewed },
              input,
            ),
          ),
      )
    );
  });

  app.post<IdParams>('/api/pulls/:id/reviewers', async (request, reply) => {
    const input = parse(schemas.reviewers, request.body, reply);

    return (
      input &&
      handle(reply, async () =>
        reply
          .code(202)
          .send(
            queue.enqueue(
              input.account,
              request.params.id,
              input.operationId,
              { type: 'reviewers', logins: input.logins },
              input,
            ),
          ),
      )
    );
  });

  app.post<{ Params: { threadId: string } }>(
    '/api/threads/:threadId/replies',
    async (request, reply) => {
      const input = parse(schemas.reply, request.body, reply);

      return (
        input &&
        handle(reply, async () =>
          reply
            .code(202)
            .send(
              queue.enqueue(
                input.account,
                input.prId,
                input.operationId,
                { type: 'reply', threadId: request.params.threadId, body: input.body },
                input,
              ),
            ),
        )
      );
    },
  );

  app.post<{ Params: { threadId: string } }>(
    '/api/threads/:threadId/resolution',
    async (request, reply) => {
      const input = parse(schemas.resolve, request.body, reply);

      return (
        input &&
        handle(reply, async () =>
          reply
            .code(202)
            .send(
              queue.enqueue(
                input.account,
                input.prId,
                input.operationId,
                { type: 'resolve', threadId: request.params.threadId, resolved: input.resolved },
                input,
              ),
            ),
        )
      );
    },
  );
}
