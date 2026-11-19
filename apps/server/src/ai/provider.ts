import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AiEffort, AiProvider, CodexAccountStatus } from '@review-desk/shared/ai';
import { redact } from '@/github/errors.js';

export interface AgentRequest {
  /** Instructions (system role). */
  instructions: string;
  /** The task input, including untrusted PR content; sent on stdin. */
  input: string;
  /** Strict JSON Schema the final answer must satisfy. */
  schema: Record<string, unknown>;
  effort: AiEffort;
  model: string | null;
  /** Private working directory, retained while a resumable run is paused. */
  workDir: string;
  timeoutMs: number;
  threadId?: string | null;
  onThread?: (threadId: string, model: string | null) => void;
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
  supportsResume?: boolean;
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
 * Environment for agent processes: no GitHub or GitLab credentials, and gh and glab config
 * directories with no logins, so nothing the agent runs can reach GitHub or GitLab as the user.
 */
export function agentEnvironment(workDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };

  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_DEBUG',
    'GITLAB_TOKEN',
    'GITLAB_ACCESS_TOKEN',
    'OAUTH_TOKEN',
    'CI_JOB_TOKEN',
    'GLAB_ENABLE_CI_AUTOLOGIN',
    'GLAB_DEBUG',
    'GLAB_DEBUG_HTTP',
    'GLAB_CLIENT_CERT',
    'CLIENT_CERT',
    'GLAB_CLIENT_KEY',
    'CLIENT_KEY',
    'GLAB_CLIENT_CERT_PASSWORD',
    'CLIENT_CERT_PASSWORD',
  ]) {
    delete env[key];
  }

  const ghConfig = join(workDir, '.gh-empty');
  const glabConfig = join(workDir, '.glab-empty');

  mkdirSync(ghConfig, { recursive: true, mode: 0o700 });
  mkdirSync(glabConfig, { recursive: true, mode: 0o700 });
  env.GH_CONFIG_DIR = ghConfig;
  env.GLAB_CONFIG_DIR = glabConfig;

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
  /**
   * The run workspace the agent works in, when it belongs to a run: the agent then holds that
   * run's lock while it runs (see `agentRunning`), and a second agent for the run cannot start.
   */
  lockFor?: string;
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
 * Agents run under a small supervisor (`agent-supervisor.ts`) that leads their process group and
 * ends it the moment this server is gone, however it ended. Given a run's workspace, it also holds
 * that run's lock for as long as it lives, so a busy lock means the run's agent is still running.
 */
const SUPERVISOR = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './agent-supervisor.ts' : './agent-supervisor.js',
    import.meta.url,
  ),
);

/** The lock a run's agent holds while it runs, next to the run's workspace. */
export function agentLockPath(workDir: string): string {
  return join(dirname(workDir), '.locks', `${basename(workDir)}.lock`);
}

/** True while an agent for the run in `workDir` is running, in this server or a previous one. */
export function agentRunning(workDir: string): boolean {
  const path = agentLockPath(workDir);

  if (!existsSync(path)) return false;

  let probe: DatabaseSync | null = null;

  try {
    probe = new DatabaseSync(path, { timeout: 0 });
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');

    return false;
  } catch {
    return true;
  } finally {
    probe?.close();
  }
}

/** Waits up to `timeoutMs` for the run's agent to have exited; true once it has. */
export async function agentExited(workDir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (agentRunning(workDir)) {
    if (Date.now() >= deadline) return false;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return true;
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
  // The supervisor leads the group and is the only process that signals it; the fourth pipe is
  // its control line (see agent-supervisor.ts), closed by the system when this process exits.
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      SUPERVISOR,
      options.lockFor ? agentLockPath(options.lockFor) : '-',
      command,
      ...args,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    },
  );
  const control = child.stdio[3] as Duplex;
  let reported: { code: number | null } | null = null;
  let controlBuffer = '';

  // How the agent itself ended, as the supervisor reports it; the supervisor then ends with the
  // rest of the group, so its own exit says nothing about the agent.
  control.on('error', () => {});
  control.setEncoding('utf8').on('data', (chunk: string) => {
    controlBuffer += chunk;

    for (const line of controlBuffer.split('\n').slice(0, -1)) {
      const exit = /^exit (\d+)$/.exec(line.trim());

      if (exit) reported = { code: Number(exit[1]) };
      else if (/^signal \w+$/.test(line.trim())) reported = { code: null };
    }

    controlBuffer = controlBuffer.slice(controlBuffer.lastIndexOf('\n') + 1);
  });

  let stderr = '';
  let buffer = '';
  let reason: 'timeout' | 'cancelled' | 'stopped' | null = null;

  // The supervisor stops the agent (SIGTERM, then SIGKILL after five seconds); this process never
  // signals the group itself, whose id another process could hold once the supervisor is gone.
  const terminate = (why: 'timeout' | 'cancelled' | 'stopped') => {
    if (reason) return;

    reason = why;

    if (control.writable) control.write('stop\n');
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
      control.destroy();

      if (reason === 'timeout') reject(new AgentError('The agent took too long and was stopped.'));
      else if (reason === 'cancelled') reject(new AgentError('Cancelled.'));
      else resolve({ code: reported ? reported.code : code, stderr });
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
