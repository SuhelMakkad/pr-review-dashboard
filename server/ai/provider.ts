import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AiEffort, AiProvider, CodexAccountStatus } from '../../shared/ai.js';
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
  /** Codex only: the sign-in, plan usage and models runs would use. */
  status?(): Promise<CodexAccountStatus>;
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

/**
 * Environment for Codex: as {@link agentEnvironment}, and with no OpenAI credentials, so Codex can
 * only use its saved ChatGPT sign-in. An API key here would bill API usage instead of the plan.
 */
export function codexEnvironment(workDir: string): NodeJS.ProcessEnv {
  const env = agentEnvironment(workDir);

  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']) {
    delete env[key];
  }

  return env;
}

const PIPE_GRACE_MS = 2_000;

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  onLine?: (line: string) => void;
}

export interface AgentProcess {
  stdin: NodeJS.WritableStream;
  /** Settles when the process exits; rejects on a timeout, a cancellation or a failed start. */
  done: Promise<{ code: number | null; stderr: string }>;
  /** Ends the whole process group; `done` then resolves normally. */
  stop(): void;
}

/**
 * Starts an agent CLI in its own process group. Cancellation, timeouts and {@link AgentProcess.stop}
 * terminate the whole group (SIGTERM, then SIGKILL after five seconds), so no stray children
 * outlive a run. Stdout is delivered line by line and not kept.
 */
export function spawnAgentProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): AgentProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let buffer = '';
  let reason: 'timeout' | 'cancelled' | 'stopped' | null = null;

  const terminate = (why: 'timeout' | 'cancelled' | 'stopped') => {
    if (reason) return;

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

  // A child that exits early makes writes fail with EPIPE; its exit is reported through `done`.
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
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
  // A helper the agent started in its own process group (Codex's code-mode host) can hold the
  // pipes open long after the agent exits; stop waiting for them shortly after the exit.
  child.on('exit', () => {
    setTimeout(() => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, PIPE_GRACE_MS).unref();
  });

  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      finish();
      reject(new AgentError(`Could not start ${command}: ${redact(error.message)}`));
    });
    child.on('close', (code) => {
      finish();

      if (reason === 'timeout') reject(new AgentError('The agent took too long and was stopped.'));
      else if (reason === 'cancelled') reject(new AgentError('Cancelled.'));
      else resolve({ code, stderr });
    });
  });

  if (options.signal.aborted) onAbort();

  return { stdin: child.stdin, done, stop: () => terminate('stopped') };
}

/** Runs an agent CLI to completion with `input` on stdin. */
export function runAgentProcess(
  command: string,
  args: string[],
  options: Omit<ProcessOptions, 'env'> & { input: string },
): Promise<{ code: number | null; stderr: string }> {
  if (options.signal.aborted) return Promise.reject(new AgentError('Cancelled.'));

  const agent = spawnAgentProcess(command, args, {
    ...options,
    env: agentEnvironment(options.cwd),
  });

  agent.stdin.end(options.input);

  return agent.done;
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
