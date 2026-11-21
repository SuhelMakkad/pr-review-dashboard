import { linearCallbackQuery, routes } from '@review-desk/shared/contract';
import { failed, ok, serve, serveRedirect } from '@/http/serve.js';
import type { FastifyInstance } from 'fastify';
import { safeError } from '@/github/errors.js';
import type { LinearService } from '@/linear/service.js';
import type { SyncService } from '@/sync/service.js';

export function registerLinearRoutes(
  app: FastifyInstance,
  service: SyncService,
  linear: LinearService,
): void {
  const serving = { sync: service };

  serve(app, routes.linearStatus, async () => ok(200, await linear.status()), serving);

  serve(
    app,
    routes.linearConnect,
    async ({ request }) => {
      // Linear must send the browser back to the address it is using now. That is its Origin: in
      // development Vite proxies the API with the API port as Host. The security hook already
      // limited both headers to this machine's allowed ports.
      const origin = request.headers.origin;
      const port = new URL(origin && origin !== 'null' ? origin : `http://${request.headers.host}`)
        .port;
      const redirectUri = `http://127.0.0.1:${port}/api/linear/callback`;

      try {
        return ok(200, { url: await linear.connect(redirectUri) });
      } catch (error) {
        return failed(502, { error: safeError(error) });
      }
    },
    serving,
  );

  // Linear sends the browser here after sign-in. The one-time state from /connect is what ties the
  // response to a sign-in this app started, so a forged link cannot connect another account.
  serveRedirect(app, routes.linearCallback, async (request) => {
    const query = linearCallbackQuery.safeParse(request.query);
    const connected = query.success ? await linear.callback(query.data) : false;

    return `/settings/linear?linear=${connected ? 'connected' : 'failed'}`;
  });

  serve(
    app,
    routes.linearDisconnect,
    async () => {
      await linear.disconnect();

      return ok(200, await linear.status());
    },
    serving,
  );

  serve(
    app,
    routes.tickets,
    async ({ account, params }) => {
      const detail = service.detailFor(account, params.id);

      if (!detail) return failed(404, { error: 'This PR is no longer tracked.' });

      return ok(200, await linear.ticketsFor(detail.snapshot));
    },
    serving,
  );
}
