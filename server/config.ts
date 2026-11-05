import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export type Mode = 'production' | 'development' | 'demo';

export interface Config {
  mode: Mode;
  /** True when the browser UI is served by Vite rather than this server. */
  viteDev: boolean;
  /** Port this server listens on. */
  port: number;
  /** Ports the browser may use to reach the API (the server port and, in dev, Vite's). */
  allowedPorts: number[];
  projectRoot: string;
  dataDir: string;
  databasePath: string;
  webRoot: string | null;
}

const PORTS = {
  production: { ui: 4317, api: 4317 },
  development: { ui: 4317, api: 4318 },
  demo: { ui: 4319, api: 4319 },
  demoDev: { ui: 4319, api: 4320 },
} as const;

/**
 * Resolves runtime configuration from argv and environment:
 * - `--dev` runs the API only, behind Vite (ports 4317 → 4318).
 * - `REVIEW_DESK_MODE=demo` uses an in-memory GitHub scenario and a separate data directory.
 * - `REVIEW_DESK_DATA_DIR` and `REVIEW_DESK_PORT` override defaults (used by e2e tests).
 */
export function loadConfig(argv = process.argv, env = process.env): Config {
  const viteDev = argv.includes('--dev');
  const mode: Mode =
    env.REVIEW_DESK_MODE === 'demo' ? 'demo' : viteDev ? 'development' : 'production';
  const ports =
    mode === 'demo'
      ? viteDev
        ? PORTS.demoDev
        : PORTS.demo
      : viteDev
        ? PORTS.development
        : PORTS.production;

  const projectRoot = fileURLToPath(
    new URL(import.meta.url.includes('/dist/') ? '../../' : '../', import.meta.url),
  );
  const port = Number(env.REVIEW_DESK_PORT) || ports.api;
  const uiPort = env.REVIEW_DESK_PORT && !viteDev ? port : ports.ui;
  const dataDir = resolve(
    projectRoot,
    env.REVIEW_DESK_DATA_DIR ?? (mode === 'demo' ? '.data-demo' : '.data'),
  );

  return {
    mode,
    viteDev,
    port,
    allowedPorts: [...new Set([port, uiPort])],
    projectRoot,
    dataDir,
    databasePath: resolve(dataDir, 'review-desk.sqlite'),
    webRoot: viteDev ? null : resolve(projectRoot, 'dist/web'),
  };
}
