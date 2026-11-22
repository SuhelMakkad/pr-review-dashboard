/**
 * Where a Review Desk process runs: its ports and its data folder. Shared by the server and Vite's
 * dev server, so both resolve the same ones. Free of Node itself: callers pass their path functions.
 */

export type RuntimeMode = 'production' | 'development' | 'demo';

/** The UI's port and the API's, for each way of running (the same port when nothing proxies). */
export const PORTS = {
  production: { ui: 4317, api: 4317 },
  development: { ui: 4317, api: 4318 },
  demo: { ui: 4319, api: 4319 },
  demoDev: { ui: 4319, api: 4320 },
} as const;

type Env = Record<string, string | undefined>;

/** The ports in use: `REVIEW_DESK_PORT` moves the API's (and, with no proxy, the UI's with it). */
export function runtimePorts(options: { demo: boolean; viteDev: boolean; env: Env }): {
  api: number;
  ui: number;
} {
  const ports = options.demo
    ? options.viteDev
      ? PORTS.demoDev
      : PORTS.demo
    : options.viteDev
      ? PORTS.development
      : PORTS.production;
  const api = Number(options.env.REVIEW_DESK_PORT) || ports.api;

  return { api, ui: options.env.REVIEW_DESK_PORT && !options.viteDev ? api : ports.ui };
}

/** The path functions of the platform the folder is on (`node:path`, or its `posix`/`win32`). */
export interface PathFunctions {
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
  isAbsolute(path: string): boolean;
}

export interface DataLocation {
  directory: string;
  /** Why it is there: named by `REVIEW_DESK_DATA_DIR`, demo mode's own, or the OS's. */
  kind: 'override' | 'demo' | 'os';
  /** For the OS's: the folder each checkout used before, whose data moves there once. */
  legacy: string | null;
}

/**
 * The data folder. `REVIEW_DESK_DATA_DIR` wins (relative to the repository); demo mode keeps its
 * own disposable folder in the checkout; otherwise `pnpm start` and `pnpm dev` share the OS's
 * per-user application data folder.
 */
export function dataLocation(options: {
  env: Env;
  platform: string;
  home: string;
  projectRoot: string;
  mode: RuntimeMode;
  path: PathFunctions;
}): DataLocation {
  const { env, path, projectRoot } = options;

  if (env.REVIEW_DESK_DATA_DIR)
    return {
      directory: path.resolve(projectRoot, env.REVIEW_DESK_DATA_DIR),
      kind: 'override',
      legacy: null,
    };

  if (options.mode === 'demo')
    return { directory: path.resolve(projectRoot, '.data-demo'), kind: 'demo', legacy: null };

  const absolute = (value: string | undefined) => (value && path.isAbsolute(value) ? value : null);
  const directory =
    options.platform === 'darwin'
      ? path.join(options.home, 'Library', 'Application Support', 'Review Desk')
      : options.platform === 'win32'
        ? path.join(
            absolute(env.LOCALAPPDATA) ?? path.join(options.home, 'AppData', 'Local'),
            'Review Desk',
          )
        : path.join(
            absolute(env.XDG_DATA_HOME) ?? path.join(options.home, '.local', 'share'),
            'review-desk',
          );

  return { directory, kind: 'os', legacy: path.resolve(projectRoot, '.data') };
}
