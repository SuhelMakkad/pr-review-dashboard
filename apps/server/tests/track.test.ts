import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SyncStatus } from '@review-desk/shared/types';
import { createApp } from '@/app.js';
import { feedMembership } from '@/db/schema.js';
import { AccountUnavailable } from '@/forge/account.js';
import type { GitHubApi } from '@/github/api.js';
import { Store } from '@/db/store.js';
import { GitHub, GitHubError } from '@/github/index.js';
import { candidates } from '@/notify/notifier.js';
import { ReviewError } from '@/review/errors.js';
import { SyncService } from '@/sync/index.js';
import type { FeedSource } from '@review-desk/shared/types';
import { snapshot } from '@test/fixtures.js';

const stores: Store[] = [];

/**
 * A GitHub where `pr-2` (acme/repo#2) exists, found only by the searches in `feeds`. Tests can
 * change `feeds` between syncs.
 */
function setup(feeds: Partial<Record<FeedSource, string[]>> = {}) {
  const github = new GitHub();

  vi.spyOn(github, 'identity').mockResolvedValue({ login: 'me' });
  vi.spyOn(github, 'teams').mockResolvedValue([]);
  vi.spyOn(github, 'discover').mockImplementation(async (_login, source) => feeds[source] ?? []);
  vi.spyOn(github, 'detect').mockImplementation(async (ids) => ({
    results: ids.map((id) => ({ id, state: 'OPEN' as const, fingerprint: randomUUID() })),
    budget: null,
  }));
  vi.spyOn(github, 'resolvePull').mockImplementation(async (repository, number) =>
    repository === 'acme/repo' && number === 2 ? { id: 'pr-2', state: 'OPEN' } : null,
  );
  vi.spyOn(github, 'snapshot').mockImplementation(async (id, _login, sources) =>
    snapshot({
      id,
      number: 2,
      url: 'https://github.com/acme/repo/pull/2',
      sources,
      reviews: [],
      reviewDecision: 'REVIEW_REQUIRED',
    }),
  );

  const store = new Store(':memory:');

  stores.push(store);

  return { github, service: new SyncService(store, github) };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

describe('adding a PR to the queue by hand', () => {
  it('tracks the PR as a first review that keeps its place through later syncs', async () => {
    const { service } = setup();

    await service.sync();
    expect(service.list().items).toHaveLength(0);

    const detail = await service.track('me', 'acme/repo', 2);

    expect(detail.snapshot.sources).toEqual(['manual']);
    expect(detail.item.queue).toBe('attention');
    expect(detail.item.reasons.map((reason) => reason.kind)).toEqual(['first_review']);

    await service.sync();

    expect(service.list().items.map((item) => item.id)).toEqual(['pr-2']);
    expect(service.list().items[0].sources).toEqual(['manual']);
  });

  it('keeps the manual source next to the feeds that also find the PR', async () => {
    const { service } = setup({ requested: ['pr-2'] });

    await service.sync();
    await service.track('me', 'acme/repo', 2);
    await service.sync();

    expect(service.detail('pr-2')?.snapshot.sources).toEqual(['requested', 'manual']);
  });

  it('keeps a manual addition made while a sync was fetching the PR', async () => {
    const { github, service } = setup({ mentioned: ['pr-2'] });

    await service.sync();
    expect(service.detail('pr-2')?.snapshot.sources).toEqual(['mentioned']);

    let release!: () => void;
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.mocked(github.snapshot).mockImplementationOnce(async (id, _login, sources) => {
      await fetched;

      return snapshot({ id, number: 2, sources, reviews: [] });
    });

    const running = service.sync();

    await vi.waitFor(() => expect(github.snapshot).toHaveBeenCalledTimes(2));
    await service.track('me', 'acme/repo', 2);
    release();
    await running;

    const detail = service.detail('pr-2')!;

    expect(detail.snapshot.sources).toEqual(['mentioned', 'manual']);
    expect(detail.item.queue).toBe('attention');
  });

  it('explains PRs that cannot be added', async () => {
    const { github, service } = setup();

    await service.sync();

    await expect(service.track('me', 'acme/missing', 9)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });

    vi.mocked(github.resolvePull).mockResolvedValue({ id: 'pr-2', state: 'MERGED' });
    await expect(service.track('me', 'acme/repo', 2)).rejects.toMatchObject({
      code: 'PR_CLOSED',
      message: 'acme/repo#2 is merged, so there is nothing to review.',
    });

    await expect(service.track('someone-else', 'acme/repo', 2)).rejects.toBeInstanceOf(ReviewError);
    expect(service.list().items).toHaveLength(0);
  });

  it('leaves the queue untouched when the PR cannot be fetched', async () => {
    const { github, service } = setup();

    await service.sync();
    vi.mocked(github.snapshot).mockRejectedValue(new GitHubError('GitHub is down.'));

    await expect(service.track('me', 'acme/repo', 2)).rejects.toThrow('GitHub is down.');
    expect(service.store.membership('me').size).toBe(0);
    expect(service.detail('pr-2')).toBeNull();
  });

  it('does not announce a PR you added as a review request', async () => {
    const { service } = setup();

    await service.sync();
    await service.track('me', 'acme/repo', 2);

    expect(candidates(service.list().items, [])).toEqual([]);
  });
});

