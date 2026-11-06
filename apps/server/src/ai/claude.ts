import { redact } from '@/github/errors.js';
import {
  AgentError,
  probeVersion,
  runAgentProcess,
  type AgentProvider,
  type AgentRequest,
} from '@/ai/provider.js';

/** Turns `claude -p --output-format stream-json` events into short progress labels. */
export function claudeProgress(event: Record<string, unknown>): string | null {
  if (event.type === 'system' && event.subtype === 'thinking_tokens') {
    return `Thinking (~${Number(event.estimated_tokens ?? 0)} tokens)…`;
  }

  if (event.type === 'assistant') {
    const content = ((event.message as { content?: { type: string }[] })?.content ?? []).map(
      (block) => block.type,
    );

    if (content.includes('tool_use')) return 'Writing the answer…';
    if (content.includes('text')) return 'Writing…';
  }

  return null;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';
  readonly demo = false;

  constructor(private readonly command = 'claude') {}

  probe() {
    return probeVersion(this.command);
  }

  async run(request: AgentRequest, signal: AbortSignal, onProgress: (progress: string) => void) {
    let finalEvent: Record<string, unknown> | null = null;
    let model: string | null = request.model;

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      // No tools at all: the answer comes only from the input we provide.
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      // User settings only, so hooks or settings in a checked-out repository never run.
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--effort',
      request.effort,
      '--json-schema',
      JSON.stringify(request.schema),
      '--system-prompt',
      request.instructions,
      ...(request.model ? ['--model', request.model] : []),
    ];

    const result = await runAgentProcess(this.command, args, {
      cwd: request.workDir,
      input: request.input,
      signal,
      timeoutMs: request.timeoutMs,
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const progress = claudeProgress(event);

          if (progress) onProgress(progress);
          if (
            event.type === 'system' &&
            event.subtype === 'init' &&
            typeof event.model === 'string'
          )
            model = event.model;
          if (event.type === 'result') finalEvent = event;
        } catch {
          // Ignore partial or diagnostic lines.
        }
      },
    });

    const final = finalEvent as Record<string, unknown> | null;

    if (!final || final.is_error || result.code !== 0) {
      const message =
        final && typeof final.result === 'string'
          ? final.result
          : result.stderr.trim().split('\n').at(-1);

      throw new AgentError(redact(message || `Claude exited with code ${result.code}.`));
    }

    if (final.structured_output === undefined)
      throw new AgentError('Claude did not return a structured answer.');

    return {
      output: final.structured_output,
      model,
      usage: { ...(final.usage as Record<string, unknown>), costUsd: final.total_cost_usd ?? null },
    };
  }
}
