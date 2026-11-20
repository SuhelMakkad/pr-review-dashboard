import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { LogSummariser } from '@/bench/log-summary.js';
import { LOOP_P99_MS, MIN_ROUTE_SAMPLES, ROUTE_P95_MS } from '@/bench/stats.js';

// `pnpm log:summary <log file>…`: a session recorded with REVIEW_DESK_LOG_LEVEL=debug, checked
// against the route and event-loop gates. Paths are read from where you ran pnpm.
const from = process.env.INIT_CWD ?? process.cwd();
const files = process.argv.slice(2).map((file) => resolve(from, file));

if (files.length === 0) {
  console.error('Usage: log:summary <log file> [more log files]');
  process.exit(2);
}

// Each line is summarised as it is read: only the values the statistics need are kept.
const summariser = new LogSummariser();

for (const file of files)
  for await (const line of createInterface({ input: createReadStream(file) })) summariser.add(line);

const summary = summariser.summary();

console.log(`Routes (p95 < ${ROUTE_P95_MS} ms, at least ${MIN_ROUTE_SAMPLES} requests)`);
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

if (summary.dropped > 0)
  console.log(
    `\nThe log dropped ${summary.dropped} records: a verdict they could change is reported as incomplete.`,
  );
