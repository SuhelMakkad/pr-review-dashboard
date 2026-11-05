import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { safeError } from '../github/errors.js';
import { ReviewError, type ReviewService } from '../review/service.js';

const account = z.string().min(1).max(100);
const body = z.string().trim().min(1).max(65_536);
const side = z.enum(['LEFT', 'RIGHT']);
const event = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
const line = z.number().int().positive().nullable();

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
  submit: z
    .object({
      account,
      event,
      body: z.string().max(65_536),
      expectedHeadOid: z.string().min(7).max(64),
      allowNewHead: z.boolean().optional(),
    })
    .strict(),
  now: newComment.extend({ path: z.string().max(1000) }).strict(),
  reply: z.object({ account, prId: z.string().min(1), body }).strict(),
  resolve: z.object({ account, prId: z.string().min(1), resolved: z.boolean() }).strict(),
  viewed: z.object({ account, path: z.string().min(1).max(1000), viewed: z.boolean() }).strict(),
  reviewers: z
    .object({
      account,
      logins: z
        .array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/))
        .min(1)
        .max(15),
    })
    .strict(),
};

async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
  try {
    return (await work()) ?? { ok: true };
  } catch (error) {
    if (error instanceof ReviewError) {
      return reply
        .code(error.status)
        .send({ error: error.message, code: error.code, ...error.details });
    }

    if (error instanceof Error && error.message === 'ACCOUNT_CHANGED') {
      return reply.code(409).send({
        error: 'GitHub account changed. Refresh before writing.',
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

export function registerReviewRoutes(app: FastifyInstance, reviews: ReviewService): void {
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
    const input = parse(schemas.accountOnly, request.body, reply);

    return input && handle(reply, () => reviews.discard(input.account, request.params.id));
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

    return input && handle(reply, () => reviews.submit(request.params.id, input));
  });

  app.post<IdParams>('/api/pulls/:id/comments', async (request, reply) => {
    const input = parse(schemas.now, request.body, reply);

    return input && handle(reply, () => reviews.commentNow(request.params.id, input));
  });

  app.post<IdParams>('/api/pulls/:id/viewed', async (request, reply) => {
    const input = parse(schemas.viewed, request.body, reply);

    return (
      input &&
      handle(reply, () =>
        reviews.setViewed(input.account, request.params.id, input.path, input.viewed),
      )
    );
  });

  app.post<IdParams>('/api/pulls/:id/reviewers', async (request, reply) => {
    const input = parse(schemas.reviewers, request.body, reply);

    return (
      input &&
      handle(reply, () => reviews.requestReviewers(input.account, request.params.id, input.logins))
    );
  });

  app.post<{ Params: { threadId: string } }>(
    '/api/threads/:threadId/replies',
    async (request, reply) => {
      const input = parse(schemas.reply, request.body, reply);

      return (
        input &&
        handle(reply, () =>
          reviews.reply(input.account, input.prId, request.params.threadId, input.body),
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
        handle(reply, () =>
          reviews.resolve(input.account, input.prId, request.params.threadId, input.resolved),
        )
      );
    },
  );
}
