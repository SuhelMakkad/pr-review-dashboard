import { pruneBackups } from '@/db/backups.js';
import { systemClock } from '@/clock.js';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '@/app.js';
import { log, LogFile } from '@/log.js';
import { watchEventLoop } from '@/http/loop.js';
import { loadConfig } from '@/config.js';
import { DataDirectoryRefused, resolveDataDirectory, type Adoption } from '@/db/data-directory.js';
import { DataDirectoryLocked, type DataDirectoryLock } from '@/db/lock.js';
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
// database in it, or writes the dev session file another running instance depends on. The first
// start after an upgrade also moves a checkout's `.data` to the OS's folder here.
let lock: DataDirectoryLock;
let adoption: Adoption | null;

try {
  ({ lock, adoption } = await resolveDataDirectory(config));
} catch (error) {
  if (!(error instanceof DataDirectoryLocked) && !(error instanceof DataDirectoryRefused))
    throw error;

  console.error(error.message);
  process.exit(1);
}

// The log file is this process's too: opened, rotated and closed only while it holds the lock.
const logFile = new LogFile(join(config.dataDir, 'logs', 'review-desk.log'));

logFile.open();
log.open(logFile, process.env.REVIEW_DESK_LOG_LEVEL ?? 'info');

if (adoption) {
  log.event('info', 'data.adopt', { outcome: adoption.outcome, synced: adoption.synced });
  console.log(
    adoption.outcome === 'moved'
      ? `Moved your data from ${adoption.from} to ${adoption.to}${adoption.synced ? '.' : '; the move could not be flushed to disk yet.'}`
      : `Using the data in ${adoption.to}. The data in ${adoption.from} is ignored: to use it instead, stop Review Desk and start it with REVIEW_DESK_DATA_DIR=.data.`,
  );
}

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
        bound: (login) => {
          const credentials = ghCredentials.bind(login);

          return { client: new GitHub(new GhCli(undefined, credentials)), credentials };
        },
        pinned: async () => {
          const credentials = await ghCredentials.pin();

          return credentials
            ? { client: new GitHub(new GhCli(undefined, credentials)), credentials }
            : null;
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
service.dataFolder = config.dataDir;

const sessionToken = createSessionToken();
const bootId = randomUUID();
const linearOAuth = fixture ? null : new LinearOAuth(new KeychainCredentialStore());

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

  if (config.viteDev) {
    // Vite injects the session into index.html during development, once it sees this boot answer
    // (see vite.config.ts). Published whole, and only now that the API is up; only this user can
    // read it.
    const session = join(config.dataDir, 'dev-session.json');
    const draft = `${session}.${process.pid}.tmp`;

    writeFileSync(draft, JSON.stringify({ token: sessionToken, bootId }), { mode: 0o600 });
    renameSync(draft, session);
  }

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
