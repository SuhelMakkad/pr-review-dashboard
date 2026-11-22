import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A port nothing listens on yet. */
async function freePort(): Promise<number> {
  const server = createHttpServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as { port: number };

  await new Promise((resolve) => server.close(resolve));

  return port;
}

describe('the dev server’s session', () => {
  it('serves a page with a session only once the API answers as the boot it is from', async () => {
    const data = mkdtempSync(join(tmpdir(), 'rd-vite-'));
    const apiPort = await freePort();
    const saved = { ...process.env };

    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
    cleanups.push(() => {
      process.env = saved;
    });
    process.env.REVIEW_DESK_DATA_DIR = data;
    process.env.REVIEW_DESK_PORT = String(apiPort);

    const publish = (token: string, bootId: string) =>
      writeFileSync(join(data, 'dev-session.json'), JSON.stringify({ token, bootId }));

    // Left by a server that was killed.
    publish('stale-token', 'old-boot');

    const vite: ViteDevServer = await createServer({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { port: 0, strictPort: false },
      logLevel: 'silent',
    });

    cleanups.push(() => vite.close());
    await vite.listen();

    const page = async () => {
      const response = await fetch(vite.resolvedUrls!.local[0]!, {
        headers: { accept: 'text/html' },
      });

      return { status: response.status, html: await response.text() };
    };

    // The API is not up: a page that reloads itself, with no session in it.
    const starting = await page();

    expect(starting.status).toBe(503);
    expect(starting.html).toContain('Review Desk is starting');
    expect(starting.html).not.toContain('stale-token');

    // The API is up as a new boot, which has not published its session yet.
    let boot = 'new-boot';
    const api: Server = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ bootId: boot }));
    });

    await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => api.close(resolve)));

    const waiting = await page();

    expect(waiting.status).toBe(503);
    expect(waiting.html).not.toContain('stale-token');

    // Published: the page carries the boot's own session.
    publish('new-token', 'new-boot');

    const ready = await page();

    expect(ready.status).toBe(200);
    expect(ready.html).toContain('content="new-token"');
    expect(ready.html).toContain('content="new-boot"');

    // Another boot answers now: its session file is not this one.
    boot = 'next-boot';
    expect((await page()).status).toBe(503);

    // A boot that changes while the page is answered: the page is the boot it was checked as.
    let answered = 0;

    api.removeAllListeners('request');
    api.on('request', (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ bootId: answered++ === 0 ? 'new-boot' : 'next-boot' }));
    });

    const during = await page();

    expect(during.status).toBe(200);
    expect(during.html).toContain('content="new-token"');
    expect(during.html).toContain('content="new-boot"');

    // Nor does a request that does not ask for HTML get the stale session.
    const anything = await fetch(vite.resolvedUrls!.local[0]!, { headers: { accept: '*/*' } });

    expect(await anything.text()).not.toContain('new-token');
  }, 30_000);
});
