import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * Every agent gets a random marker in its environment, which the processes it starts inherit. A
 * marker identifies those processes beyond doubt, where a pid or process group id can belong to
 * an unrelated process once the agent is gone.
 */
const MARKER_VARIABLE = 'REVIEW_DESK_AGENT';

/**
 * The markers of agents that may still be running, kept in the data directory, so a server that
 * was killed outright lets its successor end them.
 */
export interface AgentJournal {
  load(): string[];
  save(markers: string[]): void;
}

const JOURNAL_KEY = 'agent-markers';

/** A journal kept in the settings of the data directory's database. */
export function settingsJournal(store: {
  getSetting<T>(key: string): T | null;
  setSetting(key: string, value: unknown): void;
}): AgentJournal {
  return {
    load: () => store.getSetting<string[]>(JOURNAL_KEY) ?? [],
    save: (markers) => store.setSetting(JOURNAL_KEY, markers),
  };
}

let journal: AgentJournal | null = null;
/** Markers of this process's agents that are still running. */
const recorded = new Set<string>();
/** Markers of a previous process's agents that could not be checked yet; kept until they are. */
let carried: string[] = [];

/** Records the agents this process starts from now on in `next` (null stops recording). */
export function useAgentJournal(next: AgentJournal | null): void {
  journal = next;
}

/** Stops recording in `owned` if it is still the journal in use (its database is closing). */
export function releaseAgentJournal(owned: AgentJournal): void {
  if (journal === owned) journal = null;
}

function persist(): void {
  try {
    journal?.save([...carried, ...recorded]);
  } catch {
    // The database may already be closed while the process exits; the next start checks anyway.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A process and the entries of the environment it was started with (`NAME=value`). */
export interface ProcessEnvironment {
  pid: number;
  entries: string[];
}

/** The environment entries of one process from `ps` on macOS and the BSDs, or null when unknown. */
function psEntries(withEnvironment: string, plain: string): string[] | null {
  // `-E` prints the environment after the command line; what follows the plain command line is it.
  if (!withEnvironment.startsWith(plain)) return null;

  return withEnvironment.slice(plain.length).trim().split(' ').filter(Boolean);
}

function psTable(flags: string[]): Map<number, string> | null {
  const result = spawnSync('ps', [...flags, '-ww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.status !== 0 || result.error) return null;

  const table = new Map<number, string>();

  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);

    if (match) table.set(Number(match[1]), match[2]!);
  }

  return table;
}

/** Every process of this user with its environment entries, or null when they cannot be listed. */
function listProcessEnvironments(): ProcessEnvironment[] | null {
  if (process.platform === 'linux') {
    try {
      return readdirSync('/proc').flatMap((name) => {
        if (!/^\d+$/.test(name)) return [];

        const entries = environmentOf(Number(name));

        return entries ? [{ pid: Number(name), entries }] : [];
      });
    } catch {
      return null;
    }
  }

  const plain = psTable(['-A']);
  const withEnvironment = psTable(['-A', '-E']);

  if (!plain || !withEnvironment) return null;

  return [...withEnvironment].flatMap(([pid, line]) => {
    const command = plain.get(pid);
    const entries = command === undefined ? null : psEntries(line, command);

    return entries ? [{ pid, entries }] : [];
  });
}

/** One process's environment entries, or null when it is gone or cannot be read. */
function environmentOf(pid: number): string[] | null {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
    } catch {
      return null;
    }
  }

  const plain = psTable(['-p', String(pid)])?.get(pid);
  const line = psTable(['-E', '-p', String(pid)])?.get(pid);

  return plain === undefined || line === undefined ? null : psEntries(line, plain);
}

/** How processes are listed; replaceable in tests. */
export const agentProcesses = { list: listProcessEnvironments, environmentOf };

const entryOf = (marker: string) => `${MARKER_VARIABLE}=${marker}`;

/** Processes whose environment has one of `markers` as an exact entry; null when not listable. */
function marked(markers: Set<string>): { pid: number; marker: string }[] | null {
  const processes = agentProcesses.list();

  if (!processes) return null;

  return processes.flatMap(({ pid, entries }) => {
    const marker = [...markers].find((candidate) => entries.includes(entryOf(candidate)));

    return marker && pid !== process.pid ? [{ pid, marker }] : [];
  });
}

/** SIGKILLs `pid` if it still carries `marker`, checked right before: its pid may have moved on. */
function killMarked(pid: number, marker: string): boolean {
  if (!agentProcesses.environmentOf(pid)?.includes(entryOf(marker))) return false;

  try {
    process.kill(pid, 'SIGKILL');

    return true;
  } catch {
    return false;
  }
}

/**
 * Ends every process carrying one of `markers` and waits until none is left, up to about a
 * second. True when none is left; false when some survive or processes cannot be listed.
 */
async function endMarked(markers: Set<string>): Promise<{ ended: number; gone: boolean }> {
  let ended = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    const found = marked(markers);

    if (!found) return { ended, gone: false };
    if (found.length === 0) return { ended, gone: true };

    for (const { pid, marker } of found) if (killMarked(pid, marker)) ended++;

    await sleep(200);
  }

  return { ended, gone: false };
}

/**
 * Ends the agents a previous server process left running, as recorded in `source`: every process
 * whose environment carries one of their markers as an exact entry. A server killed outright
 * (SIGKILL, a crash) cannot end its agents, and its successor must not resume a run while an old
 * agent still works on it; so resume nothing while this returns `verified: false`. Processes
 * without a marker are never touched. Markers stay on record until no process carries them, so a
 * later call tries again when processes cannot be listed or one survives.
 */
export async function endLeftoverAgents(
  source: AgentJournal,
): Promise<{ ended: number; verified: boolean }> {
  const markers = new Set([...carried, ...source.load()].filter((marker) => !recorded.has(marker)));

  if (markers.size === 0) {
    carried = [];

    return { ended: 0, verified: true };
  }

  const { ended, gone } = await endMarked(markers);

  carried = gone ? [] : [...markers];
  source.save([...carried, ...recorded]);

  return { ended, verified: gone };
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
  // Recorded before the agent starts, so that if this server is killed outright at any moment
  // after, the next one ends the agent before it resumes the run (see `endLeftoverAgents`). An
  // agent that cannot be recorded does not start.
  const marker = randomUUID();

  recorded.add(marker);

  try {
    journal?.save([...carried, ...recorded]);
  } catch (error) {
    recorded.delete(marker);

    throw new AgentError(
      `Could not record the agent before starting it: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...options.env, [MARKER_VARIABLE]: marker },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const group = child.pid;
  // Forgotten only once nothing carries the marker any more: a helper the agent started in its
  // own process group outlives the group kill below, so it is found by its marker and ended too.
  // If that cannot be confirmed, the marker passes to the next start's check.
  const settle = async () => {
    const { gone } = await endMarked(new Set([marker]));

    recorded.delete(marker);

    if (!gone) carried = [...new Set([...carried, marker])];

    persist();
  };

  child.once('error', () => void settle());

  if (group) {
    liveGroups.add(group);

    // The agent is gone; anything still in its group is a stray of this run, which ends with it.
    // The group stays registered until then, so exiting the server never misses one.
    child.once('close', () => {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // The group is already empty.
      }

      liveGroups.delete(group);
      void settle();
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
