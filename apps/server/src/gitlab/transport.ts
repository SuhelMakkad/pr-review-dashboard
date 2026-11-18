import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubError, safeError } from '@/github/errors.js';
import { parseIncludedResponse, type HttpMethod } from '@/github/transport.js';

export interface GitLabRequest {
  method?: HttpMethod;
  /** A REST v4 path such as `projects/12/merge_requests/3`, or `graphql`. */
  path: string;
  body?: unknown;
}

export interface GitLabResponse<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

/** HTTP access to one GitLab host. Every status is returned; only transport failures throw. */
export interface GitLabTransport {
  readonly host: string;
  request<T>(request: GitLabRequest): Promise<GitLabResponse<T>>;
}

const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Variables glab would otherwise apply to every host: a token from the environment would act as
 * someone other than the account picked in the app, and an API host or default host could send a
 * request, with its token, somewhere other than `--hostname`. Accounts come only from glab's own
 * stored sign-ins, as GitHub accounts come only from the GitHub CLI's.
 */
const GLOBAL_OVERRIDES = [
  'GITLAB_TOKEN',
  'GITLAB_ACCESS_TOKEN',
  'OAUTH_TOKEN',
  'CI_JOB_TOKEN',
  'GLAB_ENABLE_CI_AUTOLOGIN',
  'GITLAB_API_HOST',
  'GITLAB_SUBFOLDER',
  'GLAB_API_PROTOCOL',
  'API_PROTOCOL',
  'GITLAB_HOST',
  'GITLAB_URI',
  'GL_HOST',
];

/** Debug output that would print request headers, credentials included. */
const DEBUG_OUTPUT = ['GLAB_DEBUG', 'GLAB_DEBUG_HTTP', 'DEBUG', 'FORCE_HYPERLINKS'];

let cwd: string | null = null;

/**
 * glab reads per-repository settings (and picks a host) from the Git directory it runs in. It runs
 * from a private, empty directory of its own, made on first use and removed on exit, with Git told
 * not to look above it (or at a `GIT_DIR` from the environment), so only your own glab
 * configuration for the host applies.
 */
export function glabCwd(): string {
  if (cwd) return cwd;

  const created = mkdtempSync(join(realpathSync(tmpdir()), 'review-desk-glab-'));

  process.once('exit', () => rmSync(created, { recursive: true, force: true }));
  cwd = created;

  return created;
}

/** Child environment for glab: no prompts, update checks, telemetry or hyperlinks. */
export function baseGlabEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GLAB_NO_PROMPT: '1',
    GLAB_CHECK_UPDATE: 'false',
    GLAB_SEND_TELEMETRY: 'false',
    GLAB_DISPLAY_HYPERLINKS: 'false',
    NO_COLOR: '1',
    // Git compares the ceiling with the real path (macOS's temp directory is under /private).
    GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()),
  };

  for (const name of [...GLOBAL_OVERRIDES, ...DEBUG_OUTPUT, 'GIT_DIR', 'GIT_WORK_TREE'])
    delete env[name];

  return env;
}

export function glabUnavailable(error: unknown): GitHubError {
  return new GitHubError(
    `GitLab CLI unavailable: ${safeError(error)}. Install glab and run glab auth login.`,
    null,
    null,
    'unavailable',
  );
}

/** When GitLab asks clients to wait: `Retry-After`, or the reset time of an exhausted limit. */
export function gitlabRetryAt(headers: Record<string, string>, now = Date.now()): string | null {
  const retryAfter = Number(headers['retry-after']);

  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return new Date(now + retryAfter * 1000).toISOString();

  if (headers['ratelimit-remaining'] === '0') {
    const reset = Number(headers['ratelimit-reset']);

    if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000).toISOString();
  }

  return null;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type GlabRunner = (args: string[], input: string | undefined) => Promise<RunResult>;

export function spawnGlab(timeoutMs: number): GlabRunner {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn('glab', args, {
        cwd: glabCwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: baseGlabEnvironment(),
      });
      let stdout = '';
      let stderr = '';
      let size = 0;
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        size += chunk.length;

        if (size > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM');
          return;
        }

        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(glabUnavailable(error));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr, timedOut });
      });

      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
}

/**
 * Calls the GitLab API with `glab api`, as the GitLab CLI's account for one host. glab finds the
 * API endpoint, protocol, token, CA certificate and client certificate for that host in its own
 * configuration; Review Desk never reads the token.
 */
