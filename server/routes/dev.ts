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
}
