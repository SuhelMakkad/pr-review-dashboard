import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/server/src/db/store';
import { SyncService } from '../apps/server/src/sync/index';
import { GitHub, GitHubError } from '../apps/server/src/github/index';
import { createApp } from '../apps/server/src/app';
import { snapshot, thread } from './fixtures';

const stores: Store[] = [];
const store = (path = ':memory:') => {
  const value = new Store(path);
  stores.push(value);
  return value;
};

function fakeGitHub() {
  const github = new GitHub();

  vi.spyOn(github, 'identity').mockResolvedValue({ login: 'me' });
  vi.spyOn(github, 'teams').mockResolvedValue(['acme/reviewers']);
  vi.spyOn(github, 'discover').mockImplementation(async (_login, source) =>
    ['requested', 'assigned', 'reviewed'].includes(source) ? ['pr-1'] : [],
  );
  // Every run looks changed, so these tests exercise the full-snapshot path.
  vi.spyOn(github, 'detect').mockImplementation(async (ids) => ({
    results: ids.map((id) => ({ id, state: 'OPEN' as const, fingerprint: randomUUID() })),
    budget: null,
  }));
  vi.spyOn(github, 'snapshot').mockImplementation(async (_id, _login, sources) =>
    snapshot({ sources }),
  );

  return github;
}

