import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pinProblems, type PromptPins } from '@/ai/prompt-pins.js';

/**
 * `pnpm prompt:pins <base-revision>`: fails when a pinned prompt digest changed without its
 * version, against the branch a change merges into (CI passes the merge commit's first parent).
 */
const revision = process.argv[2] ?? 'origin/main';
const file = 'apps/server/src/ai/prompt-pins.json';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const head = JSON.parse(readFileSync(`${root}${file}`, 'utf8')) as PromptPins;
let base: PromptPins;

try {
  base = JSON.parse(
    execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' }),
  ) as PromptPins;
} catch {
  console.log(`No prompt pins at ${revision}: nothing to compare.`);
  process.exit(0);
}

const problems = pinProblems(base, head);

for (const problem of problems) console.error(problem);

process.exit(problems.length > 0 ? 1 : 0);
