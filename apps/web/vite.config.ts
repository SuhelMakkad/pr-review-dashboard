import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const demo = process.env.REVIEW_DESK_MODE === 'demo';
const uiPort = demo ? 4319 : 4317;
const apiPort = demo ? 4320 : 4318;
const dataDir = resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
  process.env.REVIEW_DESK_DATA_DIR ?? (demo ? '.data-demo' : '.data'),
);

/**
 * In development the API writes its per-launch session to the private data directory; this plugin
 * injects it into index.html the same way the production server does.
 */
function devSession(): Plugin {
  return {
    name: 'review-desk-dev-session',
    apply: 'serve',
    transformIndexHtml() {
      try {
        const session = JSON.parse(readFileSync(resolve(dataDir, 'dev-session.json'), 'utf8')) as {
          token: string;
          bootId: string;
        };

        return [
          {
            tag: 'meta',
            attrs: { name: 'review-desk-session', content: session.token },
            injectTo: 'head',
          },
          {
            tag: 'meta',
            attrs: { name: 'review-desk-boot', content: session.bootId },
            injectTo: 'head',
          },
          {
            tag: 'meta',
            attrs: { name: 'review-desk-demo', content: demo ? '1' : '0' },
            injectTo: 'head',
          },
        ];
      } catch {
        return [];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devSession()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: uiPort,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: 'dist' },
  // The diff renderer highlights code in module workers.
  worker: { format: 'es' },
});
