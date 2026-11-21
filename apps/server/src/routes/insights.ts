import type { FastifyInstance } from 'fastify';
import { routes } from '@review-desk/shared/contract';
import { computeInsights } from '@review-desk/shared/insights';
import type { Backfill } from '@/insights/backfill.js';
import { accountNotActive } from '@/review/errors.js';
import { failed, ok, serve } from '@/http/serve.js';
import type { SyncService } from '@/sync/service.js';

const DAY = 24 * 60 * 60_000;
const SLA_KEY = 'review-sla-hours';

/**
 * Insights: any account's can be read; a history import starts only for the account in use. The
 * review target is shared by every account.
 */
export function registerInsightsRoutes(
  app: FastifyInstance,
  service: SyncService,
  backfill: Backfill,
): void {
  const serving = { sync: service };

  serve(
    app,
    routes.insights,
    ({ account, query }) => {
      const days = query.days ?? 30;
      const slaHours = service.store.getSetting<number>(SLA_KEY) ?? 24;

      // Look back further than the range so requests made just before it still pair with reviews.
      const since = new Date(Date.now() - (days + 30) * DAY).toISOString();
      const events = service.store.activity(account, since);

      return ok(200, {
        insights: computeInsights(events, service.store.queueSamples(account, since), {
          days,
          slaHours,
          repository: query.repo || null,
        }),
        backfill: backfill.state(account),
        slaHours,
        repositories: [...new Set(events.map((event) => event.repository))].sort(),
      });
    },
    serving,
  );

  serve(
    app,
    routes.backfill,
    ({ account }) => {
      const selected = service.status.account?.login ?? null;

      if (account !== selected) {
        const refusal = accountNotActive(account, selected);

        return failed(refusal.status, {
          error: refusal.message,
          code: refusal.code,
          ...refusal.details,
        });
      }

      void backfill.start(account, { force: true });

      return ok(202, { started: true as const });
    },
    serving,
  );

  serve(
    app,
    routes.insightsSettings,
    ({ body }) => {
      service.store.setSetting(SLA_KEY, body.slaHours);
      // Every account's Insights measure against it.
      service.events.emit({ type: 'insights.updated', account: null });

      return ok(200, { slaHours: body.slaHours });
    },
    serving,
  );
}
