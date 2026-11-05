import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { SyncService } from './sync.js';
import { createApp } from './app.js';

const development = process.argv.includes('--dev');
const projectRoot = fileURLToPath(new URL(development ? '../' : '../../', import.meta.url));
const store = new Store(resolve(projectRoot, '.data/review-desk.sqlite'));
const service = new SyncService(store);
const app = await createApp(service, development ? undefined : resolve(projectRoot, 'dist/web'));
const port = development ? 4318 : 4317;

try {
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Review Desk ${development ? 'API' : ''} → http://127.0.0.1:${port}`);
  service.start();
} catch (error) {
  console.error(
    `Could not start Review Desk on port ${port}.`,
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
