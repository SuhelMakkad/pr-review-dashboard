import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

/** Process groups of agents still running, so that exiting the server can end them too. */
const liveGroups = new Set<number>();

/** An agent process group, as recorded so that a later server process can end it. */
export interface AgentGroupRecord {
  /** The process group id, which is the agent's own pid. */
  group: number;
  /** When the agent started, as `ps` reports it: tells it apart from a later process given its pid. */
  startedAt: string;
}

/** Where agent process groups are recorded, so a server that crashed can end them on its next start. */
export interface AgentGroupJournal {
  load(): AgentGroupRecord[];
  save(records: AgentGroupRecord[]): void;
}

const JOURNAL_KEY = 'agent-groups';

/** A journal kept in the settings of the data directory's database. */
export function settingsJournal(store: {
  getSetting<T>(key: string): T | null;
  setSetting(key: string, value: unknown): void;
}): AgentGroupJournal {
  return {
    load: () => store.getSetting<AgentGroupRecord[]>(JOURNAL_KEY) ?? [],
    save: (records) => store.setSetting(JOURNAL_KEY, records),
  };
}

let journal: AgentGroupJournal | null = null;
const recorded = new Map<number, AgentGroupRecord>();

/** Records the agents this process starts from now on in `next` (null stops recording). */
export function useAgentGroupJournal(next: AgentGroupJournal | null): void {
  journal = next;
}

function persist(): void {
  try {
    journal?.save([...recorded.values()]);
  } catch {
    // The database may already be closed while the process exits; the next start checks anyway.
  }
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

/** Every process with its group and start time, as `ps` reports them. */
function processTable(): { pid: number; group: number; startedAt: string }[] {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,lstart='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) return [];

  return result.stdout.split('\n').flatMap((line) => {
    const match = PS_LINE.exec(line);

    return match ? [{ pid: Number(match[1]), group: Number(match[2]), startedAt: match[3]! }] : [];
  });
}

/** When `pid` started, as `ps` reports it, or null when it is gone. */
function startTime(pid: number): string | null {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const text = result.status === 0 ? result.stdout.trim() : '';

  return text || null;
}

/**
 * Ends the agent process groups a previous server process left running, as recorded in `source`,
 * and forgets them. A server killed outright (SIGKILL, a crash) cannot end its agents, and its
 * successor must not resume a run in a workspace an old agent still writes to; so call this once
 * the process owns the data directory and before any run resumes. A group whose leader is alive
 * with another start time belongs to a later process that was given the same pid, and is left
 * alone. A group whose leader has exited holds only what that agent started: a group id is not
 * given out again while any member of the group lives. Returns how many groups it ended.
 */
export function endLeftoverAgentGroups(source: AgentGroupJournal): number {
  const records = source.load();

  if (records.length === 0) return 0;

  const table = processTable();
  let ended = 0;

  for (const record of records) {
    const members = table.filter((entry) => entry.group === record.group);
    const leader = members.find((entry) => entry.pid === record.group);

    if (members.length === 0 || (leader && leader.startedAt !== record.startedAt)) continue;

    try {
      process.kill(-record.group, 'SIGKILL');
      ended++;
    } catch {
      // It ended meanwhile.
    }
  }

  source.save([]);

  return ended;
}

/**
 * Ends every agent process group still running, at once and without waiting. For the moment the
 * server exits: a run stopped normally has already ended its agent, but a forced exit must not
 * leave one running against its workspace.
 */
export function killAgentProcesses(): void {
  for (const group of liveGroups) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  liveGroups.clear();
  recorded.clear();
  persist();
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
  const group = child.pid;

  if (group) {
    liveGroups.add(group);

    // Recorded in the data directory too, so that if this server is killed outright, the next
    // one ends the agent before it resumes the run (see `endLeftoverAgentGroups`).
    const startedAt = journal ? startTime(group) : null;

    if (startedAt) {
      recorded.set(group, { group, startedAt });
      persist();
    }

    // The agent is gone; anything still in its group is a stray of this run, which ends with it.
    // The group stays registered until then, so exiting the server never misses one.
    child.once('close', () => {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // The group is already empty.
      }

      liveGroups.delete(group);

      if (recorded.delete(group)) persist();
    });
  }

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
