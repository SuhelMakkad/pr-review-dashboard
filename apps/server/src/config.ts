import { homedir } from 'node:os';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataLocation, runtimePorts, type DataLocation } from '@review-desk/shared/runtime';

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
  /** Where `dataDir` came from, and the folder whose data moves there once (`resolveDataDirectory`). */
  dataLocation: DataLocation;
  databasePath: string;
  webRoot: string | null;
}

/** These paths are stable in both `src/` (tsx) and the built `dist/` directory. */
export const serverRoot = fileURLToPath(new URL('../', import.meta.url));
export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Resolves runtime configuration from argv and environment:
 * - `--dev` runs the API only, behind Vite (ports 4317 → 4318).
 * - `REVIEW_DESK_MODE=demo` uses an in-memory GitHub scenario and a separate data directory.
 * - `REVIEW_DESK_DATA_DIR` and `REVIEW_DESK_PORT` override defaults (used by e2e tests).
 * - Otherwise the data lives in the OS's per-user application data folder (see `dataLocation`).
 */
export function loadConfig(
  argv = process.argv,
  env = process.env,
  host: { platform?: string; home?: string; root?: string } = {},
): Config {
  const viteDev = argv.includes('--dev');
  const mode: Mode =
    env.REVIEW_DESK_MODE === 'demo' ? 'demo' : viteDev ? 'development' : 'production';
  const { api: port, ui: uiPort } = runtimePorts({ demo: mode === 'demo', viteDev, env });
  const root = host.root ?? projectRoot;
  const location = dataLocation({
    env,
    platform: host.platform ?? process.platform,
    home: host.home ?? homedir(),
    projectRoot: root,
    mode,
    path,
  });
  const dataDir = location.directory;

  return {
    mode,
    viteDev,
    port,
    allowedPorts: [...new Set([port, uiPort])],
    projectRoot: root,
    dataDir,
    dataLocation: location,
    databasePath: resolve(dataDir, 'review-desk.sqlite'),
    webRoot: viteDev ? null : resolve(projectRoot, 'apps/web/dist'),
  };
}
