import type { FastifyInstance } from 'fastify';
import type { DiffMode } from '@review-desk/shared/diff';
import type { DiffService } from '@/diff/service.js';
import type { PullRequestDetail } from '@review-desk/shared/types';
import { knownAccount, readError, type AccountParams } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

export function registerDiffRoutes(
  app: FastifyInstance,
  service: SyncService,
  diffs: DiffService,
): void {
  const diff = async (detail: PullRequestDetail, mode: DiffMode) => {
    const manifest = await diffs.manifest(
      detail.snapshot,
      mode,
      detail.item.latestReview?.commitOid ?? null,
      detail.account,
    );

    // Viewed state and "since your review" are this account's, so the reply says whose it is.
    return { ...manifest, account: detail.account };
  };
  const modeOf = (mode?: string): DiffMode => (mode === 'since-review' ? 'since-review' : 'full');

  app.get<{ Params: AccountParams & { id: string }; Querystring: { mode?: string } }>(
    '/api/accounts/:account/pulls/:id/diff',
    async (request, reply) => {
      const account = knownAccount(service, request.params, reply);

      if (!account) return reply;

      const detail = service.detailFor(account, request.params.id);

      if (!detail) return reply.code(404).send({ error: 'This PR is no longer tracked.' });

      try {
        return await diff(detail, modeOf(request.query.mode));
      } catch (error) {
        return readError(reply, error);
      }
    },
  );
}
