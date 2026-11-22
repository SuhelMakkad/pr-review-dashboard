import { describe, expect, it } from 'vitest';
import { summariseLog } from '@/bench/log-summary.js';
import { runBench } from '@/bench/run.js';
import { stats } from '@/bench/stats.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { REBASED_PR, LARGE_PR, syntheticScenario } from '@/demo/synthetic.js';
import { DiffService } from '@/diff/service.js';

describe('the benchmark', () => {
  it('runs every case in its smoke size, deciding each gate', async () => {
    const cases = await runBench({ smoke: true });

    expect(cases.map((entry) => entry.name)).toEqual([
      'cold full sync, 20 PRs',
      'warm sync (1 changed), 20 PRs',
      'cold full sync, 40 PRs',
      'warm sync (1 changed), 40 PRs',
      'PR list, 40 PRs, idle',
      // Closed and merged PRs cached next to the open ones, which the list must not read.
      'PR list, 40 PRs and 100 closed, idle',
      'PR list, 40 PRs, during a sync',
      'inbox derivation, 40 PRs',
      // Every fifth of the many is yours.
      'My PRs derivation, 8 of 40 PRs yours',
      'full diff of a 60-file PR, cold',
      'rebased interdiff, 20 changed, 20 diffed, cold, patched in place',
      'rebased interdiff, 20 changed, 20 diffed, cold, a new pool',
      'event-loop stall during the interdiff, a new pool',
      'rebased interdiff, 20 changed, 20 diffed, cold, a running pool',
      'event-loop stall during the interdiff, a running pool',
      'four different diffs at once, one service',
      'fingerprints of the large PR',
    ]);

    const during = cases.find((entry) => entry.name.includes('during a sync'))!;

    // Samples counted only while the sync ran, each with the whole list, and the sync stored
    // every pushed PR's new head.
    expect(during.stats.n).toBeGreaterThan(0);
    expect(during.notes).toMatchObject({ wrongSize: 0, changed: 10, synced: 10 });
    expect(during.gate?.verdict).not.toBe('insufficient samples');
  }, 60_000);

  it('measures the paths it names: a rebased interdiff and a large full diff', async () => {
    const scenario = syntheticScenario({
      pulls: 10,
      repositories: 2,
      largeFiles: 30,
      largeThreads: 4,
      rebasedFiles: 8,
      rebasedLines: 40,
    });
    const github = new FixtureGitHub(() => scenario);
    const snapshot = (id: string) => github.snapshot(id, 'you', ['requested']);
    const rebased = await snapshot(REBASED_PR);
    const large = await snapshot(LARGE_PR);

    expect(
      (
        await new DiffService(github).manifest(
          rebased,
          'since-review',
          rebased.reviews[0].commitOid!,
        )
      ).kind,
    ).toBe('rebased');
    expect((await new DiffService(github).manifest(large, 'full', null)).files).toHaveLength(30);
    expect(large.threads).toHaveLength(4);
  });

  it('summarises percentiles from sorted samples', () => {
    expect(stats([5, 1, 3, 2, 4])).toEqual({ n: 5, median: 3, p95: 5, max: 5 });
    expect(stats([])).toEqual({ n: 0, median: 0, p95: 0, max: 0 });
  });
});

describe('the log summary', () => {
  const line = (record: Record<string, unknown>) => JSON.stringify(record);

  it('reports routes against their gate and the worst qualifying window, never a session p99', () => {
    const lines = [
      ...Array.from({ length: 40 }, (_, index) =>
        line({
          event: 'http.request',
          route: '/api/pulls',
          method: 'GET',
          ms: index < 38 ? 10 : 400,
        }),
      ),
      line({ event: 'http.request', route: '/api/status', method: 'GET', ms: 2 }),
      line({ event: 'loop.delay', p50: 10, p99: 20, max: 30, count: 500 }),
      line({ event: 'loop.delay', p50: 10, p99: 80, max: 120, count: 400 }),
      // Too few samples to say anything about its p99.
      line({ event: 'loop.delay', p50: 10, p99: 900, max: 900, count: 3 }),
      'not json',
    ];
    const summary = summariseLog(lines);

    expect(summary.routes[0]).toMatchObject({
      route: '/api/pulls',
      method: 'GET',
      stats: { n: 40, p95: 10 },
      verdict: 'pass',
    });
    // One request cannot decide a route.
    expect(summary.routes[1]).toMatchObject({
      route: '/api/status',
      verdict: 'insufficient samples',
    });
    expect(summary.loop).toEqual({
      windows: 3,
      qualifying: 2,
      samples: 903,
      worstWindowP99: 80,
      maxStall: 900,
      overGate: 0.5,
      verdict: 'fail',
    });
    expect(summary.dropped).toBe(0);
  });

  it('leaves undecided a verdict that the dropped records could change, and no other', () => {
    const requests = (route: string, fast: number, slow: number) =>
      Array.from({ length: fast + slow }, (_, index) =>
        line({ event: 'http.request', route, method: 'GET', ms: index < fast ? 10 : 300 }),
      );
    const summary = summariseLog([
      // Clear either way with 40 records missing.
      ...requests('/api/pulls', 1000, 0),
      ...requests('/api/pulls/:id', 60, 40),
      // 94 of 100 fast fails, but 40 more fast ones would make 134 of 140 a pass.
      ...requests('/api/status', 94, 6),
      // 96 of 100 fast passes, but 40 more slow ones would make 96 of 140 a failure.
      ...requests('/api/notes', 96, 4),
      line({ event: 'loop.delay', p50: 1, p99: 2, max: 3, count: 500 }),
      line({ event: 'log.dropped', count: 40 }),
    ]);

    expect(summary.dropped).toBe(40);
    expect(
      Object.fromEntries(summary.routes.map(({ route, verdict }) => [route, verdict])),
    ).toEqual({
      '/api/pulls': 'pass',
      '/api/pulls/:id': 'fail',
      '/api/status': 'incomplete',
      '/api/notes': 'incomplete',
    });
    // A window that passed could have hidden a worse one; one past the gate fails regardless.
    expect(summary.loop.verdict).toBe('incomplete');
    expect(
      summariseLog([
        line({ event: 'loop.delay', p50: 1, p99: 80, max: 90, count: 500 }),
        line({ event: 'log.dropped', count: 7 }),
      ]).loop.verdict,
    ).toBe('fail');
  });

  it('says when no window had enough samples', () => {
    expect(
      summariseLog([line({ event: 'loop.delay', p50: 1, p99: 2, max: 3, count: 10 })]).loop.verdict,
    ).toBe('insufficient samples');
  });
});
