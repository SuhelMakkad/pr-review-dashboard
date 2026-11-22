import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AiTask } from '@review-desk/shared/ai';
import { ClaudeProvider } from '@/ai/claude.js';
import { CodexProvider } from '@/ai/codex.js';
import type { AgentProvider } from '@/ai/provider.js';
import { jsonSchemaFor, TASKS, type Evidence } from '@/ai/tasks.js';
import { promptSamples } from './prompt-samples.js';

const fixtures = new URL('../../../tests/fixtures/ai/', import.meta.url).pathname;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();

  delete process.env.FAKE_CODEX_ANSWER;
  delete process.env.FAKE_CLAUDE_ANSWER;
});

/** The PR the recorded answers were given for, with its full diff. */
let sample: Evidence;

beforeAll(async () => {
  [sample] = (await promptSamples()).full;
});
const recorded = (task: AiTask) => join(fixtures, 'answers', `${task}.json`);
const answer = (task: AiTask) => JSON.parse(readFileSync(recorded(task), 'utf8')) as unknown;

/** The comments a recorded answer anchors where the sample diff does not show its line. */
const unanchored = (task: AiTask) => {
  const given = answer(task) as { comments?: { line: number | null }[] };
  const kept = {
    draft_comments: [true, false],
    full_review: [true, false, false],
  } as Partial<Record<AiTask, boolean[]>>;

  return kept[task]
    ? {
        ...given,
        comments: given.comments!.map((comment, index) =>
          kept[task]![index] ? comment : { ...comment, line: null },
        ),
      }
    : given;
};

const providers: Record<'codex' | 'claude', () => AgentProvider> = {
  codex: () => new CodexProvider(join(fixtures, 'fake-codex.mjs')),
  claude: () => new ClaudeProvider(join(fixtures, 'fake-claude.mjs')),
};

/** Each task on each provider it can run on. */
const cases = (Object.keys(TASKS) as AiTask[]).flatMap((task) =>
  (['codex', 'claude'] as const)
    .filter((provider) => TASKS[task].provider === null || TASKS[task].provider === provider)
    .map((provider) => [task, provider] as const),
);

describe('recorded answers', () => {
  it.each(cases)(
    'replays a %s answer through %s, its schema and its anchors',
    async (task, provider) => {
      const definition = TASKS[task];
      const workDir = mkdtempSync(join(tmpdir(), 'review-desk-answer-'));

      cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
      process.env[provider === 'codex' ? 'FAKE_CODEX_ANSWER' : 'FAKE_CLAUDE_ANSWER'] =
        recorded(task);

      const result = await providers[provider]().run(
        {
          instructions: definition.instructions,
          input: definition.input(sample),
          schema: jsonSchemaFor(task),
          effort: 'low',
          model: null,
          workDir,
          timeoutMs: 20_000,
          task,
        },
        new AbortController().signal,
        () => undefined,
      );
      const parsed = definition.schema.safeParse(result.output);

      expect(parsed.success).toBe(true);
      expect(definition.anchor ? definition.anchor(parsed.data, sample.diff) : parsed.data).toEqual(
        unanchored(task),
      );
    },
  );

  it('refuses an answer in another shape, as the runner then fails the run', () => {
    expect(TASKS.brief.schema.safeParse(answer('draft_summary')).success).toBe(false);
    expect(
      TASKS.full_review.schema.safeParse({ ...(answer('full_review') as object), extra: 1 })
        .success,
    ).toBe(false);
  });
});
