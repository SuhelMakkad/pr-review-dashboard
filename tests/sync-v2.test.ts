import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../apps/server/src/db/store';
import { GitHub, GitHubError } from '../apps/server/src/github/index';
import type { DetectResult } from '../apps/server/src/github/api';
import { SyncService } from '../apps/server/src/sync/index';
import { snapshot } from './fixtures';

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

/** A GitHub fake whose fingerprints only change when the test says so. */
function setup(options: { feeds?: Partial<Record<string, string[]>> } = {}) {
  const store = new Store(':memory:');
  const github = new GitHub();
  const fingerprints = new Map<string, string>([['pr-1', 'v1']]);
  const states = new Map<string, DetectResult['state']>([['pr-1', 'OPEN']]);
  const feeds: Record<string, string[]> = { requested: ['pr-1'], ...options.feeds } as Record<
    string,
    string[]
  >;

  stores.push(store);
  vi.spyOn(github, 'identity').mockResolvedValue({ login: 'me' });
  vi.spyOn(github, 'teams').mockResolvedValue([]);
  vi.spyOn(github, 'discover').mockImplementation(async (_login, source) => feeds[source] ?? []);
  vi.spyOn(github, 'detect').mockImplementation(async (ids) => ({
    results: ids.map((id) => ({
      id,
      state: states.has(id) ? states.get(id)! : null,
      fingerprint: states.get(id) ? (fingerprints.get(id) ?? 'v1') : null,
    })),
    budget: { limit: 5000, remaining: 4000, resetAt: new Date().toISOString(), cost: 1 },
  }));
  vi.spyOn(github, 'snapshot').mockImplementation(async (id, _login, sources) =>
    snapshot({ id, sources, headOid: fingerprints.get(id) ?? 'head-1' }),
  );

  return { store, github, fingerprints, states, feeds, service: new SyncService(store, github) };
}

describe('incremental sync', () => {
  it('fetches a full snapshot only when the fingerprint changes', async () => {
    const { service, github, fingerprints } = setup();

    await service.sync();
    await service.sync();
    expect(github.snapshot).toHaveBeenCalledTimes(1);
    expect(github.detect).toHaveBeenCalledTimes(2);

    fingerprints.set('pr-1', 'v2');
    await service.sync();
    expect(github.snapshot).toHaveBeenCalledTimes(2);
  });

  it('reconciles a PR in full once its reconcile time has passed', async () => {
    const { service, github, store } = setup();

    await service.sync();
    store.saveSyncState('me', 'pr-1', {
      ...store.syncState('me', 'pr-1')!,
      nextFullAt: new Date(Date.now() - 1000).toISOString(),
    });
    await service.sync();

    expect(github.snapshot).toHaveBeenCalledTimes(2);
  });

  it('refetches cached snapshots that predate v2', async () => {
    const { service, github, store } = setup();

    await service.sync();

    const legacy = { ...store.snapshot('me', 'pr-1')! } as Record<string, unknown>;

    delete legacy.version;
    delete legacy.conversation;
    delete legacy.verdicts;
    store.db.$client
      .prepare('UPDATE snapshots SET data = ? WHERE id = ?')
      .run(JSON.stringify(legacy), 'pr-1');
    await service.sync();

    expect(github.snapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps a PR’s sources when one discovery feed fails', async () => {
    const { service, github } = setup({ feeds: { requested: ['pr-1'], reviewed: ['pr-1'] } });

    await service.sync();
    expect(service.list().items[0].sources).toEqual(['requested', 'reviewed']);

    vi.mocked(github.discover).mockImplementation(async (_login, source) => {
      if (source === 'reviewed') throw new Error('search timed out');

      return source === 'requested' ? ['pr-1'] : [];
    });
    await service.sync();

    expect(service.list().items[0].sources).toEqual(['requested', 'reviewed']);
    expect(service.status.warnings).toContain('reviewed search incomplete: search timed out');
  });

  it('removes a PR when detection confirms it merged, without a full fetch', async () => {
    const { service, github, states } = setup();

    await service.sync();
    states.set('pr-1', 'MERGED');
    await service.sync();

    expect(service.list().items).toHaveLength(0);
    expect(github.snapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached record when a PR becomes invisible', async () => {
    const { service, states } = setup();

    await service.sync();
    states.delete('pr-1');
    await service.sync();

    expect(service.list().items).toHaveLength(1);
    expect(service.status.warnings[0]).toMatch(/unavailable; its cached record was retained/);
  });

  it('falls back to full snapshots when change detection fails', async () => {
    const { service, github } = setup();

    await service.sync();
    vi.mocked(github.detect).mockRejectedValue(new Error('detect broke'));
    await service.sync();

    expect(github.snapshot).toHaveBeenCalledTimes(2);
    expect(service.status.warnings[0]).toMatch(/Change detection unavailable/);
  });

  it('pauses on a rate limit reported by detection', async () => {
    const { service, github } = setup();
    const retryAt = new Date(Date.now() + 60_000).toISOString();

    await service.sync();
    vi.mocked(github.detect).mockRejectedValue(new GitHubError('rate limited', retryAt));
    await service.sync();

    expect(service.status.retryAt).toBe(retryAt);
    expect(github.snapshot).toHaveBeenCalledTimes(1);
  });

  it('respects feed cadences on scheduled runs but runs every feed on demand', async () => {
    const { service, github } = setup();

    await service.sync();
    vi.mocked(github.discover).mockClear();

    await service.sync({ scheduled: true });
    expect(github.discover).not.toHaveBeenCalled();

    await service.sync();
    expect(github.discover).toHaveBeenCalledTimes(5);
  });

  it('keeps your own PRs out of the inbox and lists them in the author view', async () => {
    const { service, github } = setup({ feeds: { requested: ['pr-1'], authored: ['mine-1'] } });

    vi.mocked(github.detect).mockImplementation(async (ids) => ({
      results: ids.map((id) => ({ id, state: 'OPEN' as const, fingerprint: 'stable' })),
      budget: null,
    }));
    vi.mocked(github.snapshot).mockImplementation(async (id, _login, sources) =>
      snapshot({
        id,
        number: id === 'mine-1' ? 9 : 1,
        sources,
        author: { login: id === 'mine-1' ? 'me' : 'author' },
        ...(id === 'mine-1' ? { reviews: [] } : {}),
      }),
    );
    await service.sync();

    expect(service.list().items.map((item) => item.id)).toEqual(['pr-1']);
    expect(service.mine().items.map((item) => item.id)).toEqual(['mine-1']);
    expect(service.mine().items[0].group).toBe('needs_you');
  });

  it('records review activity once, however often a PR is synced', async () => {
    const { service, store, fingerprints } = setup();

    await service.sync();
    fingerprints.set('pr-1', 'v2');
    await service.sync();

    const reviews = store.activity('me').filter((event) => event.kind === 'review_submitted');

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      prId: 'pr-1',
      repository: 'acme/repo',
      data: { state: 'APPROVED' },
    });
  });

  it('refreshes a single PR on demand', async () => {
    const { service, github } = setup();

    await service.sync();

    const detail = await service.refresh('pr-1');

    expect(detail?.snapshot.id).toBe('pr-1');
    expect(github.snapshot).toHaveBeenCalledTimes(2);
  });
});
