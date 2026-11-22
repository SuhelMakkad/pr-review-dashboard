import type { FastifyInstance } from 'fastify';
import type { DiffMode } from '@review-desk/shared/diff';
import { say } from '@/messages.js';
import { PatchAborted } from '@/diff/patch-pool.js';
import type { DiffService } from '@/diff/service.js';
import type { PullRequestDetail } from '@review-desk/shared/types';
import { routes } from '@review-desk/shared/contract';
import { failed, ok, serve } from '@/http/serve.js';
import { readFailure } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

export function registerDiffRoutes(
  app: FastifyInstance,
  service: SyncService,
  diffs: DiffService,
): void {
  const diff = async (detail: PullRequestDetail, mode: DiffMode, signal: AbortSignal) => {
    // A build nobody waits for any more stops reading, and publishes nothing.
    const manifest = await diffs.manifest(
      detail.snapshot,
      mode,
      detail.item.latestReview?.commitOid ?? null,
      detail.account,
      undefined,
      signal,
    );

    // Viewed state and "since your review" are this account's, so the reply says whose it is.
    return { ...manifest, account: detail.account };
  };
  serve(
    app,
    routes.diff,
    async ({ account, params, query, request }) => {
      const detail = service.detailFor(account, params.id);

      if (!detail) return failed(404, { error: say('pull.untracked') });

      // Only the diff's own reads answer as failed reads; anything else is the server's own failure.
      try {
        return ok(200, await diff(detail, query.mode ?? 'full', request.signal));
      } catch (error) {
        // The client went away: no one reads this answer, and no read failed.
        if (error instanceof PatchAborted)
          return failed(499, { error: 'The request ended before its diff was ready.' });

        return readFailure(error);
      }
    },
    { sync: service },
  );
}
