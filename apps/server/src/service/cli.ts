import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig, projectRoot } from '@/config.js';
import { CHECK_KEYCHAIN_SERVICE, type CheckReport } from '@/service/check.js';
import { servicePath, servicePlist } from '@/service/plist.js';
import { SERVICE_LABEL } from '@/service/runtime.js';

/** What the commands reach outside themselves: real by default, stood in by tests. */
export interface ServiceHost {
  platform: string;
  home: string;
  uid: number;
  repo: string;
  node: string;
  shellPath: string | undefined;
  /** The folder the running server keeps its data in, for the last-recorded-owner check. */
  dataFolders: string[];
  launchctl(args: string[]): { status: number; stdout: string; stderr: string };
  status(url: string): Promise<{ bootId?: string } | null>;
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  say(line: string): void;
  /** Removes a Keychain item the check made, if it is still there. */
  forget(service: string, account: string): void;
}

const realHost = (): ServiceHost => {
  const config = loadConfig(['node', 'index.js'], process.env);

  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    repo: projectRoot,
    node: realpathSync(process.execPath),
    shellPath: process.env.PATH,
    dataFolders: [
      config.dataDir,
      ...(config.dataLocation.legacy ? [config.dataLocation.legacy] : []),
    ],
    launchctl: (args) => {
      const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: 30_000 });

      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
    status: async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });

        return response.ok ? ((await response.json()) as { bootId?: string }) : null;
      } catch {
        return null;
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);

        return true;
      } catch {
        return false;
      }
    },
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    say: (line) => console.log(line),
    forget: (service, account) =>
      void spawnSync(
        '/usr/bin/security',
        ['delete-generic-password', '-s', service, '-a', account],
        {
          timeout: 5_000,
        },
      ),
  };
};

/** Where the service's own files are: its plist, and its logs and readiness record (never in the data). */
export function servicePaths(host: Pick<ServiceHost, 'home'>) {
  const logs = join(host.home, 'Library', 'Logs', 'Review Desk');

  return {
    plist: join(host.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    logs,
    out: join(logs, 'service.out.log'),
    err: join(logs, 'service.err.log'),
    ready: join(logs, 'ready.json'),
  };
}

/** The service's plist for this checkout, as `install` writes it. */
export function serverJob(host: ServiceHost) {
  const paths = servicePaths(host);

  return servicePlist({
    label: SERVICE_LABEL,
    program: [host.node, join(host.repo, 'apps', 'server', 'dist', 'index.js')],
    cwd: host.repo,
    env: { PATH: servicePath(host.shellPath, host.node), REVIEW_DESK_READY_FILE: paths.ready },
    stdout: paths.out,
    stderr: paths.err,
    keepAlive: true,
  });
}

class ServiceError extends Error {}

const READY_MS = 75_000;
const STOP_MS = 35_000;

const domain = (host: ServiceHost) => `gui/${host.uid}`;
const target = (host: ServiceHost, label = SERVICE_LABEL) => `${domain(host)}/${label}`;

/** The service's pid and state, from `launchctl print`: diagnostics, not a contract. */
function printed(host: ServiceHost, label = SERVICE_LABEL) {
  const result = host.launchctl(['print', target(host, label)]);

  if (result.status !== 0) return null;

  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(result.stdout)?.[1];

  return {
    state: field('state') ?? null,
    pid: field('pid') ? Number(field('pid')) : null,
    lastExit: field('last exit code') ?? null,
  };
}

function rotate(file: string): void {
  if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 10_000_000)
    renameSync(file, `${file}.1`);
}

function tail(file: string, lines = 40): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Waits for the job just started to say it is ready, and for the server to answer as it. */
async function ready(host: ServiceHost): Promise<{ bootId: string; port: number } | null> {
  const deadline = host.now() + READY_MS;
  const { ready: file } = servicePaths(host);

  while (host.now() < deadline) {
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as { bootId: string; port: number };
      const status = await host.status(`http://127.0.0.1:${record.port}/api/status`);

      if (status?.bootId === record.bootId) return record;
    } catch {
      // Not written yet.
    }

    await host.sleep(500);
  }

  return null;
}

/** Stops the service gracefully (launchd sends SIGTERM) and waits for its process to exit. */
async function stop(host: ServiceHost): Promise<void> {
  const before = printed(host);

  if (!before) return;

  host.launchctl(['bootout', target(host)]);

  const deadline = host.now() + STOP_MS;

  while (before.pid !== null && host.alive(before.pid)) {
    if (host.now() >= deadline)
      throw new ServiceError(`The service (pid ${before.pid}) did not stop.`);

    await host.sleep(250);
  }
}

