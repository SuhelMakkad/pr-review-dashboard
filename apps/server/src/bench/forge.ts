import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { stats } from '@/bench/stats.js';

const run = promisify(execFile);

// `pnpm bench:forge`, by hand only: matched requests to github.com through `gh api` and through
// `fetch` with the same sign-in, to estimate what going through the CLI costs end to end. Each
// `fetch` opens a new connection, as each `gh` process does. The token is read here from
// `gh auth token`, used for these requests only and never stored or shown.
const HOST = 'github.com';
const requests = Number(process.env.BENCH_REQUESTS) || 20;
const { stdout } = await run('gh', ['auth', 'token', '--hostname', HOST]);
const token = stdout.trim();

if (!token) throw new Error(`gh has no sign-in for ${HOST}.`);

/** A rate-limit answer, or a GraphQL answer naming the viewer: anything else fails the run. */
function check(kind: 'rest' | 'graphql', body: string): void {
  const parsed = JSON.parse(body) as {
    resources?: unknown;
    data?: { viewer?: { login?: unknown } };
    errors?: unknown;
  };
  const valid =
    kind === 'rest'
      ? typeof parsed.resources === 'object' && parsed.resources !== null
      : !parsed.errors && typeof parsed.data?.viewer?.login === 'string';

  if (!valid) throw new Error(`Unexpected ${kind} response from ${HOST}.`);
}

async function viaCli(kind: 'rest' | 'graphql'): Promise<void> {
  const args =
    kind === 'rest'
      ? ['api', '--hostname', HOST, 'rate_limit']
      : ['api', '--hostname', HOST, 'graphql', '-f', 'query=query Identity { viewer { login } }'];

  check(kind, (await run('gh', args)).stdout);
}

async function viaFetch(kind: 'rest' | 'graphql'): Promise<void> {
  const response = await fetch(
    kind === 'rest' ? 'https://api.github.com/rate_limit' : 'https://api.github.com/graphql',
    {
      method: kind === 'rest' ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        connection: 'close',
        'content-type': 'application/json',
        'user-agent': 'review-desk-bench',
      },
      body:
        kind === 'rest'
          ? undefined
          : JSON.stringify({ query: 'query Identity { viewer { login } }' }),
    },
  );
  const body = await response.text();

  if (!response.ok) throw new Error(`${HOST} answered ${response.status}.`);
  check(kind, body);
}

async function measure(label: string, work: () => Promise<void>) {
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

const cliRest = await measure('gh api rate_limit', () => viaCli('rest'));
const httpRest = await measure('fetch rate_limit', () => viaFetch('rest'));
const cliGraphql = await measure('gh api graphql (viewer)', () => viaCli('graphql'));
const httpGraphql = await measure('fetch graphql (viewer)', () => viaFetch('graphql'));

console.log(
  `\nMedian end-to-end difference, gh api minus fetch: REST ${Math.round(cliRest.median - httpRest.median)} ms, GraphQL ${Math.round(cliGraphql.median - httpGraphql.median)} ms per request. It includes starting gh and its reading the sign-in; the network varies between runs, so compare medians over several.`,
);
