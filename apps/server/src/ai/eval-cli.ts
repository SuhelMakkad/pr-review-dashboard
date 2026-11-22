import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aiTaskLabels, type AiEffort, type AiTask } from '@review-desk/shared/ai';
import { ClaudeProvider } from '@/ai/claude.js';
import { CodexProvider } from '@/ai/codex.js';
import { runEval } from '@/ai/eval-run.js';
import { PINS_PATH, type PromptPins } from '@/ai/prompt-pins.js';

/**
 * `pnpm ai:eval <task|all> [--provider codex|claude] [--model …] [--effort …] [--fixtures dir]
 * [--out report.json]`: runs each task's prompt on its labelled fixtures through a real agent, and
 * saves the report. Never run by CI: it spends plan usage. See the README for promoting a prompt.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string', default: 'codex' },
    model: { type: 'string' },
    effort: { type: 'string', default: 'medium' },
    fixtures: { type: 'string', default: `${root}tests/fixtures/ai/eval` },
    out: { type: 'string', default: 'ai-eval-report.json' },
    // For the command's own test: the stand-in agents.
    'codex-command': { type: 'string' },
    'claude-command': { type: 'string' },
  },
});
const all = Object.keys(aiTaskLabels) as AiTask[];
const asked = positionals[0];
const tasks = asked === 'all' ? all : all.filter((task) => task === asked);
const provider = values.provider as 'codex' | 'claude';

if (tasks.length === 0 || !['codex', 'claude'].includes(provider)) {
  console.error(`Usage: pnpm ai:eval <${all.join('|')}|all> [--provider codex|claude]`);
  process.exit(2);
}

const outcome = await runEval({
  tasks,
  provider,
  model: values.model ?? null,
  effort: values.effort as AiEffort,
  fixtures: values.fixtures!,
  pins: JSON.parse(readFileSync(`${root}${PINS_PATH}`, 'utf8')) as PromptPins,
  agents: {
    codex: new CodexProvider(values['codex-command'] ?? 'codex'),
    claude: new ClaudeProvider(values['claude-command'] ?? 'claude'),
  },
});

if ('problems' in outcome) {
  for (const problem of outcome.problems) console.error(problem);

  process.exit(2);
}

const { report } = outcome;

for (const task of report.tasks) {
  const passed = task.cases.filter((item) => item.passed).length;

  console.log(
    `${task.task} (prompt v${task.promptVersion}): ${passed} of ${task.cases.length} passed`,
  );

  for (const item of task.cases) {
    const mark = item.error ? 'ERROR' : item.passed ? 'pass ' : 'FAIL ';
    const why =
      item.error ??
      item.shapeError ??
      item.results
        .filter((result) => !result.passed)
        .map((result) => `${result.why}: ${result.reason}`)
        .join('; ');

    console.log(`  ${mark} ${item.id}${why ? ` — ${why}` : ''}`);
  }
}

writeFileSync(values.out!, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${report.complete ? 'Complete' : 'Incomplete: rerun before comparing'}. Saved to ${values.out}.`,
);