afterEach(() => {
  for (const database of stores.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe('sync and local persistence', () => {
  it('deduplicates overlapping feeds and serializes simultaneous refreshes', async () => {
    const github = fakeGitHub();
    const service = new SyncService(store(), github);
    const first = service.sync();
    const second = service.sync();

    expect(first).toBe(second);
    await first;

    expect(github.snapshot).toHaveBeenCalledTimes(1);
    expect(service.list().items).toHaveLength(1);
    expect(service.list().items[0].sources).toEqual(['requested', 'assigned', 'reviewed']);
    expect(service.status.lastSuccessfulSync).not.toBeNull();
  });

  it('retains cached data through auth/network failures and across restarts', async () => {
    const github = fakeGitHub();
    const database = store();
    const service = new SyncService(database, github);

    await service.sync();
    vi.mocked(github.identity).mockRejectedValue(new Error('Offline'));
    await service.sync();

    expect(service.status.error).toBe('Offline');
    expect(service.list().items).toHaveLength(1);
    expect(new SyncService(database, github).list().items).toHaveLength(1);
  });

  it('retains a PR absent from search until closure is confirmed', async () => {
    const github = fakeGitHub();
    const service = new SyncService(store(), github);

    await service.sync();
    vi.mocked(github.discover).mockResolvedValue([]);
    await service.sync();

    expect(service.list().items).toHaveLength(1);

    vi.mocked(github.snapshot).mockResolvedValue(snapshot({ state: 'MERGED' }));
    await service.sync();

    expect(service.list().items).toHaveLength(0);
  });

  it('preserves old PR records on partial failures and flags incomplete coverage', async () => {
    const github = fakeGitHub();
    const service = new SyncService(store(), github);

    await service.sync();
    const lastSuccessful = service.status.lastSuccessfulSync;

    vi.mocked(github.discover).mockRejectedValue(new Error('Search failed'));
    vi.mocked(github.snapshot).mockRejectedValue(new Error('Access unavailable'));
    await service.sync();

    // One warning per failed feed (five) plus the PR that could not be refreshed.
    expect(service.status.warnings).toHaveLength(6);
    expect(service.status.lastSuccessfulSync).toBe(lastSuccessful);
    expect(service.list().items).toHaveLength(1);
  });

  it('respects the rate-limit cooldown on repeated manual refreshes', async () => {
    const github = fakeGitHub();
    const service = new SyncService(store(), github);
    const retryAt = new Date(Date.now() + 300_000).toISOString();

    vi.mocked(github.identity).mockRejectedValue(new GitHubError('Rate limit', retryAt));
    await service.sync();
    await service.sync();

    expect(github.identity).toHaveBeenCalledTimes(1);
    expect(service.status.retryAt).toBe(retryAt);
  });

  it('separates accounts and refuses stale-account triage writes', async () => {
    const github = fakeGitHub();
    const service = new SyncService(store(), github);

    await service.sync();
    service.update('pr-1', { account: 'me', note: 'My private note' });

    vi.mocked(github.identity).mockResolvedValue({ login: 'another-user' });
    await service.sync();

    expect(service.detail('pr-1')?.triage.note).toBe('');
    expect(() => service.update('pr-1', { account: 'me', note: 'Wrong account' })).toThrow(
      'ACCOUNT_CHANGED',
    );

    vi.mocked(github.identity).mockResolvedValue({ login: 'me' });
    await service.sync();

    expect(service.detail('pr-1')?.triage.note).toBe('My private note');
  });

  it('persists notes, seen replies and snoozes in SQLite across a real reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-test-'));
    const path = join(directory, 'state.sqlite');
    const database = new Store(path);
    const service = new SyncService(database, fakeGitHub());

    await service.sync();
    service.update('pr-1', {
      account: 'me',
      note: 'Follow up tomorrow',
      snoozeUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    database.close();

    const reopened = new Store(path);
    const restored = new SyncService(reopened, fakeGitHub());

    expect(restored.detail('pr-1')?.triage.note).toBe('Follow up tomorrow');
    expect(restored.list().items[0].queue).toBe('snoozed');

    reopened.close();
    rmSync(directory, { recursive: true });
  });

  it('marks only the displayed replies seen when a later reply has arrived', async () => {
    const github = fakeGitHub();
    const conversation = thread();

    vi.mocked(github.snapshot).mockResolvedValue(snapshot({ threads: [conversation] }));

    const service = new SyncService(store(), github);

    await service.sync();
    const shown = service.detail('pr-1')!.item.unreadReplyKeys;

    conversation.comments.push({ ...conversation.comments[1], id: 'newer-reply' });
    await service.sync();
    service.update('pr-1', { account: 'me', seenReplyKeys: shown });

    expect(service.detail('pr-1')!.item.unreadReplyKeys).toHaveLength(1);
  });

  it('permanently wakes a snoozed PR on new activity, even after that activity is reviewed', async () => {
    const github = fakeGitHub();
    const service = new SyncService(store(), github);

    await service.sync();
    service.update('pr-1', {
      account: 'me',
      snoozeUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect(service.list().items[0].queue).toBe('snoozed');

    vi.mocked(github.snapshot).mockResolvedValue(snapshot({ headOid: 'new-head' }));
    await service.sync();

    expect(service.list().items[0].queue).toBe('attention');
    expect(service.detail('pr-1')?.triage.snoozedUntil).toBeNull();

    vi.mocked(github.snapshot).mockResolvedValue(snapshot());
    await service.sync();

    expect(service.list().items[0].queue).toBe('caught_up');
  });
});

describe('done until new activity', () => {
  it('marks a PR done, then permanently wakes it on new activity', async () => {
    const github = fakeGitHub();
    const service = new SyncService(store(), github);

    vi.mocked(github.snapshot).mockResolvedValue(snapshot({ headOid: 'head-2' }));
    await service.sync();
    expect(service.list().items[0].queue).toBe('attention');

    service.update('pr-1', { account: 'me', done: true });
    expect(service.list().items[0].queue).toBe('caught_up');
    expect(service.list().items[0].doneAt).not.toBeNull();

    vi.mocked(github.snapshot).mockResolvedValue(snapshot({ headOid: 'head-3' }));
    await service.sync();
    expect(service.list().items[0].queue).toBe('attention');
    expect(service.detail('pr-1')?.triage.doneAt).toBeNull();
  });
});

describe('local API', () => {
  it('allows local reads, validates updates, and blocks cross-origin or stale writes', async () => {
    const service = new SyncService(store(), fakeGitHub());

    await service.sync();

    const app = await createApp(service, { sessionToken: 'test-session-token' });
    const headers = {
      host: '127.0.0.1:4317',
      'content-type': 'application/json',
      'x-review-desk': '1',
      'x-review-desk-session': 'test-session-token',
    };
    const read = await app.inject({ method: 'GET', url: '/api/pulls', headers });

    expect(read.statusCode).toBe(200);
    expect(read.json().items).toHaveLength(1);
    expect(
      (await app.inject({ method: 'GET', url: '/api/pulls', headers: { host: 'evil.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/pulls/pr-1/triage',
          headers: { ...headers, origin: 'https://evil.example' },
          payload: { account: 'me', note: 'bad' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/pulls/pr-1/triage',
          headers: { host: '127.0.0.1:4317' },
          payload: { account: 'me' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/pulls/pr-1/triage',
          headers,
          payload: { account: 'me', unexpected: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/pulls/pr-1/triage',
          headers,
          payload: { account: 'old-account', note: 'bad' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/pulls/pr-1/triage',
          headers,
          payload: { account: 'me', note: 'Saved safely' },
        })
      ).json().triage.note,
    ).toBe('Saved safely');

    await app.close();
  });
});
