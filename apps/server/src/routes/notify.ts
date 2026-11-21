import type { FastifyInstance } from 'fastify';
import { routes } from '@review-desk/shared/contract';
import { ok, serve } from '@/http/serve.js';
import type { Notifier } from '@/notify/notifier.js';
import type { SyncService } from '@/sync/service.js';

export function registerNotifyRoutes(
  app: FastifyInstance,
  service: SyncService,
  notifier: Notifier,
): void {
  const serving = { sync: service };

  serve(app, routes.notificationSettings, () => ok(200, notifier.settings()), serving);
  serve(
    app,
    routes.saveNotificationSettings,
    ({ body }) => ok(200, notifier.saveSettings(body.settings)),
    serving,
  );

  serve(
    app,
    routes.testNotification,
    () => {
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

      return ok(200, { ok: true as const });
    },
    serving,
  );
}
