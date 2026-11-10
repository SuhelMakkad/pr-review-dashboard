import type { FastifyInstance } from 'fastify';
import type { AiRunner } from '@/ai/runner.js';
import type { Notifier } from '@/notify/notifier.js';
import type { FixtureProvider } from '@/ai/fixture.js';
import { DEMO_SECOND_ACCOUNT, type FixtureGitHub } from '@/demo/fixture-github.js';
import { seedDemoQueue } from '@/demo/history.js';
import type { LinearService } from '@/linear/service.js';
import { SELECTED_ACCOUNT_KEY, type SyncService } from '@/sync/service.js';
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
  app.post('/api/dev/advance', async () => {
    const label = fixture.advance();

    if (label) await service.sync();

    return { label };
  });

  app.get('/api/dev/writes', async () => ({ writes: fixture.writes }));

  app.post<{ Body: { op?: string; ai?: string; after?: boolean } }>(
    '/api/dev/fail',
    async (request) => {
      if (request.body?.after)
        fixture.loseResponseNext = typeof request.body.op === 'string' ? request.body.op : null;
      else fixture.failNext = typeof request.body?.op === 'string' ? request.body.op : null;

      if (typeof request.body?.ai === 'string') {
        for (const provider of Object.values(runner.providers)) {
          if (provider.demo) (provider as FixtureProvider).failNext = request.body.ai;
        }
      }

      return { failNext: fixture.failNext };
    },
  );

  app.post<{ Body: { delayMs?: number } }>('/api/dev/operations', async (request, reply) => {
    const delay = request.body?.delayMs;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 5000)
      return reply.code(400).send({ error: 'delayMs must be between 0 and 5000.' });

    fixture.writeDelayMs = delay;

    return { delayMs: fixture.writeDelayMs };
  });

  app.post('/api/dev/reset', async () => {
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

    for (const key of [
      'notification-settings',
      'ai-settings',
      'review-sla-hours',
      SELECTED_ACCOUNT_KEY,
      `status:${DEMO_SECOND_ACCOUNT}`,
      ...logins.flatMap((login) => [`backfill:${login}`, `auto-review-primed:${login}`]),
    ]) {
      service.store.deleteSetting(key);
    }

    seedDemoQueue(service.store, fixture.scenario.world.viewer.login, Date.now());
    await service.sync();
    operations.resume();

    return { ok: true };
  });
}
