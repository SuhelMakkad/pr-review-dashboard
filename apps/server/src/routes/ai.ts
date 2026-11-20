import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AutoReviewer } from '@/ai/auto-review.js';
import type { AiRunner } from '@/ai/runner.js';
import { AccountUnavailable } from '@/forge/account.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { legacyAccountError } from '@/review/errors.js';
import { input, scopedRoutes } from '@/routes/scoped.js';
import type { SyncService } from '@/sync/service.js';
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
      approveFindings: z.boolean().optional(),
      resolveThreads: z.boolean().optional(),
    }),
  }),
  // Only the switches you changed: a save never resends, and so never restores, the others.
  automation: z.strictObject({
    account,
    changes: z
      .strictObject({
        autoReview: z.boolean().optional(),
        postFindings: z.boolean().optional(),
        approveFindings: z.boolean().optional(),
        resolveThreads: z.boolean().optional(),
      })
      .refine((changes) => Object.keys(changes).length > 0, 'Nothing to change.'),
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

/**
 * Runs `work`. A refusal keeps its details (a draft's revision, both accounts' names). On an
 * account's own routes (`scoped`), a forge read that failed answers as forge reads do: the
 * account unavailable, or rate limited until when. The legacy routes keep their answer for an
 * account not in use (`ACCOUNT_CHANGED`) until they go.
 */
async function handle(
  reply: FastifyReply,
  work: () => Promise<unknown> | unknown,
  scoped: string | null = null,
) {
  try {
    return (await work()) ?? { ok: true };
  } catch (raw) {
    const error = scoped === null ? legacyAccountError(raw) : raw;

    if (error instanceof ReviewError)
      return reply.code(error.status).send({
        ...error.details,
        error: error.message,
        code: error.code,
      });

    if (scoped !== null && error instanceof AccountUnavailable)
      return reply.code(409).send({ error: error.message, code: error.code });

    if (scoped !== null && error instanceof GitHubError && error.outcome === 'rate_limit')
      return reply
        .code(429)
        .send({ error: safeError(error), code: 'RATE_LIMITED', retryAt: error.retryAt });

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
  sync: SyncService,
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
        // Agents and tasks only. Automation and posting are saved one switch at a time below: a
        // page with older settings must never turn back on what you turned off elsewhere.
        const { defaultProvider, tasks } = input.settings;

        return runner.saveSettings({ defaultProvider, tasks });
      })
    );
  });

  app.put('/api/ai/automation', async (request, reply) => {
    const input = parse(schemas.automation, request.body, reply);

    return (
      input &&
      handle(reply, () => {
        const saved = runner.saveAutomation(input.changes);

        autoReviewer.settingsSaved(input.account);

        return saved;
      })
    );
  });

  const serve = scopedRoutes(app, sync);

  /** Restarts wait for the account in use; another account's show as paused until it is. */
  const restartOf = (account: string, prId: string) => ({
    restartAt: autoReviewer.restarts(account).get(prId) ?? null,
    ...(autoReviewer.pausedRestarts(account).has(prId) ? { restartPaused: true } : {}),
  });

  serve('get', '/api/ai/reviews', async (request, reply, scoped) =>
    handle(
      reply,
      () => {
        const account = scoped ?? String(request.query.account ?? '');
        const restarts = autoReviewer.restarts(account);
        const paused = autoReviewer.pausedRestarts(account);
        const reviews: AiReviewStatus[] = runner.reviewStatuses(account).map((review) => ({
          ...review,
          restartAt: restarts.get(review.prId) ?? null,
          ...(paused.has(review.prId) ? { restartPaused: true } : {}),
        }));
        const listed = new Set(reviews.map((review) => review.prId));

        // New commits stopped the first automatic review before it had a run.
        for (const prId of new Set([...restarts.keys(), ...paused])) {
          if (listed.has(prId)) continue;

          reviews.push({
            prId,
            runId: null,
            status: null,
            stale: false,
            trigger: 'auto',
            ...restartOf(account, prId),
          });
        }

        return { reviews };
      },
      scoped,
    ),
  );

  serve('get', '/api/pulls/:id/ai', async (request, reply, scoped) =>
    handle(
      reply,
      () => {
        const account = scoped ?? String(request.query.account ?? '');
        const response: AiRunsResponse = {
          runs: runner.runs(account, request.params.id!),
          ...restartOf(account, request.params.id!),
        };

        return response;
      },
      scoped,
    ),
  );

  serve('post', '/api/pulls/:id/ai', async (request, reply, scoped) => {
    const body = input(schemas.start, request, reply, scoped);

    return (
      body &&
      handle(reply, () => runner.start(body.account, request.params.id!, body.task, body), scoped)
    );
  });

  // Stopping a run changes nothing on the forge: any account's own runs can be stopped.
  serve('delete', '/api/ai/runs/:runId', async (request, reply, scoped) => {
    const body = input(schemas.cancel, request, reply, scoped);

    return body && handle(reply, () => runner.cancel(body.account, request.params.runId!), scoped);
  });

  serve('post', '/api/ai/runs/:runId/pause', async (request, reply, scoped) => {
    const body = input(schemas.cancel, request, reply, scoped);

    return body && handle(reply, () => runner.pause(body.account, request.params.runId!), scoped);
  });

  serve('post', '/api/ai/runs/:runId/resume', async (request, reply, scoped) => {
    const body = input(schemas.cancel, request, reply, scoped);

    return body && handle(reply, () => runner.resume(body.account, request.params.runId!), scoped);
  });

  serve('post', '/api/ai/runs/:runId/accept', async (request, reply, scoped) => {
    const body = input(schemas.accept, request, reply, scoped);

    return (
      body &&
      handle(
        reply,
        () => runner.accept(body.account, request.params.runId!, body.index, body.body),
        scoped,
      )
    );
  });

  serve('post', '/api/ai/runs/:runId/draft', async (request, reply, scoped) => {
    const body = input(schemas.prepare, request, reply, scoped);

    return (
      body &&
      handle(
        reply,
        () => runner.prepareReview(body.account, request.params.runId!, body.indices, body),
        scoped,
      )
    );
  });

  serve('post', '/api/ai/runs/:runId/summary', async (request, reply, scoped) => {
    const body = input(schemas.cancel, request, reply, scoped);

    return (
      body && handle(reply, () => runner.applySummary(body.account, request.params.runId!), scoped)
    );
  });
}
