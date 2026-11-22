import { readFileSync } from 'node:fs';
import { compareReports, type EvalReport } from '@/ai/eval.js';

/**
 * `pnpm ai:eval:compare <baseline.json> <candidate.json>`: what changed between two runs on the
 * same cases, provider, model and effort. Exits 1 when a case that passed fails now, 2 when the
 * two cannot be compared.
 */
const [baselinePath, candidatePath] = process.argv.slice(2);

if (!baselinePath || !candidatePath) {
  console.error('Usage: pnpm ai:eval:compare <baseline.json> <candidate.json>');
  process.exit(2);
}

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as EvalReport;
const { refusals, changes, regressed } = compareReports(read(baselinePath), read(candidatePath));

if (refusals.length > 0) {
  for (const refusal of refusals) console.error(refusal);

  process.exit(2);
}

for (const item of changes) {
  console.log(`${item.change.padEnd(13)} ${item.task}/${item.id}`);

  for (const label of item.labels)
    console.log(
      `    ${label.from ? 'pass' : 'fail'} → ${label.to ? 'pass' : 'fail'}: ${label.why} (${label.reason})`,
    );
}

console.log(regressed ? 'A case that passed fails now.' : 'No case that passed fails now.');
process.exit(regressed ? 1 : 0);
