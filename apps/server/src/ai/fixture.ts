import type { AiProvider, CodexAccountStatus } from '@review-desk/shared/ai';
import type { AgentProvider, AgentRequest } from './provider.js';
import { AgentError } from './provider.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DiffFile } from '@review-desk/shared/diff';
import { annotatePatch } from './context.js';

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AgentError('Cancelled.'));
    });
  });

/**
 * Deterministic stand-in for Codex and Claude in demo mode and tests. Answers are derived from
 * the same context the real agents receive, so the whole flow is exercised without any quota.
 */
export class FixtureProvider implements AgentProvider {
  readonly label: string;
  readonly demo = true;
  /** Fail the next run with this message (failure injection for tests). */
  failNext: string | null = null;
  delayMs = 120;

  get supportsResume() {
    return this.id === 'codex';
  }

  constructor(readonly id: AiProvider) {
    this.label = id === 'codex' ? 'Codex' : 'Claude Code';
  }

  async probe() {
    return { available: true, version: 'demo', reason: null };
  }

  /** A ChatGPT Plus sign-in with usage to spare; `limitReached` exercises the plan guard. */
  account: CodexAccountStatus = {
    type: 'chatgpt',
    plan: 'ChatGPT Plus',
    windows: [
      {
        label: '5-hour',
        usedPercent: 35,
        resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      },
      {
        label: 'Weekly',
        usedPercent: 12,
        resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
      },
    ],
    limitReached: false,
    resetsAt: null,
    models: [
      { id: 'gpt-demo', displayName: 'GPT-Demo', isDefault: true },
      { id: 'gpt-demo-mini', displayName: 'GPT-Demo Mini', isDefault: false },
    ],
    problem: null,
  };

  async status(): Promise<CodexAccountStatus> {
    return structuredClone(this.account);
  }

  async run(request: AgentRequest, signal: AbortSignal, onProgress: (progress: string) => void) {
    if (this.supportsResume) request.onThread?.(request.threadId ?? randomUUID(), 'Codex (demo)');

    onProgress('Thinking…');
    await wait(this.delayMs, signal);
    onProgress('Writing the answer…');
    await wait(this.delayMs, signal);

    if (this.failNext) {
      const message = this.failNext;

      this.failNext = null;
      throw new AgentError(message);
    }

    if (request.instructions.includes('perform a full code review')) {
      const review = JSON.parse(await readFile(join(request.workDir, 'review.json'), 'utf8')) as {
        files: DiffFile[];
      };
      const file = review.files.find((candidate) => candidate.patch && !candidate.generated);
      const line = /R(\d+) \+/.exec(annotatePatch(file?.patch ?? ''));

      return {
        output: {
          overall:
            'The implementation is mostly sound, but the empty-input behavior needs a regression test.',
          assessment: 'no_blocking_findings',
          comments:
            file && line
              ? [
                  {
                    path: file.path,
                    line: Number(line[1]),
                    side: 'RIGHT',
                    severity: 'suggestion',
                    body: 'Could you add a regression test for empty input? This branch should preserve the existing behavior.',
                  },
                ]
              : [],
          coverage: [
            'Inspected the changed source files and related tests in both repository snapshots. Tests were not executed.',
          ],
        },
        model: 'Codex (demo)',
        usage: null,
      };
    }

    const input = request.input;
    const files = [
      ...input.matchAll(/<file path="([^"]+)"[^>]*additions="(\d+)" deletions="(\d+)"/g),
    ].map((match) => ({
      path: match[1],
      size: Number(match[2]) + Number(match[3]),
    }));
    const title = /Title: (.*)/.exec(input)?.[1] ?? 'this change';
    const task = request.instructions.includes('write a brief')
      ? 'brief'
      : request.instructions.includes('already reviewed an earlier version')
        ? 'since_review'
        : request.instructions.includes('propose review comments')
          ? 'draft_comments'
          : request.instructions.includes('is the author')
            ? 'author_feedback'
            : 'draft_summary';

    const output =
      task === 'brief'
        ? {
            summary: `${title}. The change touches ${files.length} ${files.length === 1 ? 'file' : 'files'}; the largest part is in ${files[0]?.path ?? 'the main module'}.`,
            risk: files.reduce((sum, file) => sum + file.size, 0) > 60 ? 'medium' : 'low',
            riskReasons: ['Schema or behaviour changes need a careful look at edge cases.'],
            focusFiles: files
              .slice(0, 2)
              .map((file) => ({ path: file.path, reason: 'Largest change in this PR.' })),
            questions: ['How was this tested against production-sized data?'],
          }
        : task === 'since_review'
          ? {
              summary:
                'The author responded to your review with targeted changes in the files you commented on.',
              threads: [...input.matchAll(/<thread id="([^"]+)"[^>]*resolved="(true|false)"/g)].map(
                (match, index) => ({
                  threadId: match[1],
                  verdict: index === 0 ? 'addressed' : 'partially',
                  explanation:
                    index === 0
                      ? 'The new code does what you asked.'
                      : 'Partly done; one case is still open.',
                }),
              ),
              newConcerns: ['The new batching loop has no upper bound on retries.'],
            }
          : task === 'draft_comments'
            ? (() => {
                const fileMatch = /<file path="([^"]+)"[^>]*>\n[\s\S]*?\nR(\d+) \+ ([^\n]*)/.exec(
                  input,
                );

                return {
                  overall: 'Mostly solid; one thing worth checking before merging.',
                  comments: fileMatch
                    ? [
                        {
                          path: fileMatch[1],
                          line: Number(fileMatch[2]),
                          side: 'RIGHT',
                          severity: 'suggestion',
                          body: `Consider a test that covers \`${fileMatch[3].trim().slice(0, 40)}\` with an empty input.`,
                        },
                        {
                          path: fileMatch[1],
                          line: 99_999,
                          side: 'RIGHT',
                          severity: 'nit',
                          body: 'This anchor is invalid on purpose.',
                        },
                      ]
                    : [],
                };
              })()
            : task === 'author_feedback'
              ? {
                  summary:
                    'Reviewers asked for a smaller retry cap and a fix for the failing tests.',
                  actionItems: [...input.matchAll(/<thread id="([^"]+)"/g)]
                    .slice(0, 3)
                    .map((match) => ({
                      text: 'Reply and push a fix for this thread.',
                      threadId: match[1],
                    })),
                }
              : {
                  body: 'Thanks for this. The direction looks right; I left a few comments, mostly about tests and edge cases.',
                };

    return { output, model: `${this.label} (demo)`, usage: null };
  }
}
