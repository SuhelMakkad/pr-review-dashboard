import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeInsights } from '@review-desk/shared/insights';
import type { Backfill } from '@/insights/backfill.js';
import type { SyncService } from '@/sync/service.js';

const DAY = 24 * 60 * 60_000;
const SLA_KEY = 'review-sla-hours';

export function registerInsightsRoutes(
  app: FastifyInstance,
  service: SyncService,
  backfill: Backfill,
): void {
  app.get<{ Querystring: { days?: string; repo?: string } }>('/api/insights', async (request) => {
    const login = service.status.account?.login;
    const days = [7, 30, 90].includes(Number(request.query.days)) ? Number(request.query.days) : 30;
    const slaHours = service.store.getSetting<number>(SLA_KEY) ?? 24;

    if (!login) return { insights: null, backfill: null, slaHours, repositories: [] };

    // Look back further than the range so requests made just before it still pair with reviews.
    const since = new Date(Date.now() - (days + 30) * DAY).toISOString();
    const events = service.store.activity(login, since);

    return {
      insights: computeInsights(events, service.store.queueSamples(login, since), {
        days,
        slaHours,
        repository: request.query.repo || null,
      }),
      backfill: backfill.state(login),
      slaHours,
      repositories: [...new Set(events.map((event) => event.repository))].sort(),
    };
  });

  app.post('/api/insights/backfill', async (request, reply) => {
    const parsed = z.strictObject({ account: z.string().min(1) }).safeParse(request.body);

    if (!parsed.success || parsed.data.account !== service.status.account?.login) {
      return reply.code(409).send({ error: 'GitHub account changed. Refresh first.' });
    }

    void backfill.start(parsed.data.account, { force: true });

    return reply.code(202).send({ started: true });
  });

  app.put('/api/insights/settings', async (request, reply) => {
    const parsed = z
      .strictObject({ account: z.string().min(1), slaHours: z.number().int().min(1).max(240) })
      .safeParse(request.body);

    if (!parsed.success)
      return reply.code(400).send({ error: 'Choose a review target between 1 and 240 hours.' });

    service.store.setSetting(SLA_KEY, parsed.data.slaHours);
    service.events.emit({ type: 'insights.updated' });

    return { slaHours: parsed.data.slaHours };
  });
}
