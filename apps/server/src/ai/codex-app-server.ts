import { redact } from '@/github/errors.js';
import {
  AgentError,
  codexEnvironment,
  spawnAgentProcess,
  type AgentProcess,
} from '@/ai/provider.js';

/**
 * Codex features the agent must not have: account connectors and plugins (which can reach other
 * services), browsing, computer use, image generation and sub-agents. Verified against codex-cli.
 */
export const DISABLED_FEATURES = [
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'multi_agent',
  'in_app_browser',
];

/**
 * `codex app-server` always loads the user's Codex config, so everything a headless run must not
 * inherit is overridden here. MCP servers are switched off per thread, by name.
 */
export const appServerArgs = (): string[] => [
  'app-server',
  ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  '-c',
  'web_search="disabled"',
  '-c',
  'notify=[]',
  '-c',
  'approval_policy="never"',
  '-c',
  'sandbox_mode="read-only"',
];

/** Sent as the `originator` of every request; it identifies this app to OpenAI. */
const clientInfo = { name: 'review_desk', title: 'Review Desk', version: '1.0.0' };

export interface Notification {
  method: string;
  params: Record<string, unknown>;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * A `codex app-server` session over stdio: newline-delimited JSON-RPC, one process per session.
 * This is how Codex's own IDE extension talks to Codex, and it bills the saved ChatGPT sign-in.
 */
export class CodexAppServer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(notification: Notification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closed: Error | null = null;
  private agent!: AgentProcess;

  private constructor() {}

  static async open(
    command: string,
    options: { cwd: string; signal: AbortSignal; timeoutMs: number; lockFor?: string },
  ): Promise<CodexAppServer> {
    const server = new CodexAppServer();

    server.agent = spawnAgentProcess(command, appServerArgs(), {
      ...options,
      // Codex refreshes its model catalog before `initialize`; naming the client at spawn keeps
      // that refresh from overwriting the shared models cache with the plain CLI's catalog.
      env: {
        ...codexEnvironment(options.cwd),
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: clientInfo.name,
      },
      onLine: (line) => server.receive(line),
    });
    server.agent.done.then(
      ({ code, stderr }) =>
        server.fail(
          new AgentError(
            redact(stderr.trim().split('\n').at(-1) || `Codex exited with code ${code}.`),
          ),
        ),
      (error: Error) => server.fail(error),
    );

    try {
      await server.request('initialize', { clientInfo, capabilities: null });
      server.notify('initialized');
    } catch (error) {
      server.close();
      throw error;
    }

    return server;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);

    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** Called once when the session ends: Codex exited, timed out or was cancelled, or was closed. */
  onClose(listener: (error: Error) => void): void {
    if (this.closed) listener(this.closed);
    else this.closeListeners.add(listener);
  }

  /** Ends the session and its whole process group. */
  close(): void {
    this.fail(new AgentError('Codex session closed.'));
    this.agent.stop();
  }

  private write(message: Record<string, unknown>) {
    this.agent.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error) {
    if (this.closed) return;

    this.closed = error;

    for (const entry of this.pending.values()) entry.reject(error);
    for (const listener of this.closeListeners) listener(error);

    this.pending.clear();
    this.closeListeners.clear();
  }

  private receive(line: string) {
    let message: Record<string, unknown>;

    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Non-JSON output is diagnostic noise.
    }

    if (typeof message.method === 'string') {
      // Requests from Codex (approvals, user input) are never granted: runs are read-only and
      // unattended. Codex treats the error as a refusal.
      if (message.id !== undefined) {
        this.write({
          id: message.id,
          error: { code: -32601, message: 'Review Desk runs unattended and declines requests.' },
        });

        return;
      }

      const notification = {
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
      };

      for (const listener of this.listeners) listener(notification);

      return;
    }

    const entry = this.pending.get(message.id as number);

    if (!entry) return;

    this.pending.delete(message.id as number);

    const error = message.error as { message?: string } | undefined;

    if (error) {
      entry.reject(
        new AgentError(redact(`Codex ${entry.method} failed: ${error.message ?? 'unknown error'}`)),
      );
    } else {
      entry.resolve(message.result);
    }
  }
}
