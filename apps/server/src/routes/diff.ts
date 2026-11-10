import type { FastifyInstance } from 'fastify';
import type { DiffMode } from '@review-desk/shared/diff';
import type { DiffService } from '@/diff/service.js';
import { safeError } from '@/github/errors.js';
import type { SyncService } from '@/sync/service.js';

export function registerDiffRoutes(
  app: FastifyInstance,
  service: SyncService,
  diffs: DiffService,
): void {
  app.get<{ Params: { id: string }; Querystring: { mode?: string } }>(
    '/api/pulls/:id/diff',
    async (request, reply) => {
      const detail = service.detail(request.params.id);

      if (!detail) return reply.code(404).send({ error: 'This PR is no longer tracked.' });

      const mode: DiffMode = request.query.mode === 'since-review' ? 'since-review' : 'full';

      try {
        const manifest = await diffs.manifest(
          detail.snapshot,
          mode,
          detail.item.latestReview?.commitOid ?? null,
        );

        // Viewed state and "since your review" are this account's, so the reply says whose it is.
        return { ...manifest, account: detail.account };
      } catch (error) {
        return reply.code(502).send({ error: safeError(error) });
      }
    },
  );
}
