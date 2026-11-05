import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './db/store.js';
import { FixtureGitHub } from './demo/fixture-github.js';
import { defaultScenario } from './demo/scenario.js';
import { EventBus } from './events.js';
import { GitHub } from './github/read.js';
import { createSessionToken } from './http/security.js';
import { SyncService } from './sync/service.js';

const config = loadConfig();
const demoAnchor = process.env.REVIEW_DESK_DEMO_NOW
  ? Date.parse(process.env.REVIEW_DESK_DEMO_NOW)
  : Date.now();
const fixture =
  config.mode === 'demo' ? new FixtureGitHub(() => defaultScenario(demoAnchor)) : undefined;
const store = new Store(config.databasePath);
const service = new SyncService(store, fixture ?? new GitHub(), new EventBus());
const sessionToken = createSessionToken();
const bootId = randomUUID();

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
});

try {
  await app.listen({ host: '127.0.0.1', port: config.port });

  const label = config.mode === 'demo' ? 'Review Desk (demo)' : 'Review Desk';

  console.log(`${label}${config.viteDev ? ' API' : ''} → http://127.0.0.1:${config.port}`);
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
