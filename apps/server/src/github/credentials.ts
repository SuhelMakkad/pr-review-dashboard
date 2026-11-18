import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { GITHUB_HOST, parseAccount, type Forge } from '@review-desk/shared/accounts';
import { GitHubError, registerSecret, safeError } from '@/github/errors.js';

/**
 * An account signed in to the GitHub CLI (github.com) or the GitLab CLI (any GitLab host). `login`
 * is the account key: the GitHub login, or `username@host` for GitLab.
 */
export interface CliAccount {
  login: string;
  forge: Forge;
  host: string;
  /** The CLI's own account for that host, which `gh` or `glab` uses in a terminal. */
  cliActive: boolean;
  /** False when the CLI could not verify this sign-in. */
  ok: boolean;
}

/** Chooses which CLI account the server works as. */
export interface GitHubAccounts {
  list(): Promise<CliAccount[]>;
  /** Pins every request to one account; null follows the GitHub CLI's active account. */
  select(login: string | null): void;
}

type Run = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const TOKEN_TTL_MS = 60_000;

/** Tokens from the environment belong to no stored account, so they cannot be selected. */
const ENVIRONMENT_SOURCES = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

const scope = new AsyncLocalStorage<string>();

/**
 * Runs `work` with GitHub requests made as `login`, even if another account is selected meanwhile.
 * Work that belongs to one account (an AI run, a queued write) uses it so a switch cannot change
 * whose credentials it continues with. It only applies once an account is selected in the app.
 */
export function asAccount<T>(login: string, work: () => T): T {
  return scope.run(login, work);
}

/** The account the current work was started as with `asAccount`, if any. */
export function scopedAccount(): string | null {
  return scope.getStore() ?? null;
}

/** Child environment for gh: never forward debug output that could print credentials. */
export function baseGhEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };

  delete env.GH_DEBUG;
  delete env.DEBUG;

  return env;
}

const runGh: Run = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

/**
 * The GitHub CLI accounts the server can use, and the environment for each `gh` call.
 *
 * Nothing is selected by default, so `gh` uses its active account as before. Once you pick an
 * account in the app, each call gets that account's token from `gh auth token --user` in its
 * `GH_TOKEN`. Tokens stay in this process's memory for a minute; they are never stored, logged
 * or sent to the browser, and `gh auth switch` is never run, so terminals are unaffected.
 */
export class GhCredentials implements GitHubAccounts {
  private selected: string | null = null;
  private readonly tokens = new Map<string, { token: Promise<string>; expiresAt: number }>();

  constructor(private readonly run: Run = runGh) {}

  select(login: string | null): void {
    this.selected = login;
  }

  async list(): Promise<CliAccount[]> {
    let result: Awaited<ReturnType<Run>>;

    try {
      result = await this.run(
        ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'],
        baseGhEnvironment(),
      );
    } catch (error) {
      throw new GitHubError(
        `GitHub CLI unavailable: ${safeError(error)}. Install gh and run gh auth login.`,
        null,
        null,
        'unavailable',
      );
    }

    // gh exits non-zero when any sign-in fails verification, but still prints every account.
    let parsed: { hosts?: Record<string, RawAccount[]> };

    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      throw new GitHubError(
        safeError(result.stderr.trim() || 'Could not list GitHub CLI accounts.'),
        null,
        null,
        'unavailable',
      );
    }

    return (parsed.hosts?.['github.com'] ?? [])
      .filter((raw) => raw.login && !ENVIRONMENT_SOURCES.has(raw.tokenSource ?? ''))
      .map((raw) => ({
        login: raw.login!,
        forge: 'github' as const,
        host: GITHUB_HOST,
        cliActive: Boolean(raw.active),
        ok: raw.state === 'success',
      }));
  }

  /** The environment for one `gh` call, carrying the token of the account it acts as. */
  async environment(): Promise<NodeJS.ProcessEnv> {
    const env = baseGhEnvironment();
    const scoped = scope.getStore();
    // Work scoped to a GitLab account (`user@host`) never runs gh; it never gets a GitHub token.
    const login = this.selected
      ? scoped && parseAccount(scoped).forge === 'github'
        ? scoped
        : this.selected
      : null;

    if (!login) return env;

    env.GH_TOKEN = await this.token(login);
    delete env.GITHUB_TOKEN;

    return env;
  }

  /** Drops cached tokens, so the next call reads them again (after GitHub rejects one). */
  forget(): void {
    this.tokens.clear();
  }

  private token(login: string): Promise<string> {
    const cached = this.tokens.get(login);

    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const token = this.read(login);

    this.tokens.set(login, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    token.catch(() => {
      if (this.tokens.get(login)?.token === token) this.tokens.delete(login);
    });

    return token;
  }

  private async read(login: string): Promise<string> {
    const notSignedIn = new GitHubError(
      `${login} is not signed in to the GitHub CLI. Run gh auth login, or pick another account.`,
      null,
      null,
      'auth',
    );
    const result = await this.run(
      ['auth', 'token', '--hostname', 'github.com', '--user', login],
      baseGhEnvironment(),
    ).catch(() => null);
    const token = result?.code === 0 ? result.stdout.trim() : '';

    if (!token) throw notSignedIn;

    registerSecret(token);

    return token;
  }
}

interface RawAccount {
  login?: string;
  active?: boolean;
  state?: string;
  tokenSource?: string;
}

/** Shared by every `gh` call the server makes, so they all act as the same account. */
export const ghCredentials = new GhCredentials();
