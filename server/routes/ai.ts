import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AiRunner } from '../ai/runner.js';
import { safeError } from '../github/errors.js';
import { ReviewError } from '../review/service.js';
import { defaultAiSettings } from '../../shared/ai.js';

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
  prepare: z.strictObject({ account, indices: z.array(z.number().int().min(0)).max(100) }),
};

async function handle(reply: FastifyReply, work: () => Promise<unknown> | unknown) {
  try {
    return (await work()) ?? { ok: true };
  } catch (error) {
    if (error instanceof ReviewError)
      return reply.code(error.status).send({ error: error.message, code: error.code });

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

export function registerAiRoutes(app: FastifyInstance, runner: AiRunner): void {
  app.get('/api/ai', async () => {
    const [providers, codex] = await Promise.all([runner.providerStatuses(), runner.codexStatus()]);

    return { settings: runner.settings(), providers, codex };
  });

  app.put('/api/ai/settings', async (request, reply) => {
    const input = parse(schemas.settings, request.body, reply);

    return input && handle(reply, () => runner.saveSettings(input.settings));
  });

  app.get<{ Params: { id: string }; Querystring: { account?: string } }>(
    '/api/pulls/:id/ai',
    async (request, reply) =>
      handle(reply, () => ({
        runs: runner.runs(String(request.query.account ?? ''), request.params.id),
      })),
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
      handle(reply, () => runner.prepareReview(input.account, request.params.runId, input.indices))
    );
  });
}