describe('removing a PR added by hand', () => {
  it('stops tracking a PR that no feed returns', async () => {
    const { service } = setup();

    await service.sync();
    await service.track('me', 'acme/repo', 2);

    expect(service.untrack('me', 'pr-2')).toEqual({ tracked: false });
    expect(service.detail('pr-2')).toBeNull();

    await service.sync();
    expect(service.list().items).toHaveLength(0);
  });

  it('keeps a PR that a feed still returns, without the manual source', async () => {
    const { service } = setup({ requested: ['pr-2'] });

    await service.sync();
    await service.track('me', 'acme/repo', 2);

    expect(service.untrack('me', 'pr-2')).toEqual({ tracked: true });
    expect(service.detail('pr-2')?.snapshot.sources).toEqual(['requested']);
  });

  it('does not bring back a PR removed while a sync was fetching it', async () => {
    const { github, service } = setup();

    await service.sync();
    await service.track('me', 'acme/repo', 2);

    let release!: () => void;
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.mocked(github.snapshot).mockImplementationOnce(async (id, _login, sources) => {
      await fetched;

      return snapshot({ id, number: 2, sources, reviews: [] });
    });

    const running = service.sync();

    await vi.waitFor(() => expect(github.snapshot).toHaveBeenCalledTimes(2));
    service.untrack('me', 'pr-2');
    release();
    await running;

    expect(service.detail('pr-2')).toBeNull();

    await service.sync();
    expect(service.list().items).toHaveLength(0);
  });

  it('does not bring back a PR removed while it was being refreshed', async () => {
    const { github, service } = setup();

    await service.sync();
    await service.track('me', 'acme/repo', 2);

    let release!: () => void;
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.mocked(github.snapshot).mockImplementationOnce(async (id, _login, sources) => {
      await fetched;

      return snapshot({ id, number: 2, sources, reviews: [] });
    });

    const refreshing = service.refresh('pr-2');

    service.untrack('me', 'pr-2');
    release();

    expect(await refreshing).toBeNull();
    expect(service.detail('pr-2')).toBeNull();

    await service.sync();
    expect(service.list().items).toHaveLength(0);
  });

  it('does not bring back a PR removed while a sync was checking for changes', async () => {
    const feeds: Partial<Record<FeedSource, string[]>> = { requested: ['pr-2'] };
    const { github, service } = setup(feeds);

    // A stable fingerprint, so only the removal (which drops the PR's sync state) makes the
    // next sync refetch it; that refetch must not be saved.
    vi.mocked(github.detect).mockImplementation(async (ids) => ({
      results: ids.map((id) => ({ id, state: 'OPEN' as const, fingerprint: 'unchanged' })),
      budget: null,
    }));

    await service.sync();
    await service.track('me', 'acme/repo', 2);
    await service.sync();
    expect(service.detail('pr-2')?.snapshot.sources).toEqual(['requested', 'manual']);

    // The request is withdrawn, so the PR is now tracked only because you added it.
    feeds.requested = [];

    let release!: () => void;
    const checked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detect = vi.mocked(github.detect).getMockImplementation()!;

    vi.mocked(github.detect).mockImplementationOnce(async (ids) => {
      await checked;

      return detect(ids);
    });

    const running = service.sync();

    await vi.waitFor(() => expect(github.detect).toHaveBeenCalledTimes(3));
    expect(service.untrack('me', 'pr-2')).toEqual({ tracked: false });
    release();
    await running;

    expect(service.detail('pr-2')).toBeNull();
  });

  it('refuses to remove a PR that a feed found', async () => {
    const { service } = setup({ requested: ['pr-2'] });

    await service.sync();

    expect(() => service.untrack('me', 'pr-2')).toThrow(
      'Only PRs you added yourself can be removed.',
    );
  });
});

