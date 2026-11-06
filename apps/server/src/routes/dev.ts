import type { FastifyInstance } from 'fastify';
import type { AiRunner } from '../ai/runner.js';
import type { Notifier } from '../notify/notifier.js';
import type { FixtureProvider } from '../ai/fixture.js';
import type { FixtureGitHub } from '../demo/fixture-github.js';
import { seedDemoQueue } from '../demo/history.js';
import type { LinearService } from '../linear/service.js';
import type { SyncService } from '../sync/service.js';

/** Demo-only controls for stepping the scripted scenario. Never registered against real GitHub. */
export function registerDevRoutes(
  app: FastifyInstance,
  service: SyncService,
  fixture: FixtureGitHub,
  runner: AiRunner,
  notifier: Notifier,
  linear: LinearService,
): void {
  app.post('/api/dev/advance', async () => {
    const label = fixture.advance();

    if (label) await service.sync();

    return { label };
  });

  app.get('/api/dev/writes', async () => ({ writes: fixture.writes }));

  app.post<{ Body: { op?: string; ai?: string } }>('/api/dev/fail', async (request) => {
    fixture.failNext = typeof request.body?.op === 'string' ? request.body.op : null;

    if (typeof request.body?.ai === 'string') {
      for (const provider of Object.values(runner.providers)) {
        if (provider.demo) (provider as FixtureProvider).failNext = request.body.ai;
      }
    }

    return { failNext: fixture.failNext };
  });

  app.post('/api/dev/reset', async () => {
    // Let an in-flight sync finish first, so it cannot write old state after the reset.
    await service.sync();

    fixture.reset();
    service.store.clearAccount(fixture.scenario.world.viewer.login);
    notifier.reset(fixture.scenario.world.viewer.login);
    linear.reset();

    for (const key of [
      'notification-settings',
      'ai-settings',
      'review-sla-hours',
      `backfill:${fixture.scenario.world.viewer.login}`,
    ]) {
      service.store.deleteSetting(key);
    }

    seedDemoQueue(service.store, fixture.scenario.world.viewer.login, Date.now());
    await service.sync();

    return { ok: true };
  });
}
