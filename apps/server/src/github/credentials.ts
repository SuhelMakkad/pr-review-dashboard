import type { CliAccount } from '@/forge/types.js';
import { AccountUnavailable } from '@/forge/account.js';
import { spawn } from 'node:child_process';
import { GITHUB_HOST } from '@review-desk/shared/accounts';
import { GitHubError, registerSecret, safeError } from '@/github/errors.js';

export type { CliAccount };

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

/**
 * Where a `gh` call gets its credentials: the environment to run it with, and a way to drop a
 * token GitHub rejected so the next call reads it again.
 */
export interface CredentialSource {
  environment(): Promise<NodeJS.ProcessEnv>;
  forget(): void;
}

/** Tokens a `gh` call would take from the environment instead of the account it asks for. */
const AMBIENT_TOKENS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

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
 * account in the app, or work names one, each call gets that account's token from
 * `gh auth token --user` in its `GH_TOKEN`. Tokens stay in this process's memory for a minute; they are never stored, logged
 * or sent to the browser, and `gh auth switch` is never run, so terminals are unaffected.
 */
export class GhCredentials implements GitHubAccounts, CredentialSource {
  private selected: string | null = null;
  private readonly tokens = new Map<string, { token: Promise<string>; expiresAt: number }>();
  /** Whose the token in the server's environment is, read once per token value. */
  private ambient: { token: string; login: Promise<string | null> } | null = null;

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

  /**
   * The environment for a `gh` call made as the selected account, else as gh's own (nothing set).
   * Work that belongs to one account binds to it instead (`bind`).
   */
  async environment(): Promise<NodeJS.ProcessEnv> {
    const env = baseGhEnvironment();

    if (!this.selected) return env;

    env.GH_TOKEN = await this.token(this.selected);
    delete env.GITHUB_TOKEN;

    return env;
  }

  /**
   * Credentials for work that belongs to `login` (an AI run, a queued write, a request for one
   * account's PRs), for as long as it runs, whatever is selected meanwhile. Which token it uses is
   * settled once, and nothing is read until a call needs it:
   * - An account selected when it is bound is a stored sign-in (the list leaves out tokens from the
   *   environment), and keeps that sign-in's token, even when a token in the environment has the
   *   same login: the two can grant different access.
   * - Another account uses the environment's token if that token is verified to be its own.
   * - Otherwise the account's stored sign-in; without one the call fails, never falling back to
   *   someone else's token.
   */
  bind(login: string): CredentialSource {
    const selected = login === this.selected;
    /** The environment's token once it is known to be this account's; null once known not to be. */
    let ambient: string | null | undefined = selected ? null : undefined;

    return {
      environment: async () => {
        const env = baseGhEnvironment();

        if (ambient === undefined) {
          const found = await this.ambientLogin();

          // Settled by this first call either way: an unanswered check means the stored sign-in,
          // and this binding keeps it, so its access never changes midway. A new one asks again.
          ambient = found?.login === login ? found.token : null;
        }

        // Exactly the token that was verified, whatever else the environment holds.
        if (ambient) {
          env.GH_TOKEN = ambient;
          delete env.GITHUB_TOKEN;

          return env;
        }

        env.GH_TOKEN = await this.token(login).catch((error: unknown) => {
          // Work for an account other than the selected one cannot fall back to another's.
          if (!selected && error instanceof GitHubError && error.outcome === 'auth')
            throw new AccountUnavailable(login, null);

          throw error;
        });
        delete env.GITHUB_TOKEN;

        return env;
      },
      forget: () => this.tokens.delete(login),
    };
  }

  /**
   * With nothing selected, the credentials gh would use right now, held for the rest of the work:
   * the environment's token, else the token of gh's active account. A sync that finds out whose
   * they are stays that account's, even if gh switches its active account meanwhile. Null when
   * there is neither.
   */
  async pin(): Promise<CredentialSource | null> {
    let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

    if (!token) {
      // Without the environment's tokens, so gh answers for its active stored sign-in.
      const env = baseGhEnvironment();

      for (const name of AMBIENT_TOKENS) delete env[name];

      const result = await this.run(['auth', 'token', '--hostname', 'github.com'], env).catch(
        () => null,
      );

      token = result?.code === 0 ? result.stdout.trim() : '';
    }

    if (!token) return null;

    registerSecret(token);

    return {
      environment: async () => {
        const env = baseGhEnvironment();

        env.GH_TOKEN = token;
        delete env.GITHUB_TOKEN;

        return env;
      },
      // A pinned token is the work's own: it is not swapped for whatever gh holds next.
      forget: () => undefined,
    };
  }

  /**
   * The login of the token in the server's environment, if there is one, verified with GitHub
   * once per token. A failed check counts as unknown and is tried again next time.
   */
  private async ambientLogin(): Promise<{ token: string; login: string } | null> {
    // gh's own order for github.com; the Enterprise variables are for other hosts.
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

    if (!token) return null;
    if (this.ambient?.token === token) {
      const known = await this.ambient.login;

      return known ? { token, login: known } : null;
    }

    // With only that token, so the answer is the token's and nothing else's.
    const probe = baseGhEnvironment();

    for (const name of AMBIENT_TOKENS) delete probe[name];
    probe.GH_TOKEN = token;

    const login = this.run(['api', 'user', '--hostname', 'github.com', '--jq', '.login'], probe)
      .then((result) => (result.code === 0 ? result.stdout.trim() || null : null))
      .catch(() => null);

    this.ambient = { token, login };

    const verified = await login;

    if (verified === null && this.ambient?.login === login) this.ambient = null;

    return verified ? { token, login: verified } : null;
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
    // Without the environment's tokens, so gh answers for the stored sign-in it is asked about.
    const env = baseGhEnvironment();

    for (const name of AMBIENT_TOKENS) delete env[name];

    const result = await this.run(
      ['auth', 'token', '--hostname', 'github.com', '--user', login],
      env,
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