describe('queue API', () => {
  const headers = {
    host: '127.0.0.1:4317',
    'content-type': 'application/json',
    'x-review-desk': '1',
    'x-review-desk-session': 'test-session-token',
  };

  it('adds and removes PRs, with clear errors', async () => {
    const { github, service } = setup();

    await service.sync();

    const app = await createApp(service, { sessionToken: 'test-session-token' });
    const track = (payload: Record<string, unknown>, account = 'me') =>
      app.inject({ method: 'POST', url: `/api/accounts/${account}/pulls/track`, headers, payload });

    expect((await track({ repository: 'acme', number: 2 })).statusCode).toBe(400);
    expect((await track({ repository: 'acme/repo', number: 0 })).statusCode).toBe(400);
    // The path names the account; a body that names one too is refused.
    expect((await track({ account: 'me', repository: 'acme/repo', number: 2 })).statusCode).toBe(
      400,
    );

    const missing = await track({ repository: 'acme/missing', number: 2 });

    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');

    // An account this app never worked as.
    const unknown = await track({ repository: 'acme/repo', number: 2 }, 'old-account');

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('UNKNOWN_ACCOUNT');

    const added = await track({ repository: 'acme/repo', number: 2 });

    expect(added.statusCode).toBe(200);
    expect(added.json().snapshot.sources).toEqual(['manual']);
    expect(added.json().membershipId).toEqual(expect.any(String));
    expect(
      (await app.inject({ method: 'GET', url: '/api/accounts/me/pulls', headers })).json().items,
    ).toHaveLength(1);

    // A malformed membership is refused rather than removing whatever is there.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/accounts/me/pulls/pr-2/track',
          headers,
          payload: { membershipId: null },
        })
      ).statusCode,
    ).toBe(400);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/me/pulls/pr-2/track',
      headers,
      payload: { membershipId: added.json().membershipId },
    });

    expect(removed.json()).toEqual({ tracked: false });
    expect(
      (await app.inject({ method: 'GET', url: '/api/accounts/me/pulls', headers })).json().items,
    ).toEqual([]);

    vi.mocked(github.resolvePull).mockRejectedValue(
      new GitHubError('Rate limited', '2030-01-01T00:00:00.000Z', 403, 'rate_limit'),
    );

    const limited = await track({ repository: 'acme/repo', number: 2 });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');

    await app.close();
  });
});

