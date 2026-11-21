import type { FastifyInstance } from 'fastify';
import { devRoutes } from '@review-desk/shared/contract';
import { failed, ok, serve } from '@/http/serve.js';
import type { AiRunner } from '@/ai/runner.js';
import type { Notifier } from '@/notify/notifier.js';
import type { FixtureProvider } from '@/ai/fixture.js';
import { DEMO_SECOND_ACCOUNT, type FixtureGitHub } from '@/demo/fixture-github.js';
import { seedDemoQueue } from '@/demo/history.js';
import type { LinearService } from '@/linear/service.js';
import {
  AI_SETTINGS,
  AUTO_REVIEW_PRIMED,
  BACKFILL,
  NOTIFICATION_SETTINGS,
  REVIEW_SLA_HOURS,
  SELECTED_ACCOUNT,
  STATUS,
} from '@/db/settings.js';
import type { SyncService } from '@/sync/service.js';
import type { OperationQueue } from '@/operations/queue.js';

/** Demo-only controls for stepping the scripted scenario. Never registered against real GitHub. */
export function registerDevRoutes(
  app: FastifyInstance,
  service: SyncService,
  fixture: FixtureGitHub,
  runner: AiRunner,
  notifier: Notifier,
  linear: LinearService,
  operations: OperationQueue,
): void {
  const serving = { sync: service };

  serve(
    app,
    devRoutes.advance,
    async () => {
      const label = fixture.advance();

      if (label) await service.sync();

      return ok(200, { label });
    },
    serving,
  );

  serve(app, devRoutes.writes, () => ok(200, { writes: fixture.writes }), serving);

  // An omitted body is fine: each field is checked on its own, as the controls send them.
  serve(
    app,
    devRoutes.fail,
    ({ request }) => {
      const body = request.body as { op?: unknown; ai?: unknown; after?: unknown } | undefined;

      if (body?.after) fixture.loseResponseNext = typeof body.op === 'string' ? body.op : null;
      else fixture.failNext = typeof body?.op === 'string' ? body.op : null;

      if (typeof body?.ai === 'string') {
        for (const provider of Object.values(runner.providers)) {
          if (provider.demo) (provider as FixtureProvider).failNext = body.ai;
        }
      }

      return ok(200, { failNext: fixture.failNext });
    },
    serving,
  );

  serve(
    app,
    devRoutes.operations,
    ({ request }) => {
      const delay = (request.body as { delayMs?: unknown } | undefined)?.delayMs;

      if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 5000)
        return failed(400, { error: 'delayMs must be between 0 and 5000.' });

      fixture.writeDelayMs = delay;

      return ok(200, { delayMs: fixture.writeDelayMs });
    },
    serving,
  );

  serve(
    app,
    devRoutes.reset,
    async () => {
      await operations.pause();
      // Let an in-flight sync finish first, so it cannot write old state after the reset.
      await service.sync();

      // Back to the scenario's own account; the next sync notices the change.
      fixture.reset();
      linear.reset();

      const logins = [fixture.scenario.world.viewer.login, DEMO_SECOND_ACCOUNT];

      for (const login of logins) {
        service.store.clearAccount(login);
        notifier.reset(login);
      }

      // The last account, the primary account's status and both write cooldowns stay.
      for (const setting of [
        NOTIFICATION_SETTINGS,
        AI_SETTINGS,
        REVIEW_SLA_HOURS,
        SELECTED_ACCOUNT,
        STATUS.of(DEMO_SECOND_ACCOUNT),
        ...logins.flatMap((login) => [BACKFILL.of(login), AUTO_REVIEW_PRIMED.of(login)]),
      ]) {
        service.store.settings.delete(setting);
      }

      seedDemoQueue(service.store, fixture.scenario.world.viewer.login, Date.now());
      await service.sync();
      operations.resume();

      return ok(200, { ok: true as const });
    },
    serving,
  );
}
