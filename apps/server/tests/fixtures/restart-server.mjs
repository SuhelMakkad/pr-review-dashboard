// A separate server process lets recovery tests exercise a real SQLite reopen and process exit.
import { join } from 'node:path';
import { createApp } from '@/app.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { SyncService } from '@/sync/service.js';
import { FixtureLinear } from '@/linear/service.js';

const directory = process.env.REVIEW_RESTART_DATA;
const port = Number(process.env.REVIEW_RESTART_PORT);
const store = new Store(join(directory, 'state.sqlite'));
const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
const sync = new SyncService(store, fixture, new EventBus());
const providers = { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') };

providers.codex.delayMs = Number(process.env.REVIEW_RESTART_DELAY);
const app = await createApp(sync, {
  ports: [port],
  sessionToken: 'recovery-test-session',
  fixture,
  aiProviders: providers,
  aiWorkRoot: join(directory, 'ai-runs'),
  webRoot: process.env.REVIEW_RESTART_WEB_ROOT || undefined,
  linear: new FixtureLinear(),
});

await app.listen({ host: '127.0.0.1', port });
await sync.sync();
process.stdout.write('ready\n');

process.on('SIGTERM', async () => {
  await app.close();
  await sync.stop();
  store.close();
});
