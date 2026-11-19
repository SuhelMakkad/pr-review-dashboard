import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@/db/store.js';
import type { DetectOptions } from '@/github/api.js';
import { GitHub } from '@/github/index.js';
import { SyncService } from '@/sync/index.js';
import { SnapshotCoordinator } from '@/sync/snapshots.js';
import type { CiState, FeedSource, PullRequestSnapshot } from '@review-desk/shared/types';
import { snapshot } from '@test/fixtures.js';

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

/**
 * A GitHub with one PR, `pr-2`, whose remote state the test changes. A read sees the state as it
 * was when the read started, and the next read can be held until the test releases it.
 */
function setup(feeds: Partial<Record<FeedSource, string[]>> = { requested: ['pr-2'] }) {
  const remote: {
    headOid: string;
    baseOid: string;
    state: PullRequestSnapshot['state'];
    viewed: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
    ci: CiState;
    fingerprint: string;
    /** Set to make the forge identify each file's diff, as GitLab does. */
    fileKey?: string;
    /** Stands for the PR's details (reviews, description and so on). */
    title?: string;
  } = {
    headOid: 'head-1',
    baseOid: 'base-1',
    state: 'OPEN',
    viewed: 'UNVIEWED',
    ci: 'success',
    fingerprint: 'v1',
  };
  const holds: Promise<void>[] = [];
  const github = new GitHub();

  vi.spyOn(github, 'identity').mockResolvedValue({ login: 'me' });
  vi.spyOn(github, 'teams').mockResolvedValue([]);
  vi.spyOn(github, 'discover').mockImplementation(async (_login, source) => feeds[source] ?? []);
  vi.spyOn(github, 'detect').mockImplementation(async (ids) => ({
    results: ids.map((id) => ({ id, state: remote.state, fingerprint: remote.fingerprint })),
    budget: null,
  }));
  vi.spyOn(github, 'resolvePull').mockImplementation(async (repository, number) =>
    repository === 'acme/repo' && number === 2 ? { id: 'pr-2', state: 'OPEN' } : null,
  );
  vi.spyOn(github, 'snapshot').mockImplementation(async (id, _login, sources) => {
    const seen = { ...remote };
    const hold = holds.shift();

    if (hold) await hold;

    return snapshot({
      id,
      number: 2,
      url: 'https://github.com/acme/repo/pull/2',
      sources,
      ...(seen.title ? { title: seen.title } : {}),
      headOid: seen.headOid,
      baseOid: seen.baseOid,
      headObservedAt: new Date().toISOString(),
      state: seen.state,
      ci: seen.ci,
      files: [
        {
          path: 'src/app.ts',
          additions: 1,
          deletions: 0,
          viewerViewedState: seen.viewed,
          ...(seen.fileKey ? { viewedKey: seen.fileKey } : {}),
        },
      ],
      reviews: [],
      reviewDecision: 'REVIEW_REQUIRED',
    });
  });

  const store = new Store(':memory:');
  const service = new SyncService(store, github);

  stores.push(store);

  /** Holds the next read until the returned function is called. */
  const holdNextRead = () => {
    let release!: () => void;

    holds.push(new Promise<void>((resolve) => (release = resolve)));

    return release;
  };
  /** Resolves once `count` reads have started. */
  const readsStarted = (count: number) =>
    vi.waitFor(() => expect(vi.mocked(github.snapshot).mock.calls.length).toBe(count));

  return { github, store, service, remote, holdNextRead, readsStarted };
}

/** The revision `setup()` starts at, as a forge reports it for a viewed write. */
const revision1 = { headOid: 'head-1', baseOid: 'base-1' };

