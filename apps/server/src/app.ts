import Fastify, { type FastifyReply } from 'fastify';
import { CLAIM_RETENTION_MS } from '@/db/draft-writes.js';
import { knownRoutes, log } from '@/log.js';
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
import { registerAccountRoutes } from '@/routes/accounts.js';
import { registerDevRoutes } from '@/routes/dev.js';
import { registerDiffRoutes } from '@/routes/diff.js';
import { registerReviewRoutes } from '@/routes/review.js';
import { registerOperationRoutes } from '@/routes/operations.js';
import { OperationQueue, type QueueOptions } from '@/operations/queue.js';
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
import { AutoReviewer } from '@/ai/auto-review.js';
import { FindingsPublisher } from '@/ai/post-findings.js';
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
  /** Sweep abandoned AI workspaces at start-up: only for a work root in the locked data folder. */
  sweepWorkspaces?: boolean;
  exportRepository?: RepositoryExporter;
  /** Linear access (Linear sign-in or a Keychain key normally, a fixture in demo mode and tests). */
  linear?: LinearSource;
  /** Signs in to Linear from Settings; a fixture source acts as its own. */
  linearConnector?: LinearConnector | null;
  /** Native notification sender used when no window is open (macOS by default). */
  nativeNotify?: (title: string, body: string) => Promise<void>;
  keepaliveMs?: number;
  operationQueue?: QueueOptions;
  /** Told of every route as it is registered: the contract test checks them against the contract. */
  onRoute?: (route: { method: string | string[]; url: string; handler: unknown }) => void;
}

export async function createApp(service: SyncService, options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // Every route as declared, so a log record can name one without naming a request's own path.
  app.addHook('onRoute', (route) => {
    knownRoutes.add(route.url);
    options.onRoute?.({ method: route.method, url: route.url, handler: route.handler });
  });
  // How long each request took, by route: slow ones and server errors stand out.
  app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.config.stream) return;

    const ms = reply.elapsedTime;
    const status = reply.statusCode;

    log.event(status >= 500 ? 'warn' : ms > 500 ? 'info' : 'debug', 'http.request', {
      route: request.routeOptions.url ?? 'unmatched',
      method: request.method as never,
      status,
      ms,
    });
  });
  const sessionToken = options.sessionToken ?? createSessionToken();
  const bootId = options.bootId ?? service.bootId;

  // One id for the page, the event stream and every status sent.
  service.bootId = bootId;
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
    { sweepWorkspaces: options.sweepWorkspaces },
  );

  const operations = new OperationQueue(service, options.operationQueue);

  registerOperationRoutes(app, operations, service);
  registerAccountRoutes(app, service, operations);
  registerReviewRoutes(app, reviews, operations, service);
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
  const autoReviewer = new AutoReviewer(service, runner, notifier);
  const publisher = new FindingsPublisher(service, runner, operations);

  runner.onSettled = (row) => autoReviewer.settled(row);
  runner.onPublish = (row, reviewed) => publisher.publish(row, reviewed);
  runner.onFinished = (row) => autoReviewer.finished(row);
  operations.posting = () => runner.settings();
  registerAiRoutes(app, runner, autoReviewer, service);

  const backfill = new Backfill(service, service.events);

  service.afterSync = async (login) => {
    await notifier.afterSync(login, service.listFor(login).items, service.mineFor(login).items);
    await runner.recover(login);
    operations.wake();

    // Starting a review refetches the PR and builds its diff; it never delays a sync.
    void autoReviewer.afterSync(login);

    // History fills in the background; it never delays a sync.
    void backfill.start(login);
  };
  registerNotifyRoutes(app, service, notifier);
  registerInsightsRoutes(app, service, backfill);

  // Recovery runs before the first request is served (Fastify finishes `ready` before it listens
  // or injects), and only in the process that owns the data directory: `index.ts` takes the lock
  // before the store is opened.
  app.addHook('onReady', async () => {
    // A claim still pending was left by a process that is gone: it never committed. Settled before
    // any request can ask about it; settled claims past their retention go.
    service.store.transaction(() => {
      service.store.draftWrites.interrupt();
      service.store.draftWrites.prune(new Date(Date.now() - CLAIM_RETENTION_MS).toISOString());
    });
    runner.open();
    operations.open();
  });

  // One shutdown. Every part stops taking new work in the same tick, before anything is awaited,
  // so work finishing in one part (a sync's follow-ups, a run's completion) cannot start more in
  // another. That happens in preClose, before Fastify waits for requests in flight: a request
  // still waiting on GitHub must not let the outbox start another write meanwhile. Then the parts
  // drain together: the sync in progress ends, the action being sent finishes its step, AI runs
  // pause at a checkpoint (their agents are signalled at once) and automatic-review and history
  // work completes. onClose waits for that; the caller closes the store after it.
  // Settled rather than all-or-nothing: one part failing to stop must not cut short the others'
  // drain, and nothing rejects before onClose is there to report it.
  let draining: Promise<PromiseSettledResult<unknown>[]> | null = null;
  const stopWork = () =>
    (draining ??= Promise.allSettled([
      service.stop(),
      autoReviewer.close(),
      backfill.close(),
      operations.close(),
      runner.close(),
    ]));

  app.addHook('preClose', async () => {
    void stopWork();
  });
  app.addHook('onClose', async () => {
    const failures = (await stopWork()).flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );

    // Requests have finished by now: a cancellation one made after the runner closed has its
    // workspace removal finished too, before the data folder's lock is released.
    await runner.cleanedUp();

    if (failures.length > 0)
      throw new AggregateError(failures, 'Some work could not stop cleanly.');
  });

  if (options.fixture)
    registerDevRoutes(app, service, options.fixture, runner, notifier, linear, operations);

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
