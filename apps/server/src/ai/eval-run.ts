import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AiEffort, AiTask } from '@review-desk/shared/ai';
import {
  caseHash,
  fixtureProblems,
  fixtureSchema,
  scoreCase,
  type CaseReport,
  type EvalReport,
  type Fixture,
} from '@/ai/eval.js';
import type { PromptPins } from '@/ai/prompt-pins.js';
import type { AgentProvider } from '@/ai/provider.js';
import { safeError } from '@/redact.js';
import { jsonSchemaFor, TASKS, type Evidence } from '@/ai/tasks.js';

export interface EvalOptions {
  tasks: AiTask[];
  provider: 'codex' | 'claude';
  model: string | null;
  effort: AiEffort;
  /** Where each task's fixtures are, one folder per task (`<dir>/<task>/<case>.json`). */
  fixtures: string;
  /** The pinned prompts, recorded with each task for provenance. */
  pins: PromptPins;
  agents: Record<'codex' | 'claude', AgentProvider>;
}

/** The fixtures of `task`, in name order: none when it has no folder. */
function load(directory: string, task: AiTask): { file: string; raw: unknown }[] {
  const folder = join(directory, task);

  if (!existsSync(folder)) return [];

  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      file: join(folder, name),
      raw: JSON.parse(readFileSync(join(folder, name), 'utf8')),
    }));
}

/** A full review's workspace, laid out as the runner lays it out, in a fresh folder. */
function workspace(fixture: Fixture): string {
  const directory = mkdtempSync(join(tmpdir(), 'review-desk-eval-'));

  if (fixture.workspace) {
    writeFileSync(
      join(directory, 'review.json'),
      JSON.stringify(fixture.workspace.review, null, 2),
    );

    for (const side of ['before', 'after'] as const)
      for (const [path, text] of Object.entries(fixture.workspace[side])) {
        const target = join(directory, side, path);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
  }

  return directory;
}

/**
 * Runs each task's prompt, as the registry builds it, on its labelled fixtures: every fixture is
 * checked before any provider is asked. Each case runs in a fresh folder and a fresh session (no
 * thread), outside the run store, and nothing is published.
 */
export async function runEval(
  options: EvalOptions,
): Promise<{ problems: string[] } | { report: EvalReport }> {
  const problems: string[] = [];
  const cases: { task: AiTask; fixture: Fixture }[] = [];

  for (const task of options.tasks) {
    const only = TASKS[task].provider;

    if (only && only !== options.provider) problems.push(`${task} runs on ${only} only.`);

    const loaded = load(options.fixtures, task);

    if (loaded.length === 0) problems.push(`${task} has no fixtures in ${options.fixtures}.`);

    for (const { file, raw } of loaded) {
      const found = fixtureProblems(task, raw);

      if (found.length > 0) problems.push(...found.map((problem) => `${file}: ${problem}`));
      else cases.push({ task, fixture: fixtureSchema.parse(raw) });
    }
  }

  if (problems.length > 0) return { problems };

  const agent = options.agents[options.provider];
  const reports = new Map<AiTask, CaseReport[]>(options.tasks.map((task) => [task, []]));
  let complete = true;

  for (const { task, fixture } of cases) {
    const definition = TASKS[task];
    const evidence = fixture.evidence as unknown as Evidence;
    const hash = caseHash(fixture);
    const directory = workspace(fixture);
    let report: CaseReport;

    try {
      const answer = await agent.run(
        {
          instructions: definition.instructions,
          input: definition.input(evidence),
          schema: jsonSchemaFor(task),
          effort: options.effort,
          model: options.model,
          workDir: directory,
          timeoutMs: definition.timeoutMs,
          task,
        },
        new AbortController().signal,
        () => undefined,
      );
      const parsed = definition.schema.safeParse(answer.output);

      if (!parsed.success) {
        report = {
          id: fixture.id,
          hash,
          passed: false,
          results: [],
          model: answer.model,
          shapeError: 'The answer was not in the task’s shape.',
        };
      } else {
        const output = definition.anchor
          ? definition.anchor(parsed.data, evidence.diff)
          : parsed.data;

        report = {
          id: fixture.id,
          hash,
          model: answer.model,
          ...scoreCase(task, output, fixture.expect),
        };
      }
    } catch (error) {
      // The provider or the setup failed: the case says nothing about the prompt.
      complete = false;
      report = {
        id: fixture.id,
        hash,
        passed: false,
        results: [],
        model: null,
        error: safeError(error),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    reports.get(task)!.push(report);
  }

  return {
    report: {
      provider: options.provider,
      model: options.model,
      effort: options.effort,
      complete,
      tasks: options.tasks.map((task) => ({
        task,
        promptVersion: TASKS[task].promptVersion,
        digest: options.pins[task]?.digest ?? null,
        cases: reports.get(task)!,
      })),
    },
  };
}
