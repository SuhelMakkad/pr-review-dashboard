import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The Keychain service the check's throwaway item is filed under; its account is per run. */
export const CHECK_KEYCHAIN_SERVICE = 'Review Desk check';

export interface Command {
  status: number | null;
  stdout: string;
}

/** Runs a command with arguments (never a shell), bounded at 10 s. */
export type Exec = (command: string, args: string[]) => Command;

const exec: Exec = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });

  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

export interface CheckReport {
  tools: Record<string, { path: string | null; version: string | null }>;
  github: { host: string; login: string; active: boolean; ok: boolean }[] | null;
  gitlab: { host: string; ok: boolean }[] | null;
  codexSignedIn: boolean | null;
  keychain: 'ok' | 'mismatch' | 'failed';
  /** Left behind when cleanup failed: named so they can be removed by hand. */
  leftovers: string[];
}

const TOOLS: [string, string][] = [
  ['node', '--version'],
  ['gh', '--version'],
  ['glab', '--version'],
  ['codex', '--version'],
  ['claude', '--version'],
  ['terminal-notifier', '-version'],
];

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? null;

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * What the service's context can reach, as `pnpm service check` reports it: each tool's path and
 * version, each GitHub and GitLab sign-in (host, login, whether it works: never a token or raw
 * output), whether Codex is signed in, and a Keychain round trip on a throwaway item of its own.
 */
export function runCheck(account: string, run: Exec = exec): CheckReport {
  const tools: CheckReport['tools'] = {};

  for (const [tool, flag] of TOOLS) {
    const where = run('/usr/bin/which', [tool]);
    const path = where.status === 0 ? firstLine(where.stdout) : null;

    tools[tool] = { path, version: path ? firstLine(run(tool, [flag]).stdout) : null };
  }

  // Sign-ins as listed, never refreshed: `--no-refresh` where `gh` has it.
  const ghHelp = tools.gh.path ? run('gh', ['auth', 'status', '--help']).stdout : '';
  const ghArgs = [
    'auth',
    'status',
    '--json',
    'hosts',
    ...(ghHelp.includes('--no-refresh') ? ['--no-refresh'] : []),
  ];
  const ghHosts = tools.gh.path
    ? (json(run('gh', ghArgs).stdout) as {
        hosts?: Record<string, { login?: string; active?: boolean; state?: string }[]>;
      } | null)
    : null;
  const github = ghHosts?.hosts
    ? Object.entries(ghHosts.hosts).flatMap(([host, accounts]) =>
        accounts.map((entry) => ({
          host,
          login: entry.login ?? '',
          active: entry.active === true,
          ok: entry.state === 'success',
        })),
      )
    : null;
  const glabHosts = tools.glab.path
    ? json(run('glab', ['auth', 'status', '--all', '--output', 'json']).stdout)
    : null;
  const glabList = (glabHosts as { hosts?: { host?: string; state?: string }[] } | null)?.hosts;
  const gitlab = Array.isArray(glabList)
    ? glabList.map((entry) => ({ host: entry.host ?? '', ok: entry.state === 'success' }))
    : null;
  const codexSignedIn = tools.codex.path ? run('codex', ['login', 'status']).status === 0 : null;

  // A throwaway item of its own: no existing item is read, so no prompt is shown.
  const secret = randomBytes(32).toString('hex');
  const item = ['-s', CHECK_KEYCHAIN_SERVICE, '-a', account];
  const added =
    run('/usr/bin/security', ['add-generic-password', ...item, '-w', secret]).status === 0;
  const read = added ? run('/usr/bin/security', ['find-generic-password', ...item, '-w']) : null;
  const removed = run('/usr/bin/security', ['delete-generic-password', ...item]).status === 0;
  const keychain =
    !added || read?.status !== 0 ? 'failed' : firstLine(read.stdout) === secret ? 'ok' : 'mismatch';

  return {
    tools,
    github,
    gitlab,
    codexSignedIn,
    keychain,
    leftovers:
      added && !removed ? [`Keychain item "${CHECK_KEYCHAIN_SERVICE}" for ${account}`] : [],
  };
}

/** Written whole, so the CLI never reads half a report. */
export function writeReport(path: string, report: CheckReport): void {
  const draft = `${path}.tmp`;

  writeFileSync(draft, JSON.stringify(report), { mode: 0o600 });
  renameSync(draft, path);
}

// Run by the check job: `node check.js <report path> <keychain account>`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [reportPath, account] = process.argv.slice(2);
  const clean = () =>
    void spawnSync(
      '/usr/bin/security',
      ['delete-generic-password', '-s', CHECK_KEYCHAIN_SERVICE, '-a', account!],
      {
        timeout: 5_000,
      },
    );

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      clean();
      process.exit(1);
    });

  writeReport(reportPath!, runCheck(account!));
}
