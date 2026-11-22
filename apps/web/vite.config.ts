import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dataLocation, runtimePorts } from '@review-desk/shared/runtime';

const demo = process.env.REVIEW_DESK_MODE === 'demo';
// The same ports and data folder the API resolves for `pnpm dev`.
const { ui: uiPort, api: apiPort } = runtimePorts({ demo, viteDev: true, env: process.env });
const api = `http://127.0.0.1:${apiPort}`;
const dataDir = dataLocation({
  env: process.env,
  platform: process.platform,
  home: homedir(),
  projectRoot: fileURLToPath(new URL('../../', import.meta.url)),
  mode: demo ? 'demo' : 'development',
  path,
}).directory;

interface Session {
  token: string;
  bootId: string;
}

/** Shown while the API is not up yet, or is not the boot the session file is from. */
const STARTING = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="1" />
    <title>Review Desk is starting</title>
  </head>
  <body style="font-family: system-ui; padding: 2rem">Review Desk is starting…</body>
</html>
`;

function readSession(): Session | null {
  try {
    const session = JSON.parse(
      readFileSync(path.resolve(dataDir, 'dev-session.json'), 'utf8'),
    ) as Partial<Session> | null;

    return typeof session?.token === 'string' && typeof session.bootId === 'string'
      ? { token: session.token, bootId: session.bootId }
      : null;
  } catch {
    return null;
  }
}

/** The boot the API answers as, or null while it is not up. */
async function liveBoot(): Promise<string | null> {
  try {
    const response = await fetch(`${api}/api/status`, { signal: AbortSignal.timeout(500) });
    const status = (await response.json()) as { bootId?: unknown };

    return response.ok && typeof status.bootId === 'string' ? status.bootId : null;
  } catch {
    return null;
  }
}

/**
 * In development the API publishes its per-launch session in the private data folder once it is
 * listening; this plugin injects it into index.html the same way the production server does. A
 * file from an earlier boot (a server that was killed) is never served: a page is answered only
 * once the API answers as the boot the file names, and until then with a token-free page that
 * reloads itself.
 */
/** The page's session meta tags, as the production server writes them (`http/html.ts`). */
function sessionTags(session: Session): string {
  const attribute = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  return [
    `<meta name="review-desk-session" content="${attribute(session.token)}" />`,
    `<meta name="review-desk-boot" content="${attribute(session.bootId)}" />`,
    `<meta name="review-desk-demo" content="${demo ? '1' : '0'}" />`,
  ].join('');
}

function devSession(): Plugin {
  return {
    name: 'review-desk-dev-session',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const document =
          request.method === 'GET' &&
          !request.url?.startsWith('/api/') &&
          request.headers.accept?.includes('text/html');

        // Anything else Vite answers itself; its index.html never carries a session.
        if (!document) return next();

        void (async () => {
          const session = readSession();

          // One check per page: the session it renders is the one this answer was checked for.
          if (!session || (await liveBoot()) !== session.bootId) {
            response.statusCode = 503;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(STARTING);

            return;
          }

          try {
            const html = await server.transformIndexHtml(
              request.originalUrl ?? request.url ?? '/',
              readFileSync(path.resolve(server.config.root, 'index.html'), 'utf8'),
            );

            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(html.replace('</head>', `${sessionTags(session)}</head>`));
          } catch (error) {
            next(error);
          }
        })();
      });
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
    proxy: { '/api': api },
  },
  build: { outDir: 'dist' },
  // The diff renderer highlights code in module workers.
  worker: { format: 'es' },
});
