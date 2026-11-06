import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAccountStatus, CodexModel } from '../../shared/ai.js';
import { redact } from '../github/errors.js';
import { CodexAppServer, type Notification } from './codexAppServer.js';
import {
  accountProblem,
  accountType,
  codexSnapshot,
  limitMessage,
  mergeSnapshot,
  summariseUsage,
  type CodexAccount,
  type PlanUsage,
  type RateLimitSnapshot,
  type RateLimitsResponse,
} from './codexUsage.js';
import {
  AgentError,
  probeVersion,
  type AgentProvider,
  type AgentRequest,
  type AgentResult,
} from './provider.js';

const STATUS_TIMEOUT_MS = 30_000;
/** How long a stopped run waits for Codex to acknowledge the interrupt before closing anyway. */
const INTERRUPT_GRACE_MS = 2_000;
/**
 * A turn with no message from Codex for this long has stalled (seen with a model response that
 * never arrived while the connection stayed open), so it is stopped instead of running out the
 * task's whole timeout. Codex reports progress every few seconds while it works.
 */
const STALL_MS = 5 * 60_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface CatalogModel {
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
}

interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** Turns `codex app-server` notifications into short progress labels. */
export function codexProgress(notification: Notification): string | null {
  const item = (notification.params.item ?? {}) as Record<string, unknown>;

  if (notification.method === 'turn/started') return 'Thinking…';
  if (notification.method === 'item/started' && item.type === 'commandExecution')
    return 'Reading code…';
  if (notification.method === 'item/completed' && item.type === 'reasoning') return 'Thinking…';
  if (notification.method === 'item/completed' && item.type === 'agentMessage')
    return 'Writing the answer…';

  return null;
}

async function readAccount(server: CodexAppServer): Promise<CodexAccount | null> {
  const { account } = await server.request<{ account: CodexAccount | null }>('account/read', {});

  return account;
}

async function readUsage(server: CodexAppServer) {
  const response = await server.request<RateLimitsResponse>('account/rateLimits/read', null);
  const snapshot = codexSnapshot(response);

  return { snapshot, usage: summariseUsage(snapshot, response.ordinaryUsageAllowed ?? null) };
}

/** The models this ChatGPT account can use from this app, as Codex offers them. */
async function listModels(server: CodexAppServer): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page++) {
    const response: { data: CatalogModel[]; nextCursor: string | null } = await server.request(
      'model/list',
      { cursor },
    );

    for (const model of response.data) {
      if (!model.hidden) {
        models.push({
          id: model.model,
          displayName: model.displayName,
          isDefault: model.isDefault,
        });
      }
    }

    cursor = response.nextCursor;

    if (!cursor) break;
  }

  return models;
}

/** Snake case, matching the usage recorded for earlier runs. */
const usageRecord = (usage: TokenUsage) => ({
  input_tokens: usage.inputTokens,
  cached_input_tokens: usage.cachedInputTokens,
  cache_write_input_tokens: usage.cacheWriteInputTokens,
  output_tokens: usage.outputTokens,
  reasoning_output_tokens: usage.reasoningOutputTokens,
});

