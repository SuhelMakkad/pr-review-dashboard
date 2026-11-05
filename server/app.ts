import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ServerEvent } from '../shared/events.js';
import type { FixtureGitHub } from './demo/fixture-github.js';
import { registerSecret } from './github/errors.js';
import { loadIndexHtml } from './http/html.js';
import { createSessionToken, registerSecurity } from './http/security.js';
import { registerEventStream } from './http/sse.js';
import { DiffService } from './diff/service.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerDiffRoutes } from './routes/diff.js';
import { registerReviewRoutes } from './routes/review.js';
import { ReviewService } from './review/service.js';
import { registerPullRoutes } from './routes/pulls.js';
import type { SyncService } from './sync/service.js';

export interface AppOptions {
  /** Built web assets to serve; omitted when Vite serves the UI. */
  webRoot?: string | null;
  /** Ports the browser may use (host/origin allowlist). */
  ports?: number[];
  sessionToken?: string;
  bootId?: string;
  /** Demo-mode GitHub stand-in; enables the scenario controls under /api/dev. */
  fixture?: FixtureGitHub;
  keepaliveMs?: number;
}

export async function createApp(service: SyncService, options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const sessionToken = options.sessionToken ?? createSessionToken();
  const bootId = options.bootId ?? randomUUID();
  const demo = Boolean(options.fixture);
  const webRoot = options.webRoot && existsSync(options.webRoot) ? options.webRoot : null;
  const index = webRoot ? loadIndexHtml(webRoot, { token: sessionToken, bootId, demo }) : null;

  registerSecret(sessionToken);
  registerSecurity(app, {
    ports: options.ports ?? [4317, 4318],
    sessionToken,
    canonicalRedirect: Boolean(webRoot),
    scriptHashes: () => index?.hashes ?? [],
  });

  const hello = (): ServerEvent => ({
    type: 'hello',
    bootId,
    account: service.status.account?.login ?? null,
    demo,
  });

  registerEventStream(app, {
    bus: service.events,
    bootId,
    hello,
    keepaliveMs: options.keepaliveMs,
  });
  registerPullRoutes(app, service);
  const diffs = new DiffService(service.github);

  registerDiffRoutes(app, service, diffs);
  registerReviewRoutes(app, new ReviewService(service, service.github, diffs, service.events));

  if (options.fixture) registerDevRoutes(app, service, options.fixture);

  if (webRoot && index) {
    const sendIndex = (reply: FastifyReply) =>
      reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(index.html);

    await app.register(fastifyStatic, {
      root: webRoot,
      index: false,
      allowedPath: (path) => path !== '/index.html',
    });

    app.get('/', (_request, reply) => sendIndex(reply));
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/') || request.method !== 'GET'
        ? reply.code(404).send({ error: 'Unknown API route.' })
        : sendIndex(reply),
    );
  }

  return app;
}
