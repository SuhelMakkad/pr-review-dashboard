import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createApp } from '@/app.js';
import { publicationFingerprint, reviewFingerprint } from '@/ai/freshness.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import {
  LARGE_PR,
  pushTo,
  REBASED_PR,
  syntheticScenario,
  type SyntheticOptions,
} from '@/demo/synthetic.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { SyncService } from '@/sync/service.js';

/** The gates the plan names: a route's p95, and the event loop's worst delay, while it works. */
export const ROUTE_P95_MS = 100;
export const LOOP_P99_MS = 50;
/** Fewer counted samples than this cannot decide the route gate. */
export const MIN_ROUTE_SAMPLES = 30;

export interface Stats {
  n: number;
  median: number;
  p95: number;
  max: number;
}

export interface BenchCase {
  name: string;
  stats: Stats;
  /** Pass or fail against a gate, or why it cannot be decided. */
  gate?: { limit: string; verdict: 'pass' | 'fail' | 'insufficient samples' };
  notes?: Record<string, number>;
}

export interface BenchOptions {
  /** Small sizes and few iterations, for `pnpm test`. */
  smoke?: boolean;
  log?: (line: string) => void;
}

export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;

  return {
    n: sorted.length,
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

async function timed(
  iterations: number,
  work: () => Promise<unknown> | unknown,
): Promise<number[]> {
  const durations: number[] = [];

  for (let index = 0; index < iterations; index++) {
    const started = performance.now();

    await work();
    durations.push(performance.now() - started);
  }

  return durations;
}

interface World {
  scenario: ReturnType<typeof syntheticScenario>;
  github: FixtureGitHub;
  store: Store;
  service: SyncService;
}

function world(options: SyntheticOptions): World {
  const scenario = syntheticScenario(options);
  const github = new FixtureGitHub(() => scenario);
  const store = new Store(':memory:');
  const service = new SyncService(store, github, new EventBus());

  return { scenario, github, store, service };
}

function close({ store, service }: World): void {
  service.stop();
  store.close();
}

/**
 * Measures the server's hot paths on synthetic workloads (see `syntheticScenario`), each case
 * on the path its gate names: syncs cold and warm, the PR list on a populated account while a
 * sync runs, the list derivations, a large PR's full diff, a rebased interdiff with the
 * event loop's stalls measured around it, and a large PR's fingerprints.
 */
export async function runBench(options: BenchOptions = {}): Promise<BenchCase[]> {
  const smoke = Boolean(options.smoke);
  const say = options.log ?? (() => undefined);
  const sizes = smoke ? [20, 40] : [500, 1000];
  const iterations = smoke ? 2 : 10;
  const shape = (pulls: number): SyntheticOptions => ({
    pulls,
    repositories: smoke ? 4 : 20,
    largeFiles: smoke ? 60 : 3000,
    largeThreads: smoke ? 10 : 300,
    rebasedFiles: smoke ? 20 : 400,
    rebasedLines: smoke ? 60 : 300,
  });
  const cases: BenchCase[] = [];
  const add = (entry: BenchCase) => {
    cases.push(entry);
    say(
      `${entry.name.padEnd(48)} median ${String(entry.stats.median).padStart(8)} ms   p95 ${String(entry.stats.p95).padStart(8)} ms   max ${String(entry.stats.max).padStart(8)} ms${entry.gate ? `   ${entry.gate.limit}: ${entry.gate.verdict}` : ''}`,
    );
  };

  for (const size of sizes) {
    const cold: number[] = [];
    const warm: number[] = [];

    for (let index = 0; index < (smoke ? 1 : 3); index++) {
      const subject = world(shape(size));

      cold.push(...(await timed(1, () => subject.service.sync())));
      // One PR changed since: detection, and one fetch.
      for (let round = 1; round <= iterations; round++) {
        pushTo(subject.scenario, 1, round + index * 100);
        warm.push(...(await timed(1, () => subject.service.sync())));
      }

      close(subject);
    }

    add({ name: `cold full sync, ${size} PRs`, stats: stats(cold) });
    add({ name: `warm sync (1 changed), ${size} PRs`, stats: stats(warm) });
  }

  const largest = sizes.at(-1)!;
  const populated = world(shape(largest));

  await populated.service.sync();

  const app = await createApp(populated.service, {
    sessionToken: 'bench',
    fixture: populated.github,
  });
  const headers = {
    host: '127.0.0.1:4317',
    'x-review-desk': '1',
    'x-review-desk-session': 'bench',
  };
  const expected = populated.service.list().items.length;
  const list = () => app.inject({ method: 'GET', url: '/api/pulls', headers });

  add({
    name: `/api/pulls, ${largest} PRs, idle`,
    stats: stats(await timed(iterations * 3, list)),
  });

  // The route while a background sync of a hundred changed PRs runs, its reads paced so the
  // sync lasts long enough to be sampled.
  pushTo(populated.scenario, smoke ? 10 : 100, 1000);
  // At three reads at a time, 100 reads of 100 ms keep the sync busy for over three seconds.
  populated.github.readDelayMs = smoke ? 20 : 100;

  const during: number[] = [];
  let syncing = true;
  const sync = populated.service.sync().finally(() => {
    syncing = false;
  });

  while (syncing) {
    const started = performance.now();
    const response = await list();
    const ms = performance.now() - started;
    const items = (response.json() as { items: unknown[] }).items.length;

    if (syncing && response.statusCode === 200 && items === expected) during.push(ms);

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await sync;
  populated.github.readDelayMs = 0;

  const route = stats(during);

  add({
    name: `/api/pulls, ${largest} PRs, during a sync`,
    stats: route,
    gate: {
      limit: `p95 < ${ROUTE_P95_MS} ms`,
      verdict:
        route.n < (smoke ? 1 : MIN_ROUTE_SAMPLES)
          ? 'insufficient samples'
          : route.p95 < ROUTE_P95_MS
            ? 'pass'
            : 'fail',
    },
    notes: { samples: route.n },
  });
  add({
    name: `inbox derivation, ${largest} PRs`,
    stats: stats(await timed(iterations, () => populated.service.list())),
  });
  add({
    name: `My PRs derivation, ${largest} PRs`,
    stats: stats(await timed(iterations, () => populated.service.mine())),
  });

  const large = populated.store.snapshot('you', LARGE_PR)!;

  // A new service each time: its cache would otherwise answer.
  add({
    name: `full diff of a ${shape(largest).largeFiles}-file PR, cold`,
    stats: stats(
      await timed(iterations, () =>
        new DiffService(populated.github).manifest(large, 'full', null),
      ),
    ),
  });

  const rebased = populated.store.snapshot('you', REBASED_PR)!;
  const reviewed = rebased.reviews[0].commitOid!;
  const builds: number[] = [];
  const stalls: number[] = [];
  const histogram = monitorEventLoopDelay({ resolution: 10 });

  histogram.enable();

  for (let index = 0; index < iterations; index++) {
    // A probe armed before the build and kept after it: its latest firing is the longest stall.
    let last = performance.now();
    let stall = 0;
    const probe = setInterval(() => {
      const now = performance.now();

      stall = Math.max(stall, Math.max(0, now - last - 5));
      last = now;
    }, 5);
    const started = performance.now();

    await new DiffService(populated.github).manifest(rebased, 'since-review', reviewed);
    builds.push(performance.now() - started);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearInterval(probe);
    stalls.push(stall);
  }

  histogram.disable();

  const stall = stats(stalls);

  add({
    name: `rebased interdiff of ${shape(largest).rebasedFiles} files, cold`,
    stats: stats(builds),
    notes: { worstStallMs: stall.max, loopP99Ms: histogram.percentile(99) / 1e6 },
  });
  add({
    name: 'event-loop stall during the interdiff',
    stats: stall,
    gate: {
      limit: `worst < ${LOOP_P99_MS} ms`,
      verdict: stall.n === 0 ? 'insufficient samples' : stall.max < LOOP_P99_MS ? 'pass' : 'fail',
    },
  });
  add({
    name: 'fingerprints of the large PR',
    stats: stats(
      await timed(iterations, () => {
        reviewFingerprint(large, 'you');
        publicationFingerprint(large, 'run', 'you');
      }),
    ),
  });

  await app.close();
  close(populated);

  return cases;
}
