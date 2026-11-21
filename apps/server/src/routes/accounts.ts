import type { FastifyInstance } from 'fastify';
import { routes } from '@review-desk/shared/contract';
import { failed, ok, serve } from '@/http/serve.js';
import { GitHubError, safeError } from '@/github/errors.js';
import type { OperationQueue } from '@/operations/queue.js';
import { ReviewError } from '@/review/errors.js';
import type { SyncService } from '@/sync/service.js';

/** Lists the GitHub CLI's accounts and switches between them without `gh auth switch`. */
export function registerAccountRoutes(
  app: FastifyInstance,
  service: SyncService,
  operations: OperationQueue,
): void {
  const serving = { sync: service };

  serve(
    app,
    routes.accounts,
    async () => {
      if (!service.accounts) return ok(200, { switchable: false, accounts: [] });

      try {
        const current = service.status.account?.login.toLowerCase() ?? null;
        const accounts = await service.accounts.list();

        return ok(200, {
          switchable: true,
          accounts: accounts.map((account) => ({
            ...account,
            current: account.login.toLowerCase() === current,
            inProgress: operations.inProgress(account.login),
          })),
        });
      } catch (error) {
        return failed(502, { error: safeError(error), code: 'GITHUB_ERROR' });
      }
    },
    serving,
  );

  serve(
    app,
    routes.switchAccount,
    async ({ body }) => {
      // An action being sent finishes first. The previous account's other actions wait for it.
      const release = await operations.hold();

      try {
        return ok(200, await service.switchAccount(body.from, body.to));
      } catch (error) {
        if (error instanceof ReviewError)
          return failed(error.status, { error: error.wording, code: error.code });
        if (error instanceof GitHubError)
          return failed(502, { error: safeError(error), code: 'GITHUB_ERROR' });

        throw error;
      } finally {
        release();
      }
    },
    serving,
  );
}
