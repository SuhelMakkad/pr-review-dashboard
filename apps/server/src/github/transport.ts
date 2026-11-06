import { spawn } from 'node:child_process';
import { GitHubError, safeError } from '@/github/errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface GitHubRequest {
  method?: HttpMethod;
  path: string;
  accept?: string;
  body?: unknown;
}

export interface GitHubResponse<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

export interface GitHubTransport {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  rest<T>(path: string): Promise<T>;
  /** Full HTTP access (status, headers, media types). Optional so lightweight fakes stay small. */
  request?<T>(request: GitHubRequest): Promise<GitHubResponse<T>>;
}

const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

const rateLimited = (message: string) => /rate limit|secondary rate|abuse|HTTP 429/i.test(message);

export function retryAtFromHeaders(
  headers: Record<string, string>,
  now = Date.now(),
): string | null {
  const retryAfter = Number(headers['retry-after']);

  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return new Date(now + retryAfter * 1000).toISOString();

  if (headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(headers['x-ratelimit-reset']);

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

/** Child environment for gh: never forward debug output that could print credentials. */
function ghEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.GH_DEBUG;
  delete env.DEBUG;

  return env;
}

export class GhCli implements GitHubTransport {
  constructor(private readonly timeoutMs = 35_000) {}

  private spawn(args: string[], input?: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('gh', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: ghEnvironment(),
      });
      let stdout = '';
      let stderr = '';
      let size = 0;
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);

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
        reject(
          new GitHubError(
            `GitHub CLI unavailable: ${safeError(error)}. Install gh and run gh auth login.`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr, timedOut });
      });

      child.stdin.end(input);
    });
  }

  private async run(args: string[], input?: string): Promise<string> {
    const result = await this.spawn(args, input);

    if (result.code === 0) return result.stdout;

    const message = result.timedOut
      ? 'GitHub request timed out; cached data is still available.'
      : safeError(result.stderr.trim() || 'GitHub request failed. Check gh auth status.');

    throw new GitHubError(
      message,
      rateLimited(message) ? new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS).toISOString() : null,
    );
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const raw = await this.run(
      ['api', '--hostname', 'github.com', 'graphql', '--input', '-'],
      JSON.stringify({ query, variables }),
    );
    const result = JSON.parse(raw) as { data: T; errors?: { message: string; type?: string }[] };

    if (result.errors?.length) {
      const message = result.errors.map((error) => error.message).join('; ');

      throw new GitHubError(
        safeError(message),
        /rate.limit/i.test(message)
          ? new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS).toISOString()
          : null,
      );
    }

    return result.data;
  }

  async rest<T>(path: string): Promise<T> {
    return JSON.parse(
      await this.run(['api', '--hostname', 'github.com', '--method', 'GET', path]),
    ) as T;
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--include',
      '--method',
      request.method ?? 'GET',
    ];

    if (request.accept) args.push('-H', `Accept: ${request.accept}`);
    if (request.body !== undefined) args.push('--input', '-');

    args.push(request.path);

    const result = await this.spawn(
      args,
      request.body === undefined ? undefined : JSON.stringify(request.body),
    );

    if (result.timedOut) throw new GitHubError('GitHub request timed out.');

    // gh exits non-zero on HTTP errors but still prints the status line, headers and body.
    const parsed = parseIncludedResponse(result.stdout);

    if (!parsed) {
      throw new GitHubError(
        safeError(result.stderr.trim() || 'GitHub request failed. Check gh auth status.'),
      );
    }

    const isJson = parsed.headers['content-type']?.includes('json') ?? false;
    const data = (isJson && parsed.body ? JSON.parse(parsed.body) : parsed.body) as T;

    if (parsed.status === 403 || parsed.status === 429) {
      const retryAt = retryAtFromHeaders(parsed.headers);

      if (retryAt || rateLimited(parsed.body)) {
        throw new GitHubError(
          'GitHub rate limit reached.',
          retryAt ?? new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS).toISOString(),
          parsed.status,
        );
      }
    }

    return { status: parsed.status, headers: parsed.headers, data };
  }
}

export function parseIncludedResponse(
  output: string,
): { status: number; headers: Record<string, string>; body: string } | null {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(output);

  if (!match) return null;

  const separator = output.search(/\r?\n\r?\n/);
  const head = separator === -1 ? output : output.slice(0, separator);
  const body = separator === -1 ? '' : output.slice(separator).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};

  for (const line of head.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':');

    if (index > 0)
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  return { status: Number(match[1]), headers, body };
}
