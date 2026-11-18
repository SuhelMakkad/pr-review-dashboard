import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '@/app.js';
import { loadConfig } from '@/config.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { seedDemoQueue } from '@/demo/history.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { ForgeRouter } from '@/forge/router.js';
import { ghCredentials } from '@/github/credentials.js';
import { GitHub } from '@/github/read.js';
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

const config = loadConfig();
const demoAnchor = process.env.REVIEW_DESK_DEMO_NOW
  ? Date.parse(process.env.REVIEW_DESK_DEMO_NOW)
  : Date.now();
const fixture =
  config.mode === 'demo' ? new FixtureGitHub(() => defaultScenario(demoAnchor)) : undefined;
const store = new Store(config.databasePath);
// GitHub accounts come from the GitHub CLI, GitLab accounts (any host) from the GitLab CLI.
const forges = fixture
  ? null
  : new ForgeRouter(new GitHub(), ghCredentials, new GlabAccounts(), (host) =>
      GitLab.forHost(host, store),
    );
const service = new SyncService(store, fixture ?? forges!, new EventBus(), fixture ?? forges);
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
  if (fixture) seedDemoQueue(store, fixture.scenario.world.viewer.login, Date.now());

  service.start();
} catch (error) {
  console.error(
    `Could not start Review Desk on port ${config.port}.`,
    error instanceof Error ? error.message : error,
  );
  store.close();
  process.exit(1);
}

let stopping = false;

async function shutdown() {
  if (stopping) return;

  stopping = true;
  await app.close();
  await service.stop();
  store.close();
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
