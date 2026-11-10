import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GitHubAccountList } from '@review-desk/shared/types';
import { GitHubError, safeError } from '@/github/errors.js';
import type { OperationQueue } from '@/operations/queue.js';
import { ReviewError } from '@/review/errors.js';
import type { SyncService } from '@/sync/service.js';

const login = z.string().min(1).max(100);
const switchSchema = z.strictObject({ from: login.nullable(), to: login });

/** Lists the GitHub CLI's accounts and switches between them without `gh auth switch`. */
export function registerAccountRoutes(
  app: FastifyInstance,
  service: SyncService,
  operations: OperationQueue,
): void {
  app.get('/api/accounts', async (_request, reply) => {
    if (!service.accounts) return { switchable: false, accounts: [] } satisfies GitHubAccountList;

    try {
      const current = service.status.account?.login.toLowerCase() ?? null;
      const accounts = await service.accounts.list();

      return {
        switchable: true,
        accounts: accounts.map((account) => ({
          ...account,
          current: account.login.toLowerCase() === current,
          inProgress: operations.inProgress(account.login),
        })),
      } satisfies GitHubAccountList;
    } catch (error) {
      return reply.code(502).send({ error: safeError(error), code: 'GITHUB_ERROR' });
    }
  });

  app.post('/api/accounts/switch', async (request, reply) => {
    const parsed = switchSchema.safeParse(request.body);

    if (!parsed.success)
      return reply.code(400).send({
        error: 'Choose an account to switch to.',
        details: z.flattenError(parsed.error),
      });

    // An action being sent finishes first. The previous account's other actions wait for it.
    const release = await operations.hold();

    try {
      return await service.switchAccount(parsed.data.from, parsed.data.to);
    } catch (error) {
      if (error instanceof ReviewError)
        return reply.code(error.status).send({ error: error.message, code: error.code });

      if (error instanceof GitHubError)
        return reply.code(502).send({ error: safeError(error), code: 'GITHUB_ERROR' });

      throw error;
    } finally {
      release();
    }
  });
}
