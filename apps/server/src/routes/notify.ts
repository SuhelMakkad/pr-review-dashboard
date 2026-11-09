import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Notifier } from '@/notify/notifier.js';
import type { SyncService } from '@/sync/service.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const kinds = z.strictObject({
  first_review: z.boolean(),
  changed: z.boolean(),
  requested_again: z.boolean(),
  reply: z.boolean(),
  mention: z.boolean(),
  dismissed: z.boolean(),
  changes_requested: z.boolean(),
  approved: z.boolean(),
  ci_failing: z.boolean(),
  ai_review_ready: z.boolean(),
});
const settingsSchema = z.strictObject({
  account: z.string().min(1),
  settings: z.strictObject({
    kinds,
    quietHours: z.strictObject({ start: time, end: time }).nullable(),
    macosWhenClosed: z.boolean(),
    badgeIncludesMine: z.boolean(),
  }),
});

export function registerNotifyRoutes(
  app: FastifyInstance,
  service: SyncService,
  notifier: Notifier,
): void {
  app.get('/api/notifications/settings', async () => notifier.settings());

  app.put('/api/notifications/settings', async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);

    if (!parsed.success) return reply.code(400).send({ error: 'Invalid notification settings.' });

    return notifier.saveSettings(parsed.data.settings);
  });

  app.post('/api/notifications/test', async () => {
    service.events.emit({
      type: 'notify',
      notifications: [
        {
          key: `test:${Date.now()}`,
          kind: 'first_review',
          prId: 'test',
          title: 'Review Desk',
          body: 'Notifications are working.',
          path: '/inbox/attention',
        },
      ],
    });

    return { ok: true };
  });
}
