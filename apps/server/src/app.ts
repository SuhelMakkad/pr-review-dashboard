import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ServerEvent } from '@review-desk/shared/events';
import type { FixtureGitHub } from '@/demo/fixture-github.js';
import { registerSecret } from '@/github/errors.js';
import { loadIndexHtml } from '@/http/html.js';
import { createSessionToken, registerSecurity } from '@/http/security.js';
import { registerEventStream } from '@/http/sse.js';
import { DiffService } from '@/diff/service.js';
import { registerDevRoutes } from '@/routes/dev.js';
import { registerDiffRoutes } from '@/routes/diff.js';
import { registerReviewRoutes } from '@/routes/review.js';
import { registerAiRoutes } from '@/routes/ai.js';
import { registerLinearRoutes } from '@/routes/linear.js';
import { registerNotifyRoutes } from '@/routes/notify.js';
import { registerInsightsRoutes } from '@/routes/insights.js';
import { Backfill } from '@/insights/backfill.js';
import { Notifier } from '@/notify/notifier.js';
import { macosNotify } from '@/notify/macos.js';
import { FixtureLinear, LinearService, type LinearSource } from '@/linear/service.js';
import type { LinearConnector } from '@/linear/oauth.js';
import { AiRunner } from '@/ai/runner.js';
import { downloadRepository, type RepositoryExporter } from '@/ai/workspace.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FixtureProvider } from '@/ai/fixture.js';
import type { AgentProvider } from '@/ai/provider.js';
import type { AiProvider } from '@review-desk/shared/ai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewService } from '@/review/service.js';
import { registerPullRoutes } from '@/routes/pulls.js';
import type { SyncService } from '@/sync/service.js';

export interface AppOptions {
  /** Built web assets to serve; omitted when Vite serves the UI. */
  webRoot?: string | null;
  /** Ports the browser may use (host/origin allowlist). */
  ports?: number[];
  sessionToken?: string;
  bootId?: string;
  /** Demo-mode GitHub stand-in; enables the scenario controls under /api/dev. */
  fixture?: FixtureGitHub;
  /** AI agents (real CLIs normally, deterministic stand-ins in demo mode and tests). */
  aiProviders?: Record<AiProvider, AgentProvider>;
  /** Private scratch directory for agent runs. */
  aiWorkRoot?: string;
  exportRepository?: RepositoryExporter;
  /** Linear access (Linear sign-in or a Keychain key normally, a fixture in demo mode and tests). */
  linear?: LinearSource;
  /** Signs in to Linear from Settings; a fixture source acts as its own. */
  linearConnector?: LinearConnector | null;
  /** Native notification sender used when no window is open (macOS by default). */
  nativeNotify?: (title: string, body: string) => Promise<void>;
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
  const reviews = new ReviewService(service, service.github, diffs, service.events);
  const runner = new AiRunner(
    service,
    diffs,
    reviews,
    service.events,
    options.aiProviders ?? {
      codex: new FixtureProvider('codex'),
      claude: new FixtureProvider('claude'),
    },
    options.aiWorkRoot ?? join(tmpdir(), 'review-desk-ai'),
    options.exportRepository ??
      (options.fixture
        ? async (repository, oid, directory, signal) => {
            const files = options.fixture!.scenario.world.repos.files(repository, oid);

            for (const [path, content] of Object.entries(files)) {
              signal.throwIfAborted();

              const target = join(directory, path);

              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, content);
            }

            return [];
          }
        : downloadRepository),
  );

  registerReviewRoutes(app, reviews);
  registerAiRoutes(app, runner);
  app.addHook('onClose', () => runner.close());
  const linearSource = options.linear ?? new FixtureLinear(false);
  const linear = new LinearService(
    linearSource,
    options.linearConnector !== undefined
      ? options.linearConnector
      : linearSource instanceof FixtureLinear
        ? linearSource
        : null,
  );

  registerLinearRoutes(app, service, linear);

  const notifier = new Notifier(service.store, service.events, options.nativeNotify ?? macosNotify);

  const backfill = new Backfill(service, service.events);

  service.afterSync = async (login) => {
    await notifier.afterSync(login, service.list().items, service.mine().items);
    await runner.recover(login);

    // History fills in the background; it never delays a sync.
    void backfill.start(login);
  };
  registerNotifyRoutes(app, service, notifier);
  registerInsightsRoutes(app, service, backfill);

  if (options.fixture) registerDevRoutes(app, service, options.fixture, runner, notifier, linear);

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
