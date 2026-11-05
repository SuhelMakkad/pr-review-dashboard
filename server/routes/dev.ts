import type { FastifyInstance } from 'fastify';
import type { FixtureGitHub } from '../demo/fixture-github.js';
import type { SyncService } from '../sync/service.js';

/** Demo-only controls for stepping the scripted scenario. Never registered against real GitHub. */
export function registerDevRoutes(
  app: FastifyInstance,
  service: SyncService,
  fixture: FixtureGitHub,
): void {
  app.post('/api/dev/advance', async () => {
    const label = fixture.advance();

    if (label) await service.sync();

    return { label };
  });

  app.get('/api/dev/writes', async () => ({ writes: fixture.writes }));

  app.post<{ Body: { op?: string } }>('/api/dev/fail', async (request) => {
    fixture.failNext = typeof request.body?.op === 'string' ? request.body.op : null;

    return { failNext: fixture.failNext };
  });

  app.post('/api/dev/reset', async () => {
    fixture.reset();
    service.store.clearAccount(fixture.scenario.world.viewer.login);
    await service.sync();

    return { ok: true };
  });
}
