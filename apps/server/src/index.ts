import { pruneBackups } from '@/db/backups.js';
import { systemClock } from '@/clock.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '@/app.js';
import { log, LogFile } from '@/log.js';
import { watchEventLoop } from '@/http/loop.js';
import { loadConfig } from '@/config.js';
import { DataDirectoryLocked, lockDataDirectory, type DataDirectoryLock } from '@/db/lock.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { seedDemoQueue } from '@/demo/history.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { ForgeRouter } from '@/forge/router.js';
import { ghCredentials } from '@/github/credentials.js';
import { GitHub } from '@/github/read.js';
import { GhCli } from '@/github/transport.js';
import { GlabAccounts } from '@/gitlab/accounts.js';
import { GitLab } from '@/gitlab/read.js';
import { createSessionToken } from '@/http/security.js';
import { ClaudeProvider } from '@/ai/claude.js';
import { CodexProvider } from '@/ai/codex.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { KeychainCredentialStore } from '@/linear/credentials.js';
import { KeychainKeySource } from '@/linear/keychain.js';
import { LinearMcp } from '@/linear/mcp.js';
import { LinearOAuth } from '@/linear/oauth.js';
import { FixtureLinear, LinearApi, PreferredLinear } from '@/linear/service.js';
import { SyncService } from '@/sync/service.js';

/** How long shutdown waits for running work to stop before the process exits regardless. */
const SHUTDOWN_DEADLINE_MS = 20_000;

const config = loadConfig();

// This process must own the data directory before anything opens, migrates or recovers the
// database in it, or writes the dev session file another running instance depends on.
let lock: DataDirectoryLock;

try {
  lock = lockDataDirectory(config.dataDir);
} catch (error) {
  if (!(error instanceof DataDirectoryLocked)) throw error;

  console.error(error.message);
  process.exit(1);
}

// The log file is this process's too: opened, rotated and closed only while it holds the lock.
const logFile = new LogFile(join(config.dataDir, 'logs', 'review-desk.log'));

logFile.open();
log.open(logFile, process.env.REVIEW_DESK_LOG_LEVEL ?? 'info');

const stopWatchingLoop = watchEventLoop();

/**
 * Closes the log, then gives up the data directory. A log file that cannot close in time may
 * still be in use (a rename or a write), so the lock then goes only with the process.
 */
async function release(code: 0 | 1, clean: boolean): Promise<never> {
  stopWatchingLoop();
  log.event('info', 'server.stopped', { clean });

  const closed = await logFile.close();

  log.silence();
  if (closed === 'closed') lock.release();
  process.exit(closed === 'closed' ? code : 1);
}

const demoAnchor = process.env.REVIEW_DESK_DEMO_NOW
  ? Date.parse(process.env.REVIEW_DESK_DEMO_NOW)
  : Date.now();
const fixture =
  config.mode === 'demo' ? new FixtureGitHub(() => defaultScenario(demoAnchor)) : undefined;
const store = new Store(config.databasePath);

// Opening the store applied any migrations; only now is an older backup safe to let go.
await pruneBackups(config.dataDir);
// GitHub accounts come from the GitHub CLI, GitLab accounts (any host) from the GitLab CLI.
const forges = fixture
  ? null
  : new ForgeRouter(
      new GitHub(),
      ghCredentials,
      new GlabAccounts(),
      (host) => GitLab.forHost(host, store.settings.forgeLocal),
      // Work for one account keeps that account's credentials for as long as it runs.
      {
        bound: (login) => new GitHub(new GhCli(undefined, ghCredentials.bind(login))),
        pinned: async () => {
          const source = await ghCredentials.pin();

          return source ? new GitHub(new GhCli(undefined, source)) : null;
        },
      },
    );
// Real forges turn Retry-After into deadlines with the system's wall time, so they share its clock.
const service = new SyncService(
  store,
  fixture ?? forges!,
  new EventBus(),
  fixture ?? forges,
  systemClock,
);
const sessionToken = createSessionToken();
const bootId = randomUUID();
const linearOAuth = fixture ? null : new LinearOAuth(new KeychainCredentialStore());

if (config.viteDev) {
  // Vite injects the session into index.html during development; only this user can read it.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(config.dataDir, 'dev-session.json'),
    JSON.stringify({ token: sessionToken, bootId }),
    {
      mode: 0o600,
    },
  );
}

const app = await createApp(service, {
  webRoot: config.webRoot,
  ports: config.allowedPorts,
  sessionToken,
  bootId,
  fixture,
  aiProviders: fixture
    ? { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') }
    : { codex: new CodexProvider(), claude: new ClaudeProvider() },
  aiWorkRoot: join(config.dataDir, 'ai-runs'),
  // Inside the data folder this process has locked: its abandoned workspaces are its to remove.
  sweepWorkspaces: true,
  // A Linear sign-in comes first; a personal API key in the Keychain still works where allowed.
  linear: linearOAuth
    ? new PreferredLinear([new LinearMcp(linearOAuth), new LinearApi(new KeychainKeySource())])
    : new FixtureLinear(),
  linearConnector: linearOAuth ?? undefined,
});

try {
  await app.listen({ host: '127.0.0.1', port: config.port });

  const label = config.mode === 'demo' ? 'Review Desk (demo)' : 'Review Desk';

  console.log(`${label}${config.viteDev ? ' API' : ''} → http://127.0.0.1:${config.port}`);
  log.event('info', 'server.started', { mode: config.mode, port: config.port });
  if (fixture) seedDemoQueue(store, fixture.scenario.world.viewer.login, Date.now());

  service.start();
} catch (error) {
  console.error(
    `Could not start Review Desk on port ${config.port}.`,
    error instanceof Error ? error.message : error,
  );
  // Recovery may already have started work while the app got ready; stop it before closing.
  await app.close().catch(() => undefined);
  store.close();
  await release(1, false);
}

let stopping = false;

async function shutdown() {
  // A second Ctrl-C exits at once; interrupted work is checked on the next start.
  if (stopping) process.exit(1);

  stopping = true;

  const deadline = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), SHUTDOWN_DEADLINE_MS),
  );
  const closing = app.close().then(
    () => 'closed' as const,
    (error: unknown) => {
      console.error(
        'Review Desk could not stop cleanly.',
        error instanceof Error ? error.message : error,
      );

      return 'failed' as const;
    },
  );
  const outcome = await Promise.race([closing, deadline]);

  if (outcome !== 'closed') {
    // Work may still be running and touch the database, so it stays open; exiting ends that work
    // and releases the lock. Recovery checks interrupted actions and runs on the next start.
    if (outcome === 'timeout')
      console.error(
        `Review Desk did not stop within ${SHUTDOWN_DEADLINE_MS / 1000} s. Exiting; interrupted work is checked on the next start.`,
      );

    process.exit(1);
  }

  // Nothing can touch the database any more: close it and the log, then give up the data
  // directory.
  store.close();
  await release(0, true);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
