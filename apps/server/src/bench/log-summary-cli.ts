import { readFileSync } from 'node:fs';
import { summariseLog } from '@/bench/log-summary.js';
import { LOOP_P99_MS, ROUTE_P95_MS } from '@/bench/run.js';

// `pnpm --filter @review-desk/server log:summary <log file>…`: a session recorded with
// REVIEW_DESK_LOG_LEVEL=debug, checked against the route and event-loop gates.
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: log:summary <log file> [more log files]');
  process.exit(2);
}

const summary = summariseLog(files.flatMap((file) => readFileSync(file, 'utf8').split('\n')));

console.log(`Routes (p95 < ${ROUTE_P95_MS} ms)`);
for (const { method, route, stats, verdict } of summary.routes)
  console.log(
    `  ${`${method} ${route}`.padEnd(48)} n ${String(stats.n).padStart(6)}   p50 ${String(stats.median).padStart(8)} ms   p95 ${String(stats.p95).padStart(8)} ms   ${verdict}`,
  );

const { loop } = summary;

console.log(`\nEvent loop (worst window p99 < ${LOOP_P99_MS} ms)`);
console.log(
  `  ${loop.windows} windows, ${loop.qualifying} with enough samples, ${loop.samples} samples`,
);
console.log(
  `  worst window p99: ${loop.worstWindowP99 ?? '–'} ms   longest stall: ${loop.maxStall ?? '–'} ms`,
);
console.log(
  `  windows past the gate: ${loop.overGate === null ? '–' : `${Math.round(loop.overGate * 100)}%`}   ${loop.verdict}`,
);