export class GlabCli implements GitLabTransport {
  constructor(
    readonly host: string,
    private readonly run: GlabRunner = spawnGlab(35_000),
  ) {}

  async request<T>(request: GitLabRequest): Promise<GitLabResponse<T>> {
    const args = ['api', '--hostname', this.host, '--include', '--method', request.method ?? 'GET'];

    if (request.body !== undefined) args.push('--input', '-');

    args.push(request.path);

    const result = await this.run(
      args,
      request.body === undefined ? undefined : JSON.stringify(request.body),
    );

    if (result.timedOut) throw new GitHubError('GitLab request timed out.');

    // glab exits non-zero on HTTP errors but still prints the status line, headers and body.
    const parsed = parseIncludedResponse(result.stdout);

    if (!parsed) {
      const message = safeError(
        result.stderr.trim() ||
          `GitLab request failed. Check glab auth status --hostname ${this.host}.`,
      );

      throw new GitHubError(
        message,
        null,
        null,
        /401|unauthori[sz]ed|not logged|no token|authenticat/i.test(message) ? 'auth' : 'unknown',
      );
    }

    const isJson = parsed.headers['content-type']?.includes('json') ?? false;
    let data: T;

    try {
      data = (isJson && parsed.body ? JSON.parse(parsed.body) : parsed.body) as T;
    } catch {
      throw new GitHubError('GitLab returned an unreadable response.', null, parsed.status);
    }

    if (parsed.status === 429) {
      throw new GitHubError(
        'GitLab rate limit reached.',
        gitlabRetryAt(parsed.headers) ??
          new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS).toISOString(),
        429,
        'rate_limit',
      );
    }

    return { status: parsed.status, headers: parsed.headers, data };
  }
}

/** GitLab's `{ message }` or `{ error }` body, as one line for an error message. */
export function gitlabMessage(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 300);
  if (!data || typeof data !== 'object') return '';

  const body = data as { message?: unknown; error?: unknown; error_description?: unknown };
  const message = body.message ?? body.error_description ?? body.error;

  return typeof message === 'string' ? message : message ? JSON.stringify(message) : '';
}

/** A failed response as a `GitHubError` whose outcome says whether the request took effect. */
export function responseError(
  response: GitLabResponse<unknown>,
  action: string,
  method: HttpMethod = 'GET',
): GitHubError {
  const detail = gitlabMessage(response.data);
  const status = response.status;
  const message = safeError(`${action} (HTTP ${status})${detail ? `: ${detail}` : ''}`);

  // A server error on a write may have been applied anyway.
  const outcome =
    status === 401
      ? 'auth'
      : status >= 500
        ? method === 'GET'
          ? 'unavailable'
          : 'unknown'
        : 'rejected';

  return new GitHubError(message, null, status, outcome);
}

/** Sends a request and returns its JSON body, throwing for any HTTP error. */
export async function call<T>(
  transport: GitLabTransport,
  request: GitLabRequest,
  action: string,
): Promise<T> {
  const response = await transport.request<T>(request);

  if (response.status >= 400) throw responseError(response, action, request.method);

  return response.data;
}

/**
 * Reads every page of a list endpoint, following `X-Next-Page` or a `Link` header, up to
 * `maxPages` pages of `perPage` items.
 */
export async function paginate<T>(
  transport: GitLabTransport,
  path: string,
  action: string,
  maxPages = 50,
  perPage = 100,
): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes('?') ? '&' : '?';
  let next: string | null = `${path}${separator}per_page=${perPage}`;

  for (let page = 0; next && page < maxPages; page++) {
    const response: GitLabResponse<T[]> = await transport.request<T[]>({ path: next });

    if (response.status >= 400) throw responseError(response, action);
    if (!Array.isArray(response.data)) throw new GitHubError(`${action}: unexpected response.`);

    items.push(...response.data);

    const nextPage = response.headers['x-next-page'];
    const link = /<([^>]+)>;\s*rel="next"/.exec(response.headers.link ?? '')?.[1];

    next = nextPage
      ? `${path}${separator}per_page=${perPage}&page=${encodeURIComponent(nextPage)}`
      : link
        ? relativeApiPath(link)
        : null;
  }

  return items;
}

/** `https://host/api/v4/projects?...` → `projects?...`, for following keyset pagination links. */
function relativeApiPath(link: string): string | null {
  const index = link.indexOf('/api/v4/');

  return index === -1 ? null : link.slice(index + '/api/v4/'.length);
}
