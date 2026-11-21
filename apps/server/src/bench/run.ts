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
import { LOOP_P99_MS, MIN_ROUTE_SAMPLES, ROUTE_P95_MS, stats, type Stats } from '@/bench/stats.js';

export { LOOP_P99_MS, MIN_ROUTE_SAMPLES, ROUTE_P95_MS, stats, type Stats } from '@/bench/stats.js';

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

/** The reads a diff makes; a real forge computes their patches remotely, as the fixture does here. */
const RECORDED = new Set(['pinnedFiles', 'pullFiles', 'compare', 'blobs']);

/**
 * The forge with its diff reads answered once and then replayed as fresh copies, so a timed diff
 * measures the server's own work (the copy standing in for parsing the CLI's JSON), not the
 * fixture building patches that a real forge sends ready-made.
 */
function replaying<T extends object>(forge: T): T {
  const answers = new Map<string, Promise<unknown>>();

  return new Proxy(forge, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);

      if (typeof value !== 'function' || !RECORDED.has(String(key))) return value;

      return async (...args: unknown[]) => {
        const id = `${String(key)}:${JSON.stringify(args)}`;

        if (!answers.has(id)) answers.set(id, value.apply(target, args));

        return structuredClone(await answers.get(id));
      };
    },
  });
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
      `${entry.name.padEnd(52)} median ${String(entry.stats.median).padStart(8)} ms   p95 ${String(entry.stats.p95).padStart(8)} ms   max ${String(entry.stats.max).padStart(8)} ms${entry.gate ? `   ${entry.gate.limit}: ${entry.gate.verdict}` : ''}`,
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
  const list = () => app.inject({ method: 'GET', url: '/api/accounts/you/pulls', headers });

  // The inbox the fixture implies: every PR asking for your review that you did not write.
  const inbox = populated.scenario.world.pulls
    .filter(({ snapshot, feeds }) => snapshot.author.login !== 'you' && feeds.includes('requested'))
    .map(({ snapshot }) => snapshot.id)
    .sort();
  const listed = (await list()).json() as { items: { id: string }[] };
  const expected = inbox.length;

  if (JSON.stringify(listed.items.map(({ id }) => id).sort()) !== JSON.stringify(inbox))
    throw new Error(
      `The PR list has ${listed.items.length} PRs, not the ${expected} in the inbox.`,
    );

  add({
    name: `PR list, ${largest} PRs, idle`,
    stats: stats(await timed(iterations * 3, list)),
  });

  // Closed and merged PRs stay cached: the list must not read them. Removed again afterwards, so
  // the cases below measure the same queue.
  const closedCount = smoke ? 100 : 3000;
  const open = populated.store.snapshots('you');
  const closed = Array.from({ length: closedCount }, (_, index) => ({
    ...open[index % open.length],
    id: `closed-${index}`,
    state: index % 2 === 0 ? ('CLOSED' as const) : ('MERGED' as const),
  }));

  for (const pr of closed) populated.store.saveSnapshot('you', pr);

  const withClosed = (await list()).json() as { items: { id: string }[] };

  if (JSON.stringify(withClosed.items.map(({ id }) => id).sort()) !== JSON.stringify(inbox))
    throw new Error(`With closed PRs cached, the PR list has ${withClosed.items.length} PRs.`);

  add({
    name: `PR list, ${largest} PRs and ${closedCount} closed, idle`,
    stats: stats(await timed(iterations * 3, list)),
  });

  for (const pr of closed) populated.store.forgetPull('you', pr.id);

  // The route while a background sync of a hundred changed PRs runs, its reads paced so the
  // sync lasts long enough to be sampled. A request counts when it started during the sync,
  // however long it then took.
  const changing = smoke ? 10 : 100;
  const pushed = pushTo(populated.scenario, changing, 1000);
  const heads = new Map(
    populated.scenario.world.pulls
      .filter(({ snapshot }) => pushed.includes(snapshot.id))
      .map(({ snapshot }) => [snapshot.id, snapshot.headOid]),
  );

  // At three reads at a time, 100 reads of 100 ms keep the sync busy for over three seconds.
  populated.github.readDelayMs = smoke ? 20 : 100;

  const during: number[] = [];
  let wrongSize = 0;
  let syncing = true;
  const sync = populated.service.sync().finally(() => {
    syncing = false;
  });

  while (syncing) {
    const started = performance.now();
    const response = await list();
    const ms = performance.now() - started;
    const items = (response.json() as { items: unknown[] }).items.length;

    if (response.statusCode !== 200 || items !== expected) wrongSize += 1;
    else during.push(ms);

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await sync;
  populated.github.readDelayMs = 0;

  // The sync did the work it was meant to: every pushed PR now has its new head stored.
  const synced = pushed.filter(
    (id) => populated.store.snapshot('you', id)?.headOid === heads.get(id),
  ).length;
  const route = stats(during);

  add({
    name: `PR list, ${largest} PRs, during a sync`,
    stats: route,
    gate: {
      limit: `p95 < ${ROUTE_P95_MS} ms`,
      verdict:
        wrongSize > 0 || pushed.length !== changing || synced !== changing
          ? 'insufficient samples'
          : route.n < (smoke ? 1 : MIN_ROUTE_SAMPLES)
            ? 'insufficient samples'
            : route.p95 < ROUTE_P95_MS
              ? 'pass'
              : 'fail',
    },
    notes: { samples: route.n, wrongSize, changed: pushed.length, synced },
  });
  add({
    name: `inbox derivation, ${largest} PRs`,
    stats: stats(await timed(iterations, () => populated.service.list())),
  });
  const authored = populated.scenario.world.pulls.filter(
    ({ snapshot }) => snapshot.author.login === 'you',
  ).length;
  const mine = populated.service.mine().items.length;

  if (mine !== authored)
    throw new Error(`My PRs lists ${mine} PRs, not the ${authored} you wrote.`);

  add({
    name: `My PRs derivation, ${authored} of ${largest} PRs yours`,
    stats: stats(await timed(iterations, () => populated.service.mine())),
  });

  const large = populated.store.snapshot('you', LARGE_PR)!;
  const forge = replaying(populated.github);

  // Recorded once, untimed; then a new service each time, as its cache would otherwise answer.
  await new DiffService(forge).manifest(large, 'full', null);
  add({
    name: `full diff of a ${shape(largest).largeFiles}-file PR, cold`,
    stats: stats(
      await timed(iterations, () => new DiffService(forge).manifest(large, 'full', null)),
    ),
  });

  const rebased = populated.store.snapshot('you', REBASED_PR)!;
  const reviewed = rebased.reviews[0].commitOid!;
  const builds: number[] = [];
  const stalls: number[] = [];
  let diffed = 0;
  const histogram = monitorEventLoopDelay({ resolution: 10 });

  await new DiffService(forge).manifest(rebased, 'since-review', reviewed);

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

    diffed = (await new DiffService(forge).manifest(rebased, 'since-review', reviewed)).files
      .length;
    builds.push(performance.now() - started);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearInterval(probe);
    stalls.push(stall);
  }

  histogram.disable();

  const stall = stats(stalls);

  add({
    name: `rebased interdiff, ${shape(largest).rebasedFiles} changed, ${diffed} diffed, cold`,
    stats: stats(builds),
    notes: {
      changed: shape(largest).rebasedFiles,
      diffed,
      worstStallMs: stall.max,
      loopP99Ms: histogram.percentile(99) / 1e6,
    },
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
