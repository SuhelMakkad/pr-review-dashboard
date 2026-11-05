import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from '../github/errors.js';
import {
  AgentError,
  probeVersion,
  runAgentProcess,
  type AgentProvider,
  type AgentRequest,
} from './provider.js';

/**
 * Codex features the agent must not have: account connectors and plugins (which can reach other
 * services), browsing, computer use, image generation and sub-agents. Verified against codex-cli.
 */
const DISABLED_FEATURES = [
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

/** Turns `codex exec --json` events into short progress labels. */
export function codexProgress(event: Record<string, unknown>): string | null {
  const item = (event.item ?? {}) as Record<string, unknown>;

  if (event.type === 'turn.started') return 'Thinking…';
  if (event.type === 'item.started' && item.type === 'command_execution') return 'Reading code…';
  if (event.type === 'item.completed' && item.type === 'reasoning') return 'Thinking…';
  if (event.type === 'item.completed' && item.type === 'agent_message')
    return 'Writing the answer…';

  return null;
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly demo = false;

  constructor(private readonly command = 'codex') {}

  probe() {
    return probeVersion(this.command);
  }

  async run(request: AgentRequest, signal: AbortSignal, onProgress: (progress: string) => void) {
    const schemaPath = join(request.workDir, 'schema.json');
    const outputPath = join(request.workDir, 'out.json');
    let usage: Record<string, unknown> | null = null;
    let failure: string | null = null;

    await writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });

    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      // The user's config pins a model and MCP servers that headless runs must not inherit.
      '--ignore-user-config',
      '-s',
      'read-only',
      '-C',
      request.workDir,
      '-c',
      `model_reasoning_effort="${request.effort}"`,
      '-c',
      'mcp_servers={}',
      '-c',
      'web_search="disabled"',
      '-c',
      'approval_policy="never"',
      ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      ...(request.model ? ['-m', request.model] : []),
      '--output-schema',
      schemaPath,
      '-o',
      outputPath,
      '-',
    ];

    const result = await runAgentProcess(this.command, args, {
      cwd: request.workDir,
      input: `${request.instructions}\n\n${request.input}`,
      signal,
      timeoutMs: request.timeoutMs,
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const progress = codexProgress(event);

          if (progress) onProgress(progress);
          if (event.type === 'turn.completed')
            usage = (event.usage as Record<string, unknown>) ?? null;
          if (event.type === 'turn.failed' || event.type === 'error') {
            failure = String(
              (event.error as { message?: string })?.message ?? event.message ?? 'Codex failed.',
            );
          }
        } catch {
          // Non-JSON output is diagnostic noise.
        }
      },
    });

    if (result.code !== 0 || failure) {
      throw new AgentError(
        redact(
          failure ??
            (result.stderr.trim().split('\n').at(-1) || `Codex exited with code ${result.code}.`),
        ),
      );
    }

    try {
      return {
        output: JSON.parse(await readFile(outputPath, 'utf8')),
        model: request.model,
        usage,
      };
    } catch {
      throw new AgentError('Codex did not return a structured answer.');
    }
  }
}
