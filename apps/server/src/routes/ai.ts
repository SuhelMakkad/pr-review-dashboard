import type { FastifyInstance } from 'fastify';
import type { AutoReviewer } from '@/ai/auto-review.js';
import type { AiRunner } from '@/ai/runner.js';
import { AccountUnavailable } from '@/forge/account.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { failed, ok, serve, type Failed } from '@/http/serve.js';
import type { SyncService } from '@/sync/service.js';
import { ReviewError } from '@/review/service.js';
import type { AiReviewStatus } from '@review-desk/shared/ai';
import { routes } from '@review-desk/shared/contract';

/**
 * A refusal keeps its details (a draft's revision, both accounts' names), and a forge read that
 * failed answers as forge reads do: the account unavailable, or rate limited until when.
 */
function aiFailure(error: unknown): Failed {
  if (error instanceof ReviewError)
    return failed(error.status, { ...error.details, error: error.message, code: error.code });

  if (error instanceof AccountUnavailable)
    return failed(409, { error: error.message, code: error.code });

  if (error instanceof GitHubError && error.outcome === 'rate_limit')
    return failed(429, { error: safeError(error), code: 'RATE_LIMITED', retryAt: error.retryAt });

  return failed(500, { error: safeError(error) });
}

export function registerAiRoutes(
  app: FastifyInstance,
  runner: AiRunner,
  autoReviewer: AutoReviewer,
  sync: SyncService,
): void {
  const serving = { sync, errors: aiFailure };
  const done = () => ok(200, { ok: true as const });

  serve(
    app,
    routes.ai,
    async () => {
      const [providers, codex] = await Promise.all([
        runner.providerStatuses(),
        runner.codexStatus(),
      ]);

      return ok(200, { settings: runner.settings(), providers, codex });
    },
    // A probe that fails is the server's own failure, as it always was.
    { sync },
  );

  serve(
    app,
    routes.aiSettings,
    ({ body }) => {
      // Agents and tasks only. Automation and posting are saved one switch at a time below: a
      // page with older settings must never turn back on what you turned off elsewhere.
      const { defaultProvider, tasks } = body.settings;

      return ok(200, runner.saveSettings({ defaultProvider, tasks }));
    },
    serving,
  );

  serve(
    app,
    routes.aiAutomation,
    ({ body }) => {
      const saved = runner.saveAutomation(body.changes);

      autoReviewer.settingsSaved(body.account);

      return ok(200, saved);
    },
    serving,
  );

  /** Restarts wait for the account in use; another account's show as paused until it is. */
  const restartOf = (account: string, prId: string) => ({
    restartAt: autoReviewer.restarts(account).get(prId) ?? null,
    ...(autoReviewer.pausedRestarts(account).has(prId) ? { restartPaused: true } : {}),
  });

  serve(
    app,
    routes.aiReviews,
    ({ account }) => {
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

      return ok(200, { reviews });
    },
    serving,
  );

  serve(
    app,
    routes.aiRuns,
    ({ account, params }) =>
      ok(200, { runs: runner.runs(account, params.id), ...restartOf(account, params.id) }),
    serving,
  );

  serve(
    app,
    routes.startAi,
    async ({ params, body }) =>
      ok(200, await runner.start(body.account, params.id, body.task, body)),
    serving,
  );

  // Stopping a run changes nothing on the forge: any account's own runs can be stopped.
  serve(
    app,
    routes.cancelAi,
    ({ params, body }) => {
      runner.cancel(body.account, params.runId);

      return done();
    },
    serving,
  );

  serve(
    app,
    routes.pauseAi,
    ({ params, body }) => {
      runner.pause(body.account, params.runId);

      return done();
    },
    serving,
  );

  serve(
    app,
    routes.resumeAi,
    async ({ params, body }) => ok(200, await runner.resume(body.account, params.runId)),
    serving,
  );

  serve(
    app,
    routes.acceptAi,
    async ({ params, body }) =>
      ok(200, await runner.accept(body.account, params.runId, body.index, body.body)),
    serving,
  );

  serve(
    app,
    routes.prepareAi,
    async ({ params, body }) =>
      ok(200, await runner.prepareReview(body.account, params.runId, body.indices, body)),
    serving,
  );

  serve(
    app,
    routes.applyAi,
    async ({ params, body }) => ok(200, await runner.applySummary(body.account, params.runId)),
    serving,
  );
}