/** Starts the loaded plist, and waits for it to be ready. */
async function start(host: ServiceHost): Promise<{ bootId: string; port: number } | null> {
  const paths = servicePaths(host);

  rmSync(paths.ready, { force: true });

  const bootstrap = host.launchctl(['bootstrap', domain(host), paths.plist]);

  if (bootstrap.status !== 0)
    throw new ServiceError(`launchctl bootstrap failed: ${bootstrap.stderr.trim()}`);

  return ready(host);
}

export async function install(host: ServiceHost): Promise<void> {
  const paths = servicePaths(host);
  const entry = join(host.repo, 'apps', 'server', 'dist', 'index.js');
  const plist = serverJob(host);

  if (!existsSync(entry)) throw new ServiceError('Build Review Desk first: pnpm build.');

  // Ours already (the same plist): loaded means installed; not loaded, it is started again.
  const ours = existsSync(paths.plist) && readFileSync(paths.plist, 'utf8') === plist;

  if (ours && printed(host)) {
    host.say('Review Desk is already installed as a service. See pnpm service status.');

    return;
  }

  if (existsSync(paths.plist) && !ours)
    throw new ServiceError(
      `${paths.plist} already exists for another setup. Run pnpm service uninstall first.`,
    );

  if (printed(host))
    throw new ServiceError(
      'A Review Desk service is already loaded. Run pnpm service uninstall first.',
    );

  // Read, never taken: the data lock decides once the service starts.
  for (const folder of host.dataFolders) {
    try {
      const owner = JSON.parse(readFileSync(join(folder, 'review-desk.owner.json'), 'utf8')) as {
        pid?: number;
      };

      if (owner.pid && host.alive(owner.pid))
        throw new ServiceError(
          `Stop the Review Desk using ${folder} first (last recorded owner: pid ${owner.pid}).`,
        );
    } catch (error) {
      if (error instanceof ServiceError) throw error;
    }
  }

  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(join(host.home, 'Library', 'LaunchAgents'), { recursive: true });
  rotate(paths.out);
  rotate(paths.err);

  // Undone on failure, and only what this install did.
  if (!ours) writeFileSync(paths.plist, plist, { mode: 0o644 });

  let loaded = false;

  try {
    rmSync(paths.ready, { force: true });

    const bootstrap = host.launchctl(['bootstrap', domain(host), paths.plist]);

    if (bootstrap.status !== 0)
      throw new ServiceError(`launchctl bootstrap failed: ${bootstrap.stderr.trim()}`);

    loaded = true;

    const started = await ready(host);

    if (!started) throw new ServiceError('The service did not become ready.');

    host.say(`Review Desk runs as a service → http://127.0.0.1:${started.port}`);
  } catch (error) {
    if (loaded) host.launchctl(['bootout', target(host)]);
    if (!ours) rmSync(paths.plist, { force: true });

    const log = tail(paths.err);

    throw new ServiceError(`${(error as Error).message}${log ? `\n${log}` : ''}`);
  }
}

export async function uninstall(host: ServiceHost): Promise<void> {
  const paths = servicePaths(host);

  await stop(host);
  rmSync(paths.plist, { force: true });
  rmSync(paths.ready, { force: true });
  host.say('Review Desk no longer runs as a service.');
}

export async function restart(host: ServiceHost): Promise<void> {
  const paths = servicePaths(host);

  if (!existsSync(paths.plist))
    throw new ServiceError('Review Desk is not installed as a service.');

  await stop(host);
  rotate(paths.out);
  rotate(paths.err);

  const started = await start(host);

  if (!started) {
    const log = tail(paths.err);

    throw new ServiceError(`The service did not become ready again.${log ? `\n${log}` : ''}`);
  }

  host.say(`Review Desk restarted → http://127.0.0.1:${started.port}`);
}

export async function status(host: ServiceHost): Promise<void> {
  const job = printed(host);

  if (!job) {
    host.say('Review Desk is not running as a service.');

    return;
  }

  host.say(
    `Service: ${job.state ?? 'unknown'}${job.pid ? `, pid ${job.pid}` : ''}${job.lastExit ? `, last exit ${job.lastExit}` : ''} (from launchctl, best-effort)`,
  );

  try {
    const record = JSON.parse(readFileSync(servicePaths(host).ready, 'utf8')) as { port: number };
    const origin = `http://127.0.0.1:${record.port}`;
    const server = await host.status(`${origin}/api/status`);
    const linear = (await host.status(`${origin}/api/linear/status`)) as {
      connected?: boolean;
      method?: string | null;
    } | null;

    host.say(server ? `Answering at ${origin}` : `Not answering at ${origin}`);

    if (linear)
      host.say(
        `Linear: ${linear.connected ? `connected${linear.method ? ` (${linear.method})` : ''}` : 'not connected'}`,
      );
  } catch {
    host.say('Not ready yet.');
  }
}

