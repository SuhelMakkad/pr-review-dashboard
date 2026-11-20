import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeInsights } from '@review-desk/shared/insights';
import type { Backfill } from '@/insights/backfill.js';
import { accountNotActive } from '@/review/errors.js';
import { scopedRoutes } from '@/routes/scoped.js';
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
  const serve = scopedRoutes(app, service);

  serve('get', '/api/insights', async (request, _reply, scoped) => {
    const login = scoped ?? service.status.account?.login;
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

  serve('post', '/api/insights/backfill', async (request, reply, scoped) => {
    const parsed = scoped
      ? z.strictObject({}).safeParse(request.body ?? {})
      : z.strictObject({ account: z.string().min(1) }).safeParse(request.body);

    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request.' });

    const account = scoped ?? (parsed.data as { account: string }).account;
    const selected = service.status.account?.login ?? null;

    if (account !== selected) {
      if (!scoped) return reply.code(409).send({ error: 'GitHub account changed. Refresh first.' });

      const refusal = accountNotActive(account, selected);

      return reply
        .code(refusal.status)
        .send({ error: refusal.message, code: refusal.code, ...refusal.details });
    }

    void backfill.start(account, { force: true });

    return reply.code(202).send({ started: true });
  });

  app.put('/api/insights/settings', async (request, reply) => {
    const parsed = z
      .strictObject({ account: z.string().min(1), slaHours: z.number().int().min(1).max(240) })
      .safeParse(request.body);

    if (!parsed.success)
      return reply.code(400).send({ error: 'Choose a review target between 1 and 240 hours.' });

    service.store.setSetting(SLA_KEY, parsed.data.slaHours);
    // Every account's Insights measure against it.
    service.events.emit({ type: 'insights.updated', account: null });

    return { slaHours: parsed.data.slaHours };
  });
}