describe('adding by hand for an account not in use', () => {
  const ANN = 'ann@git.a.example';
  const BOB = 'bob@git.b.example';

  /** Ann's GitLab serves below `/gitlab`; Bob, in use, is on another GitLab at its root. */
  function inactive() {
    const store = new Store(':memory:');
    const state = { signedIn: ANN, onSnapshot: null as null | (() => void) };
    const api = {
      resolvePull: vi.fn(async (repository: string, number: number) =>
        repository === 'team/app' && number === 5 ? { id: 'mr-5', state: 'OPEN' as const } : null,
      ),
      snapshot: vi.fn(async (id: string, _login: string, sources: FeedSource[]) => {
        state.onSnapshot?.();

        return snapshot({
          id,
          number: 5,
          url: 'https://git.a.example/gitlab/team/app/-/merge_requests/5',
          sources,
          reviews: [],
        });
      }),
      verifyAccount: vi.fn(async (account: string) => {
        if (state.signedIn !== account) throw new AccountUnavailable(account, state.signedIn);
      }),
    } as unknown as GitHubApi;
    const service = new SyncService(store, api);
    const account = (login: string, webUrl: string) =>
      ({ ...service.status, account: { login, webUrl } }) as unknown as SyncStatus;

    stores.push(store);
    store.setSetting(`status:${ANN}`, account(ANN, 'https://git.a.example/gitlab/ann'));
    service.status = account(BOB, 'https://git.b.example/bob');

    const track = () => service.track(ANN, 'gitlab/team/app', 5, 'git.a.example', true);

    return { store, service, api, state, track };
  }

  it('reads as that account, below its own web root, under its own cooldown', async () => {
    const { service, api, track } = inactive();
    const later = new Date(Date.now() + 3_600_000).toISOString();

    // Bob's cooldown is Bob's.
    service.deferUntil(later, BOB);

    const added = await track();

    expect(added.snapshot.id).toBe('mr-5');
    expect(added.membershipId).toEqual(expect.any(String));
    expect(api.resolvePull).toHaveBeenCalledWith('team/app', 5);

    // Ann's refuses Ann's add, reading nothing.
    service.untrack(ANN, 'mr-5');
    service.deferUntil(later, ANN);
    await expect(track()).rejects.toMatchObject({ outcome: 'rate_limit' });
    expect(api.resolvePull).toHaveBeenCalledTimes(1);
  });

  it('saves nothing when glab signs in as someone else during the reads', async () => {
    const { store, state, track } = inactive();

    state.onSnapshot = () => (state.signedIn = 'eve@git.a.example');

    await expect(track()).rejects.toBeInstanceOf(AccountUnavailable);
    expect(store.snapshot(ANN, 'mr-5')).toBeNull();
    expect(store.manualAddedAt(ANN, 'mr-5')).toBeNull();
  });

  it('lets an Undo remove only the membership its add made, however fast the next one came', async () => {
    const { store, service, track } = inactive();

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-21T10:00:00Z'));

    const first = await track();

    // A second add of a PR already added changes nothing, and offers no Undo.
    expect((await track()).membershipId).toBeNull();

    // Removed and added again in the same instant: the first add's Undo is not the re-add's.
    service.untrack(ANN, 'mr-5');

    const second = await track();

    expect(second.membershipId).not.toBe(first.membershipId);
    expect(() => service.untrack(ANN, 'mr-5', first.membershipId!)).toThrow('added again since');
    expect(store.manualAddedAt(ANN, 'mr-5')).not.toBeNull();
    expect(service.untrack(ANN, 'mr-5', second.membershipId!)).toEqual({ tracked: false });
  });

  it('offers no Undo for a PR added before memberships had IDs, and still removes it', async () => {
    const { store, service, track } = inactive();

    await track();
    service.untrack(ANN, 'mr-5');
    await track();
    // As a version before memberships had IDs saved it.
    store.db
      .update(feedMembership)
      .set({ membershipId: null })
      .where(eq(feedMembership.account, ANN))
      .run();

    expect((await track()).membershipId).toBeNull();
    expect(service.untrack(ANN, 'mr-5')).toEqual({ tracked: false });
  });
});
