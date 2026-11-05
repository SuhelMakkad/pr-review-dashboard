import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AiEffort, AiProvider } from '../../shared/ai.js';
import { redact } from '../github/errors.js';

export interface AgentRequest {
  /** Instructions (system role). */
  instructions: string;
  /** The task input, including untrusted PR content; sent on stdin. */
  input: string;
  /** Strict JSON Schema the final answer must satisfy. */
  schema: Record<string, unknown>;
  effort: AiEffort;
  model: string | null;
  /** Private, empty working directory for this run. */
  workDir: string;
  timeoutMs: number;
}

export interface AgentResult {
  output: unknown;
  model: string | null;
  usage: Record<string, unknown> | null;
}

export interface AgentProvider {
  id: AiProvider;
  label: string;
  demo: boolean;
  probe(): Promise<{ available: boolean; version: string | null; reason: string | null }>;
  run(
    request: AgentRequest,
    signal: AbortSignal,
    onProgress: (progress: string) => void,
  ): Promise<AgentResult>;
}

export class AgentError extends Error {}

/**
 * Environment for agent processes: no GitHub credentials, and a gh config directory with no
 * logins, so nothing the agent runs can reach GitHub as the user.
 */
export function agentEnvironment(workDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };

  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_DEBUG',
  ]) {
    delete env[key];
  }

  const ghConfig = join(workDir, '.gh-empty');

  mkdirSync(ghConfig, { recursive: true, mode: 0o700 });
  env.GH_CONFIG_DIR = ghConfig;

  return env;
}

export interface SpawnOptions {
  cwd: string;
  input: string;
  signal: AbortSignal;
  timeoutMs: number;
  onLine?: (line: string) => void;
}

/**
 * Runs an agent CLI in its own process group. Cancellation and timeouts terminate the whole
 * group (SIGTERM, then SIGKILL after five seconds), so no stray children outlive a run.
 */
export function runAgentProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new AgentError('Cancelled.'));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: agentEnvironment(options.cwd),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let reason: 'timeout' | 'cancelled' | null = null;

    const terminate = (why: 'timeout' | 'cancelled') => {
      reason = why;

      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        // Already gone.
      }

      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }, 5000).unref();
    };

    const timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    const onAbort = () => terminate('cancelled');

    options.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      buffer += chunk;

      let newline = buffer.indexOf('\n');

      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();

        buffer = buffer.slice(newline + 1);

        if (line) options.onLine?.(line);

        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      reject(new AgentError(`Could not start ${command}: ${redact(error.message)}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);

      if (reason === 'timeout') reject(new AgentError('The agent took too long and was stopped.'));
      else if (reason === 'cancelled') reject(new AgentError('Cancelled.'));
      else resolve({ code, stdout, stderr });
    });

    child.stdin.end(options.input);
  });
}

/** `<command> --version`, used to show which agents are installed. */
export async function probeVersion(
  command: string,
): Promise<{ available: boolean; version: string | null; reason: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', () =>
      resolve({
        available: false,
        version: null,
        reason: `${command} is not installed or not on PATH.`,
      }),
    );
    child.on('close', (code) =>
      resolve(
        code === 0
          ? { available: true, version: output.trim().split('\n')[0] || null, reason: null }
          : { available: false, version: null, reason: `${command} --version failed.` },
      ),
    );
  });
}