/**
 * Codex through `codex app-server`, on the user's saved ChatGPT sign-in, the way Codex's own IDE
 * extension runs it. Runs must bill the ChatGPT plan: an API-key sign-in is refused, and a run
 * neither starts nor continues once the plan's included usage is used up, so no credits are spent.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly demo = false;

  constructor(
    private readonly command = 'codex',
    private readonly stallMs = STALL_MS,
  ) {}

  probe() {
    return probeVersion(this.command);
  }

  async status(): Promise<CodexAccountStatus> {
    const cwd = await mkdtemp(join(tmpdir(), 'review-desk-codex-'));

    try {
      const server = await CodexAppServer.open(this.command, {
        cwd,
        signal: new AbortController().signal,
        timeoutMs: STATUS_TIMEOUT_MS,
      });

      try {
        const account = await readAccount(server);
        const problem = accountProblem(account);
        const blank = { plan: null, windows: [], limitReached: false, resetsAt: null, models: [] };

        if (problem) return { ...blank, type: accountType(account), problem };

        const [{ usage }, models] = await Promise.all([readUsage(server), listModels(server)]);

        return {
          type: 'chatgpt',
          plan: usage.plan ?? (account?.planType ? `ChatGPT ${account.planType}` : null),
          windows: usage.windows,
          limitReached: usage.limitReached,
          resetsAt: usage.resetsAt,
          models,
          problem: usage.limitReached ? limitMessage(usage) : null,
        };
      } finally {
        server.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  async run(
    request: AgentRequest,
    signal: AbortSignal,
    onProgress: (progress: string) => void,
  ): Promise<AgentResult> {
    const server = await CodexAppServer.open(this.command, {
      cwd: request.workDir,
      signal,
      timeoutMs: request.timeoutMs,
    });

    try {
      return await this.review(server, request, onProgress);
    } finally {
      server.close();
    }
  }

  private async review(
    server: CodexAppServer,
    request: AgentRequest,
    onProgress: (progress: string) => void,
  ): Promise<AgentResult> {
    // The run must bill the ChatGPT plan, and the plan must have included usage left.
    const problem = accountProblem(await readAccount(server));

    if (problem) throw new AgentError(problem);

    const start = await readUsage(server);

    if (start.usage.limitReached) throw new AgentError(limitMessage(start.usage));

    // The user's Codex config is loaded, so switch off each of their MCP servers by name and
    // choose the model here: the account's default unless the task names one.
    const { config } = await server.request<{ config: { mcp_servers?: Record<string, unknown> } }>(
      'config/read',
      { cwd: request.workDir },
    );
    const mcpOff = Object.fromEntries(
      Object.keys(config.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false]),
    );
    const model =
      request.model ?? (await listModels(server)).find((candidate) => candidate.isDefault)?.id;

    let snapshot: RateLimitSnapshot = start.snapshot;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let answer: string | null = null;
    let tokens: TokenUsage | null = null;
    let stopped: AgentError | null = null;
    let interrupted = false;
    let lastMessageAt = Date.now();
    let watchdog: NodeJS.Timeout | undefined;

    // A stopped run interrupts its turn as soon as the turn is known, so Codex stops generating
    // before the session is closed.
    const interruptIfStopped = async () => {
      if (!stopped || interrupted || !threadId || !turnId) return;

      interrupted = true;
      await Promise.race([
        server.request('turn/interrupt', { threadId, turnId }),
        delay(INTERRUPT_GRACE_MS),
      ]).catch(() => {});
    };

    const finished = new Promise<void>((resolve, reject) => {
      const stop = (message: string) => {
        if (stopped) return;

        const error = new AgentError(message);

        stopped = error;
        void interruptIfStopped().finally(() => reject(error));
      };

      watchdog = setInterval(
        () => {
          if (turnId && Date.now() - lastMessageAt > this.stallMs) {
            stop(
              `Codex stopped responding for ${Math.round(this.stallMs / 60_000) || 1} minutes, so the run was stopped. Run it again.`,
            );
          }
        },
        Math.min(30_000, this.stallMs / 4),
      );

      server.onClose(reject);
      server.onNotification((notification) => {
        const params = notification.params;
        const progress = codexProgress(notification);

        lastMessageAt = Date.now();

        if (progress) onProgress(progress);

        if (notification.method === 'turn/started') {
          turnId ??= (params.turn as { id: string }).id;
          void interruptIfStopped();
        } else if (notification.method === 'mcpServer/startupStatus/updated') {
          stop(`Codex started the MCP server "${String(params.name)}", so the run was stopped.`);
        } else if (notification.method === 'account/rateLimits/updated') {
          snapshot = mergeSnapshot(snapshot, params.rateLimits as RateLimitSnapshot);

          const usage = summariseUsage(snapshot);

          // Codex reports usage after the answer too; a finished answer is kept, not thrown away.
          if (usage.limitReached && answer === null) stop(limitMessage(usage, true));
        } else if (notification.method === 'thread/tokenUsage/updated') {
          tokens = (params.tokenUsage as { total: TokenUsage }).total;
        } else if (notification.method === 'item/completed') {
          const item = params.item as { type?: string; text?: string; phase?: string | null };

          // Interim commentary is not the answer; models that report no phase are taken as final.
          if (
            item.type === 'agentMessage' &&
            typeof item.text === 'string' &&
            item.phase !== 'commentary'
          ) {
            answer = item.text;
          }
        } else if (notification.method === 'error') {
          const error = params as { error?: { message?: string }; willRetry?: boolean };

          if (!error.willRetry) stop(redact(error.error?.message ?? 'Codex failed.'));
        } else if (notification.method === 'turn/completed' && !stopped) {
          const turn = params.turn as { status: string; error?: { message?: string } | null };

          if (turn.status === 'completed') resolve();
          else
            reject(
              new AgentError(
                redact(
                  turn.error?.message ??
                    (turn.status === 'interrupted' ? 'Codex stopped the run.' : 'Codex failed.'),
                ),
              ),
            );
        }
      });
    });

    // A failure can arrive before the turn starts; it is awaited below. Either way the watchdog
    // has nothing left to watch.
    finished.then(
      () => clearInterval(watchdog),
      () => clearInterval(watchdog),
    );

    const thread = await server.request<{ thread: { id: string }; model: string }>('thread/start', {
      cwd: request.workDir,
      model,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      // The user's config may ask for Fast mode, which uses the plan faster.
      serviceTier: null,
      config: mcpOff,
    });

    threadId = thread.thread.id;

    // Stopped before the turn began (an MCP server started): never start it.
    if (stopped) await finished;

    const turn = await server.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [
        { type: 'text', text: `${request.instructions}\n\n${request.input}`, text_elements: [] },
      ],
      effort: request.effort,
      outputSchema: request.schema,
      serviceTierForTurn: 'default',
    });

    turnId ??= turn.turn.id;
    await interruptIfStopped();
    await finished;

    const output = (() => {
      try {
        return answer === null ? null : (JSON.parse(answer) as unknown);
      } catch {
        return null;
      }
    })();

    if (output === null) throw new AgentError('Codex did not return a structured answer.');

    return {
      output,
      model: thread.model,
      usage: {
        ...(tokens ? usageRecord(tokens) : {}),
        credits_used: await creditsUsed(server, start.usage),
      },
    };
  }
}

/** How far the credit balance fell during the run; the balance can lag, so this is best effort. */
async function creditsUsed(server: CodexAppServer, before: PlanUsage): Promise<number | null> {
  if (before.credits === null) return null;

  try {
    const after = (await readUsage(server)).usage.credits;

    return after !== null && after < before.credits
      ? Math.round((before.credits - after) * 100) / 100
      : 0;
  } catch {
    return null;
  }
}
