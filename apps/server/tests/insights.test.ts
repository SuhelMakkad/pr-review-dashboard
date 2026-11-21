import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { Backfill } from '@/insights/backfill.js';
import { SyncService } from '@/sync/index.js';
import {
  computeInsights,
  percentile,
  turnarounds,
  type ActivityEvent,
} from '@review-desk/shared/insights';

const HOUR = 3_600_000;
const now = Date.parse('2026-11-05T12:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
const event = (
  kind: ActivityEvent['kind'],
  prId: string,
  hoursAgo: number,
  data: Record<string, unknown> = {},
): ActivityEvent => ({
  key: `${kind}:${prId}:${hoursAgo}`,
  prId,
  repository: prId.startsWith('web') ? 'acme/web' : 'acme/api',
  number: 1,
  kind,
  actor: null,
  at: at(hoursAgo),
  data,
});

describe('turnaround', () => {
  it('pairs each request with your next review, drops removed requests and keeps open ones', () => {
    const events = [
      event('request_received', 'api-1', 50),
      event('review_submitted', 'api-1', 48, { state: 'CHANGES_REQUESTED' }),
      event('request_received', 'api-1', 30),
      event('review_submitted', 'api-1', 29, { state: 'APPROVED' }),
      event('request_received', 'api-2', 20),
      event('request_removed', 'api-2', 19),
      event('review_submitted', 'api-2', 10, { state: 'COMMENTED' }),
      event('request_received', 'web-3', 5),
      event('request_received', 'web-4', 70),
      event('pr_merged', 'web-4', 60),
    ];
    const { pairs, open } = turnarounds(events);

    expect(pairs.map((pair) => pair.hours)).toEqual([2, 1]);
    expect(open).toEqual([{ prId: 'web-3', requestedAt: at(5) }]);
  });

  it('computes the headline numbers, buckets around the target and a daily series', () => {
    const events = [10, 3, 30, 60].flatMap((delay, index) => [
      event('request_received', `api-${index}`, 100 + delay),
      event('review_submitted', `api-${index}`, 100, {
        state: index % 2 ? 'APPROVED' : 'CHANGES_REQUESTED',
      }),
    ]);
    const insights = computeInsights(events, [], { days: 7, slaHours: 24, now });

    expect(insights.turnaround).toMatchObject({
      count: 4,
      breaches: 2,
      medianHours: 20,
      p90Hours: expect.closeTo(51, 0),
    });
    expect(
      insights.turnaround.buckets
        .filter((bucket) => bucket.count)
        .map((bucket) => [bucket.label, bucket.count, bucket.overTarget]),
    ).toEqual([
      ['1–4h', 1, false],
      ['8–24h', 1, false],
      ['1–2d', 1, true],
      ['2–5d', 1, true],
    ]);
    expect(insights.reviews.granularity).toBe('day');
    expect(insights.reviews.series.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(4);
    expect(insights.verdicts).toEqual({ approved: 2, changesRequested: 2, commented: 0 });
    expect(computeInsights(events, [], { days: 90, slaHours: 24, now }).reviews.granularity).toBe(
      'week',
    );
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('history backfill', () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    vi.restoreAllMocks();
  });

  async function setup() {
    const store = new Store(':memory:');
    const github = new FixtureGitHub(() => defaultScenario());
    const sync = new SyncService(store, github, new EventBus());

    stores.push(store);
    await sync.sync();

    return { store, github, sync, backfill: new Backfill(sync, sync.events) };
  }

  it('fills 90 days of review history and resumes without refetching', async () => {
    const { store, github, sync, backfill } = await setup();
    const history = vi.spyOn(github, 'history');

    await backfill.start('you');

    const insights = computeInsights(store.activity('you'), [], { days: 90, slaHours: 24 });

    expect(insights.turnaround.count).toBeGreaterThan(60);
    expect(insights.authored.opened).toBeGreaterThan(5);
    expect(backfill.state('you')).toMatchObject({
      finishedAt: expect.any(String),
      lastError: null,
      running: false,
    });
    expect(backfill.state('you').doneWindows).toHaveLength(2);

    const fetched = history.mock.calls.flatMap(([ids]) => ids).length;

    await backfill.start('you');
    expect(history.mock.calls.slice(-3).flatMap(([ids]) => ids).length).toBeLessThan(fetched);
    expect(sync.status.account?.login).toBe('you');
  });

  it('records the error and keeps what it already had when GitHub fails', async () => {
    const { github, backfill } = await setup();

    vi.spyOn(github, 'searchPullIds').mockRejectedValue(new Error('rate limited'));
    await backfill.start('you');

    expect(backfill.state('you')).toMatchObject({ lastError: 'rate limited', finishedAt: null });
  });
});

describe("the demo fixture's history search", () => {
  it('keeps to the repositories it is given', async () => {
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const window = { login: 'you', from: '2020-01-01', to: '2030-12-31' };
    const repositoryOf = async (ids: string[]) =>
      new Set((await fixture.history(ids)).map((pull) => pull.repository));
    const all = await fixture.searchPullIds({ kind: 'authored', ...window });
    const repositories = await repositoryOf(all);

    // The scenario spans more than one repository, so narrowing it to one leaves the rest out.
    expect(repositories.size).toBeGreaterThan(1);

    const [first] = repositories;
    const scoped = await fixture.searchPullIds({
      kind: 'authored',
      ...window,
      repositories: [first],
    });

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.length).toBeLessThan(all.length);
    expect(await repositoryOf(scoped)).toEqual(new Set([first]));
  });
});

describe("the demo fixture's traits", () => {
  it("are its own, so one test's change never reaches another fixture", () => {
    const changed = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const other = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));

    changed.traits.reference.separator = '!';
    changed.traits.approvalCarriesSummary = false;

    expect(other.traits.reference.separator).toBe('#');
    expect(other.traits.approvalCarriesSummary).toBe(true);
  });
});