describe('saving PR snapshots in order', () => {
  it('never lets a slower read that started earlier replace a newer one', async () => {
    const { service, remote, holdNextRead, readsStarted } = setup();

    await service.sync();

    const release = holdNextRead();
    const older = service.refresh('pr-2');

    await readsStarted(2);
    remote.headOid = 'head-2';

    const newer = await service.refresh('pr-2');

    expect(newer?.snapshot.headOid).toBe('head-2');

    release();

    // The earlier call gets the newer state, which was also fetched after it began.
    expect((await older)?.snapshot.headOid).toBe('head-2');
    expect(service.detail('pr-2')?.snapshot.headOid).toBe('head-2');
  });

  it('keeps a refresh that finished during a sync over the sync’s older read', async () => {
    const { service, remote, holdNextRead, readsStarted } = setup();

    await service.sync();
    remote.fingerprint = 'v2';

    const release = holdNextRead();
    const syncing = service.sync();

    await readsStarted(2);
    remote.headOid = 'head-2';
    await service.refresh('pr-2');
    release();
    await syncing;

    expect(service.detail('pr-2')?.snapshot.headOid).toBe('head-2');
  });

  it('keeps a closure seen by change detection over an earlier read that said open', async () => {
    const { service, remote, holdNextRead, readsStarted } = setup();

    await service.sync();

    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');

    await readsStarted(2);
    remote.state = 'MERGED';
    await service.sync();
    release();

    expect(await refreshing).toBeNull();
    expect(service.detail('pr-2')).toBeNull();
    expect(service.list().items).toHaveLength(0);
  });

  it('keeps a viewed mark written while an older read was in flight', async () => {
    const { store, service, remote, holdNextRead, readsStarted } = setup();
    const viewed = () => store.snapshot('me', 'pr-2')?.files[0].viewerViewedState;

    await service.sync();

    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');

    await readsStarted(2);
    remote.viewed = 'VIEWED';
    expect(service.markViewed('me', 'pr-2', 'src/app.ts', true, revision1)).toBe(true);
    expect(viewed()).toBe('VIEWED');

    release();
    await refreshing;
    expect(viewed()).toBe('VIEWED');

    // A read that started after the mark is the forge's word again.
    remote.viewed = 'UNVIEWED';
    await service.refresh('pr-2');
    expect(viewed()).toBe('UNVIEWED');
  });

  it('leaves the forge’s viewed state on a read of a newer head than the mark was for', async () => {
    const { store, service, remote, holdNextRead, readsStarted } = setup();

    await service.sync();

    // New commits change the file; the read in flight sees them and no viewed mark for them.
    remote.headOid = 'head-2';
    remote.viewed = 'DISMISSED';

    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');

    await readsStarted(2);
    // You mark the file viewed in the diff you have, which is still head-1.
    service.markViewed('me', 'pr-2', 'src/app.ts', true, revision1);
    release();
    await refreshing;

    expect(store.snapshot('me', 'pr-2')).toMatchObject({
      headOid: 'head-2',
      files: [{ path: 'src/app.ts', viewerViewedState: 'DISMISSED' }],
    });
  });

  it('leaves the forge’s viewed state on a read whose base changed under the same head', async () => {
    const { store, service, remote, holdNextRead, readsStarted } = setup();

    await service.sync();
    remote.baseOid = 'base-2';

    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');

    await readsStarted(2);
    service.markViewed('me', 'pr-2', 'src/app.ts', true, revision1);
    release();
    await refreshing;

    expect(store.snapshot('me', 'pr-2')).toMatchObject({
      baseOid: 'base-2',
      files: [{ viewerViewedState: 'UNVIEWED' }],
    });
  });

  it('marks nothing locally when the stored PR or the forge’s answer is another revision', async () => {
    const { store, service, remote } = setup();
    const viewed = () => store.snapshot('me', 'pr-2')?.files[0].viewerViewedState;

    await service.sync();

    // A refresh saved new commits before the write that marked the old diff returned.
    remote.headOid = 'head-2';
    await service.refresh('pr-2');
    expect(service.markViewed('me', 'pr-2', 'src/app.ts', true, revision1)).toBe(false);
    expect(viewed()).toBe('UNVIEWED');

    // The forge could not say which diff it marked.
    expect(service.markViewed('me', 'pr-2', 'src/app.ts', true, null)).toBe(false);
    expect(viewed()).toBe('UNVIEWED');

    // An unmark holds for every revision.
    remote.viewed = 'VIEWED';
    await service.refresh('pr-2');
    expect(service.markViewed('me', 'pr-2', 'src/app.ts', false, null)).toBe(true);
    expect(viewed()).toBe('UNVIEWED');
  });

  it('matches a mark to the file’s own diff where the forge identifies it', async () => {
    const { store, service, remote, holdNextRead, readsStarted } = setup();

    remote.fileKey = 'diff-a';
    await service.sync();

    // The file changes under the same head and base (GitLab reads them apart from the diffs).
    remote.fileKey = 'diff-b';
    remote.viewed = 'DISMISSED';

    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');

    await readsStarted(2);
    // The mark is for diff A, which is what is stored.
    expect(
      service.markViewed('me', 'pr-2', 'src/app.ts', true, { ...revision1, fileKey: 'diff-a' }),
    ).toBe(true);
    expect(store.snapshot('me', 'pr-2')?.files[0].viewerViewedState).toBe('VIEWED');

    release();
    await refreshing;

    // The read shows diff B, which nobody has seen: the forge's own state stays.
    expect(store.snapshot('me', 'pr-2')?.files[0]).toMatchObject({
      viewedKey: 'diff-b',
      viewerViewedState: 'DISMISSED',
    });
  });

  it('refuses to add a PR that a sync saw merged while it was being added', async () => {
    const feeds: Partial<Record<FeedSource, string[]>> = {};
    const { store, service, remote, holdNextRead, readsStarted } = setup(feeds);

    await service.sync();

    const release = holdNextRead();
    const adding = service.track('me', 'acme/repo', 2);

    await readsStarted(1);
    // Meanwhile a review request makes the sync find it, already merged.
    feeds.requested = ['pr-2'];
    remote.state = 'MERGED';
    await service.sync();
    release();

    await expect(adding).rejects.toMatchObject({ code: 'PR_CLOSED' });
    expect(store.manualAddedAt('me', 'pr-2')).toBeNull();
    expect(store.snapshot('me', 'pr-2')).toBeNull();
  });

  it('closes a PR whose first add was saved while change detection was in flight', async () => {
    const feeds: Partial<Record<FeedSource, string[]>> = {};
    const { github, store, service, remote, holdNextRead, readsStarted } = setup(feeds);

    await service.sync();

    const release = holdNextRead();
    const adding = service.track('me', 'acme/repo', 2);

    await readsStarted(1);
    feeds.requested = ['pr-2'];
    remote.state = 'MERGED';

    // Detection starts after the add's read and finishes after the add is saved.
    const detect = vi.mocked(github.detect).getMockImplementation()!;
    let detected!: () => void;
    const held = new Promise<void>((resolve) => (detected = resolve));

    vi.mocked(github.detect).mockImplementationOnce(async (ids) => {
      await held;

      return detect(ids);
    });

    const detections = vi.mocked(github.detect).mock.calls.length;
    const syncing = service.sync();

    await vi.waitFor(() => expect(vi.mocked(github.detect).mock.calls.length).toBe(detections + 1));
    release();
    expect((await adding).snapshot.state).toBe('OPEN');

    detected();
    await syncing;
    expect(store.snapshot('me', 'pr-2')?.state).toBe('MERGED');
    expect(service.detail('pr-2')).toBeNull();
  });

  it('keeps what an earlier full read saw when change detection saved the merge first', async () => {
    const { store, service, remote, holdNextRead, readsStarted } = setup();

    await service.sync();

    // The PR is merged with final details; a refresh reads them, but finishes late.
    remote.title = 'Final title after the last review';
    remote.state = 'MERGED';

    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');

    await readsStarted(2);
    await service.sync();
    expect(store.snapshot('me', 'pr-2')?.state).toBe('MERGED');

    release();
    await refreshing;
    expect(store.snapshot('me', 'pr-2')).toMatchObject({
      title: 'Final title after the last review',
      state: 'MERGED',
    });
  });

  it('never reopens a PR from a read that started before its merge was seen', async () => {
    const { store, service, remote, holdNextRead, readsStarted } = setup();

    await service.sync();

    // The refresh reads it open; detection, later, sees it merged and saves that first.
    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');

    await readsStarted(2);
    remote.state = 'MERGED';
    remote.title = 'Details read while still open';
    await service.sync();
    release();

    expect(await refreshing).toBeNull();
    expect(store.snapshot('me', 'pr-2')?.state).toBe('MERGED');
    expect(service.list().items).toHaveLength(0);
  });

  it('waits for every PR of a sync, even when saving one of them fails', async () => {
    const { github, store, service, remote, holdNextRead } = setup({
      requested: ['pr-2', 'pr-3'],
    });

    await service.sync();
    remote.fingerprint = 'v2';

    const reads = vi.mocked(github.snapshot).mock.calls.length;
    const lookup = store.snapshot.bind(store);
    let failing = true;

    // pr-2's read is held; reading pr-3's stored row fails once.
    const release = holdNextRead();

    vi.spyOn(store, 'snapshot').mockImplementation((account, id) => {
      if (id === 'pr-3' && failing) {
        failing = false;
        throw new Error('disk read failed');
      }

      return lookup(account, id);
    });

    let finished = false;
    const syncing = service.sync().then(() => (finished = true));

    await vi.waitFor(() => expect(vi.mocked(github.snapshot).mock.calls.length).toBe(reads + 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);

    remote.headOid = 'head-2';
    release();
    await syncing;

    expect(service.status.warnings.join()).toContain('disk read failed');
    expect(store.snapshot('me', 'pr-2')?.headOid).toBe('head-1');
  });

  it('polls running CI by what is saved, never by a read that was not', async () => {
    const { github, service, remote, holdNextRead, readsStarted } = setup();
    // GitHub's own detection ignores the options; the sync passes them to every forge.
    const polled = () =>
      (vi.mocked(github.detect).mock.calls.at(-1) as unknown[] | undefined)?.[1] as
        DetectOptions | undefined;

    await service.sync();
    expect(polled()?.ciPending).toEqual(new Set());

    // An older read sees CI finished; a newer one, saved first, sees it running again.
    const release = holdNextRead();
    const older = service.refresh('pr-2');

    await readsStarted(2);
    remote.ci = 'pending';
    await service.refresh('pr-2');
    remote.ci = 'success';
    release();
    await older;

    await service.sync();
    expect(polled()?.ciPending).toEqual(new Set(['pr-2']));
  });

  it('reads again when the PR is reduced while being refreshed, so the result is never older', async () => {
    const { github, service, holdNextRead, readsStarted } = setup();

    await service.sync();
    await service.track('me', 'acme/repo', 2);
    expect(service.detail('pr-2')?.snapshot.sources).toEqual(['requested', 'manual']);

    const release = holdNextRead();
    const refreshing = service.refresh('pr-2');
    const reads = vi.mocked(github.snapshot).mock.calls.length;

    await readsStarted(reads);
    expect(service.untrack('me', 'pr-2')).toEqual({ tracked: true });
    release();

    const detail = await refreshing;

    expect(vi.mocked(github.snapshot).mock.calls.length).toBe(reads + 1);
    expect(detail?.snapshot.sources).toEqual(['requested']);
    expect(service.detail('pr-2')?.snapshot.sources).toEqual(['requested']);
  });

  it('saves nothing of a read when any part of saving it fails', async () => {
    const { store, service, remote } = setup();

    await service.sync();

    const before = store.syncState('me', 'pr-2');

    remote.headOid = 'head-2';
    vi.spyOn(store, 'recordActivity').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(service.refresh('pr-2')).rejects.toThrow('disk full');
    expect(store.snapshot('me', 'pr-2')?.headOid).toBe('head-1');
    expect(store.syncState('me', 'pr-2')).toEqual(before);
  });

  it('keeps when a head was first seen, even when a read was given an older row', async () => {
    const { store, service } = setup();

    await service.sync();

    const first = store.snapshot('me', 'pr-2')!.headObservedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.refresh('pr-2');
    expect(store.snapshot('me', 'pr-2')!.headObservedAt).toBe(first);
  });
});

describe('the snapshot coordinator', () => {
  function coordinator(teams: (account: string) => string[] = () => []) {
    const store = new Store(':memory:');

    stores.push(store);
    store.saveSnapshot('me', snapshot({ id: 'pr-2', headOid: 'head-1' }));

    return { store, snapshots: new SnapshotCoordinator(store, teams) };
  }

  const keep = { fingerprint: null, sources: () => ['requested' as const] };

  it('lets a rolled-back save neither supersede nor refuse a read in flight', () => {
    const { store, snapshots } = coordinator();
    const older = snapshots.observe('me', 'pr-2');
    const newer = snapshots.observe('me', 'pr-2');

    expect(() =>
      store.transaction(() => {
        expect(
          snapshots.commit(newer, snapshot({ id: 'pr-2', headOid: 'head-3' }), keep),
        ).toMatchObject({ status: 'committed' });
        snapshots.invalidate('me', 'pr-2');

        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');

    expect(store.snapshot('me', 'pr-2')?.headOid).toBe('head-1');
    expect(
      snapshots.commit(older, snapshot({ id: 'pr-2', headOid: 'head-2' }), keep),
    ).toMatchObject({
      status: 'committed',
      snapshot: { headOid: 'head-2' },
    });
  });

  it('derives activity and triage with the teams of the account the read was for', () => {
    const accounts: string[] = [];
    const { snapshots } = coordinator((account) => {
      accounts.push(account);

      return [];
    });

    snapshots.commit(snapshots.observe('me', 'pr-2'), snapshot({ id: 'pr-2' }), keep);
    expect(new Set(accounts)).toEqual(new Set(['me']));
  });
});