/**
 * Runs the check script once as a launchd job, as the service would run, and reports what it
 * could reach. Leaves nothing behind: the job and its plist are removed, and its Keychain item.
 */
export async function check(host: ServiceHost): Promise<CheckReport | null> {
  const folder = mkdtempSync(join(tmpdir(), 'review-desk-check-'));
  const id = randomBytes(6).toString('hex');
  const label = `dev.reviewdesk.check.${id}`;
  const account = `check-${id}`;
  const report = join(folder, 'report.json');
  const plist = join(folder, `${label}.plist`);
  const leftovers: string[] = [];
  let finished = false;
  const cleanUp = () => {
    if (finished) return;

    finished = true;

    if (printed(host, label)) host.launchctl(['bootout', target(host, label)]);
    if (printed(host, label)) leftovers.push(`launchd job ${label}`);

    host.forget(CHECK_KEYCHAIN_SERVICE, account);
    rmSync(plist, { force: true });
  };
  const interrupted = () => {
    cleanUp();
    process.exit(1);
  };

  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);

  try {
    writeFileSync(
      plist,
      servicePlist({
        label,
        program: [
          host.node,
          join(host.repo, 'apps', 'server', 'dist', 'service', 'check.js'),
          report,
          account,
        ],
        cwd: host.repo,
        env: { PATH: servicePath(host.shellPath, host.node) },
        stdout: join(folder, 'check.out.log'),
        stderr: join(folder, 'check.err.log'),
        keepAlive: false,
      }),
    );

    if (host.launchctl(['bootstrap', domain(host), plist]).status !== 0)
      throw new ServiceError('launchctl bootstrap failed for the check job.');

    host.launchctl(['kickstart', target(host, label)]);

    const deadline = host.now() + 30_000;

    while (host.now() < deadline && !existsSync(report)) await host.sleep(250);

    const result = existsSync(report)
      ? (JSON.parse(readFileSync(report, 'utf8')) as CheckReport)
      : null;

    cleanUp();

    if (result) result.leftovers.push(...leftovers);

    return result;
  } finally {
    cleanUp();
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    rmSync(folder, { recursive: true, force: true });

    for (const leftover of leftovers) host.say(`Could not remove ${leftover}: remove it by hand.`);
  }
}

function describe(report: CheckReport, say: (line: string) => void): void {
  for (const [tool, found] of Object.entries(report.tools))
    say(
      `${tool}: ${found.path ? `${found.path} (${found.version ?? 'version unknown'})` : 'not found'}`,
    );

  for (const entry of report.github ?? [])
    say(
      `GitHub ${entry.host} ${entry.login}${entry.active ? ' (active)' : ''}: ${entry.ok ? 'signed in' : 'not working'}`,
    );

  for (const entry of report.gitlab ?? [])
    say(`GitLab ${entry.host}: ${entry.ok ? 'signed in' : 'not working'}`);

  if (report.codexSignedIn !== null)
    say(`Codex: ${report.codexSignedIn ? 'signed in' : 'not signed in'}`);

  say(`Keychain: ${report.keychain === 'ok' ? 'works' : report.keychain}`);
  say(
    report.tools['terminal-notifier']?.path
      ? 'Notifications: clicking one opens its PR.'
      : 'Notifications: clicking one opens Script Editor. Install terminal-notifier (brew install terminal-notifier) to open the PR.',
  );
}

export async function main(argv: string[], host: ServiceHost = realHost()): Promise<number> {
  const command = argv[0];

  if (host.platform !== 'darwin') {
    host.say('pnpm service runs Review Desk as a launchd service, on macOS only.');

    return 1;
  }

  try {
    if (command === 'install') await install(host);
    else if (command === 'uninstall') await uninstall(host);
    else if (command === 'restart') await restart(host);
    else if (command === 'status') await status(host);
    else if (command === 'check') {
      const report = await check(host);

      if (!report) {
        host.say('The check job did not report within 30 s.');

        return 1;
      }

      describe(report, host.say);
    } else {
      host.say('Usage: pnpm service <install|uninstall|restart|status|check>');

      return 1;
    }

    return 0;
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;

    host.say(error.message);

    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = await main(process.argv.slice(2));
