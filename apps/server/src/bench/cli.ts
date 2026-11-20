import { writeFileSync } from 'node:fs';
import { runBench } from '@/bench/run.js';

// `pnpm bench`: the full run, on a representative machine. `BENCH_SMOKE=1` for a quick one.
const cases = await runBench({
  smoke: process.env.BENCH_SMOKE === '1',
  log: (line) => console.log(line),
});

writeFileSync('bench-results.json', `${JSON.stringify(cases, null, 2)}\n`);
console.log('\nWrote bench-results.json.');

process.exit(cases.some((entry) => entry.gate?.verdict === 'fail') ? 1 : 0);
