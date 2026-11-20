import { describe, expect, it } from 'vitest';
import { summariseLog } from '@/bench/log-summary.js';
import { runBench, stats } from '@/bench/run.js';
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
      '/api/pulls, 40 PRs, idle',
      '/api/pulls, 40 PRs, during a sync',
      'inbox derivation, 40 PRs',
      'My PRs derivation, 40 PRs',
      'full diff of a 60-file PR, cold',
      'rebased interdiff of 20 files, cold',
      'event-loop stall during the interdiff',
      'fingerprints of the large PR',
    ]);

    const during = cases.find((entry) => entry.name.includes('during a sync'))!;

    // Samples counted only while the sync ran, each with the whole list.
    expect(during.stats.n).toBeGreaterThan(0);
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
      ...Array.from({ length: 20 }, (_, index) =>
        line({
          event: 'http.request',
          route: '/api/pulls',
          method: 'GET',
          ms: index < 19 ? 10 : 400,
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
      stats: { n: 20, p95: 10 },
      verdict: 'pass',
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
  });

  it('says when no window had enough samples', () => {
    expect(
      summariseLog([line({ event: 'loop.delay', p50: 1, p99: 2, max: 3, count: 10 })]).loop.verdict,
    ).toBe('insufficient samples');
  });
});
