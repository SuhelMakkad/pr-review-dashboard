import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AutoReviewer } from '@/ai/auto-review.js';
import type { AiRunner } from '@/ai/runner.js';
import { safeError } from '@/github/errors.js';
import { ReviewError } from '@/review/service.js';
import {
  defaultAiSettings,
  type AiReviewStatus,
  type AiRunsResponse,
} from '@review-desk/shared/ai';

const account = z.string().min(1).max(100);
const provider = z.enum(['codex', 'claude']);
const task = z.enum([
  'full_review',
  'brief',
  'since_review',
  'draft_comments',
  'author_feedback',
  'draft_summary',
]);
const effort = z.enum(['low', 'medium', 'high', 'xhigh']);
const taskSettings = z.strictObject({
  provider: provider.nullable(),
  effort,
  model: z.string().max(100).nullable(),
});

const schemas = {
  settings: z.strictObject({
    account,
    settings: z.strictObject({
      defaultProvider: provider,
      tasks: z.strictObject({
        full_review: taskSettings.optional().default(defaultAiSettings().tasks.full_review),
        brief: taskSettings,
        since_review: taskSettings,
        draft_comments: taskSettings,
        author_feedback: taskSettings,
        draft_summary: taskSettings,
      }),
      // `since` is set by the server; a value sent back from the client is ignored.
      autoReview: z
        .strictObject({ enabled: z.boolean(), since: z.string().max(40).nullable().optional() })
        .optional(),
      // Optional so a window opened before the setting existed keeps its saved value.
      postFindings: z.boolean().optional(),
    }),
  }),
  start: z.strictObject({
    account,
    task,
    provider: provider.optional(),
    force: z.boolean().optional(),
  }),
  cancel: z.strictObject({ account }),
  accept: z.strictObject({
    account,
    index: z.number().int().min(0),
    body: z.string().trim().min(1).max(65_536).optional(),
  }),
  prepare: z
    .strictObject({
      account,
      indices: z.array(z.number().int().min(0)).max(100),
      replace: z.boolean().optional(),
      expectedDraftRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .refine((value) => !value.replace || Boolean(value.expectedDraftRevision)),
};

async function handle(reply: FastifyReply, work: () => Promise<unknown> | unknown) {
  try {
    return (await work()) ?? { ok: true };
  } catch (error) {
    if (error instanceof ReviewError)
      return reply.code(error.status).send({
        ...error.details,
        error: error.message,
        code: error.code,
      });

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

export function registerAiRoutes(
  app: FastifyInstance,
  runner: AiRunner,
  autoReviewer: AutoReviewer,
): void {
  app.get('/api/ai', async () => {
    const [providers, codex] = await Promise.all([runner.providerStatuses(), runner.codexStatus()]);

    return { settings: runner.settings(), providers, codex };
  });

  app.put('/api/ai/settings', async (request, reply) => {
    const input = parse(schemas.settings, request.body, reply);

    return (
      input &&
      handle(reply, () => {
        const saved = runner.saveSettings(input.settings);

        autoReviewer.settingsSaved(input.account);

        return saved;
      })
    );
  });

  app.get<{ Querystring: { account?: string } }>('/api/ai/reviews', async (request, reply) =>
    handle(reply, () => {
      const account = String(request.query.account ?? '');
      const restarts = autoReviewer.restarts(account);
      const reviews: AiReviewStatus[] = runner
        .reviewStatuses(account)
        .map((review) => ({ ...review, restartAt: restarts.get(review.prId) ?? null }));
      const listed = new Set(reviews.map((review) => review.prId));

      // New commits stopped the first automatic review before it had a run.
      for (const [prId, restartAt] of restarts) {
        if (listed.has(prId)) continue;

        reviews.push({ prId, runId: null, status: null, stale: false, trigger: 'auto', restartAt });
      }

      return { reviews };
    }),
  );

  app.get<{ Params: { id: string }; Querystring: { account?: string } }>(
    '/api/pulls/:id/ai',
    async (request, reply) =>
      handle(reply, () => {
        const account = String(request.query.account ?? '');
        const response: AiRunsResponse = {
          runs: runner.runs(account, request.params.id),
          restartAt: autoReviewer.restarts(account).get(request.params.id) ?? null,
        };

        return response;
      }),
  );

  app.post<{ Params: { id: string } }>('/api/pulls/:id/ai', async (request, reply) => {
    const input = parse(schemas.start, request.body, reply);

    return (
      input &&
      handle(reply, () => runner.start(input.account, request.params.id, input.task, input))
    );
  });

  app.delete<{ Params: { runId: string } }>('/api/ai/runs/:runId', async (request, reply) => {
    const input = parse(schemas.cancel, request.body, reply);

    return input && handle(reply, () => runner.cancel(input.account, request.params.runId));
  });

  app.post<{ Params: { runId: string } }>('/api/ai/runs/:runId/pause', async (request, reply) => {
    const input = parse(schemas.cancel, request.body, reply);

    return input && handle(reply, () => runner.pause(input.account, request.params.runId));
  });

  app.post<{ Params: { runId: string } }>('/api/ai/runs/:runId/resume', async (request, reply) => {
    const input = parse(schemas.cancel, request.body, reply);

    return input && handle(reply, () => runner.resume(input.account, request.params.runId));
  });

  app.post<{ Params: { runId: string } }>('/api/ai/runs/:runId/accept', async (request, reply) => {
    const input = parse(schemas.accept, request.body, reply);

    return (
      input &&
      handle(reply, () =>
        runner.accept(input.account, request.params.runId, input.index, input.body),
      )
    );
  });

  app.post<{ Params: { runId: string } }>('/api/ai/runs/:runId/draft', async (request, reply) => {
    const input = parse(schemas.prepare, request.body, reply);

    return (
      input &&
      handle(reply, () =>
        runner.prepareReview(input.account, request.params.runId, input.indices, input),
      )
    );
  });

  app.post<{ Params: { runId: string } }>('/api/ai/runs/:runId/summary', async (request, reply) => {
    const input = parse(schemas.cancel, request.body, reply);

    return input && handle(reply, () => runner.applySummary(input.account, request.params.runId));
  });
}
