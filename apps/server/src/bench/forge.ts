import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { stats } from '@/bench/run.js';

const run = promisify(execFile);

// `pnpm bench:forge`, by hand only: how much of a GitHub request is the CLI rather than the
// remote call, from matched requests through `gh api` and through `fetch` with the same sign-in.
// The token is read here from `gh auth token`, used for these requests and never stored or shown.
const requests = Number(process.env.BENCH_REQUESTS) || 20;
const { stdout } = await run('gh', ['auth', 'token']);
const token = stdout.trim();

async function measure(label: string, work: () => Promise<unknown>) {
  const durations: number[] = [];

  for (let index = 0; index < requests; index++) {
    const started = performance.now();

    await work();
    durations.push(performance.now() - started);
  }

  const summary = stats(durations);

  console.log(
    `${label.padEnd(36)} median ${String(summary.median).padStart(8)} ms   p95 ${String(summary.p95).padStart(8)} ms`,
  );

  return summary;
}

const query = JSON.stringify({ query: 'query Identity { viewer { login } }' });
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'user-agent': 'review-desk-bench',
};

const cliRest = await measure('gh api rate_limit', () => run('gh', ['api', 'rate_limit']));
const httpRest = await measure('fetch rate_limit', () =>
  fetch('https://api.github.com/rate_limit', { headers }).then((response) => response.text()),
);
const cliGraphql = await measure('gh api graphql (viewer)', () =>
  run('gh', ['api', 'graphql', '-f', 'query=query Identity { viewer { login } }']),
);
const httpGraphql = await measure('fetch graphql (viewer)', () =>
  fetch('https://api.github.com/graphql', { method: 'POST', headers, body: query }).then(
    (response) => response.text(),
  ),
);

console.log(
  `\nCLI overhead, median: REST ${Math.round(cliRest.median - httpRest.median)} ms, GraphQL ${Math.round(cliGraphql.median - httpGraphql.median)} ms per request.`,
);
