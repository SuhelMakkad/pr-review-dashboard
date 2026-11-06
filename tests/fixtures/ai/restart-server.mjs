// A separate server process lets recovery tests exercise a real SQLite reopen and process exit.
import { join } from 'node:path';
import { createApp } from '../../../apps/server/src/app.ts';
import { FixtureProvider } from '../../../apps/server/src/ai/fixture.ts';
import { Store } from '../../../apps/server/src/db/store.ts';
import { FixtureGitHub } from '../../../apps/server/src/demo/fixture-github.ts';
import { defaultScenario } from '../../../apps/server/src/demo/scenario.ts';
import { EventBus } from '../../../apps/server/src/events.ts';
import { SyncService } from '../../../apps/server/src/sync/service.ts';
import { FixtureLinear } from '../../../apps/server/src/linear/service.ts';

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
