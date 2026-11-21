import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiRun } from '@review-desk/shared/ai';
import type { ServerEvent } from '@review-desk/shared/events';
import { FixtureProvider } from '@/ai/fixture.js';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { AccountUnavailable } from '@/forge/account.js';
import { GitHubError } from '@/github/errors.js';
import { historyImporter } from './history-importer.js';
import { extractActivity } from '@/insights/extract.js';
import { activityEvents } from '@/db/schema.js';
import { AiRunner } from '@/ai/runner.js';
import { DraftStore } from '@/db/drafts.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/service.js';
import { BACKFILL } from '@/db/settings.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

const headers = {
  host: '127.0.0.1:4317',
  'x-review-desk': '1',
  'x-review-desk-session': 'test-session',
};

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** The demo app synced as `you`, with demo agents; `away()` switches to the second account. */
async function demo(delayMs = 5) {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);
  const events: ServerEvent[] = [];
  const root = mkdtempSync(join(tmpdir(), 'review-desk-account-ai-'));
  const providers = { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') };

  providers.codex.delayMs = delayMs;
  providers.claude.delayMs = delayMs;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();
  service.events.subscribe((stored) => void events.push(stored.event));

  const app = await createApp(service, {
    sessionToken: 'test-session',
    fixture,
    bootId: 'boot',
    aiProviders: providers,
    aiWorkRoot: root,
  });

  cleanups.push(() => app.close());

  const pr = service.listFor('you').items.find((item) => item.number === 1839)!;
  const call = (method: Method, url: string, payload?: unknown) =>
    method === 'GET'
      ? app.inject({ method, url, headers })
      : app.inject({
          method,
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: (payload ?? {}) as never,
        });
  const runs = async (account = 'you') =>
    (await call('GET', `/api/accounts/${account}/pulls/${pr.id}/ai`)).json().runs as AiRun[];
  const finished = async (id: string) => {
    await vi.waitFor(
      async () => {
        const run = (await runs()).find((candidate) => candidate.id === id);

        expect(run?.status).toMatch(/done|failed/);
      },
      { timeout: 5_000 },
    );

    return (await runs()).find((candidate) => candidate.id === id)!;
  };
  const start = async (task: string) =>
    (await call('POST', `/api/accounts/you/pulls/${pr.id}/ai`, { task, provider: 'codex' })).json()
      .id as string;
  const away = () => service.switchAccount('you', DEMO_SECOND_ACCOUNT);

  return { store, fixture, service, events, providers, pr, call, runs, finished, start, away };
}

describe('AI and Insights for an account not in use', () => {
  it('are read for the account in the path, and new AI work is refused for it', async () => {
    const { pr, call, runs, finished, start, away } = await demo();
    // One run of each task its commands take: those of another task are not found first.
    const done = await finished(await start('brief'));
    const suggested = await finished(await start('draft_comments'));
    const reviewed = await finished(await start('full_review'));
    const summarised = await finished(await start('draft_summary'));

    await away();

    expect(await runs()).toContainEqual(expect.objectContaining({ id: done.id }));
    expect((await call('GET', '/api/accounts/you/ai/reviews')).statusCode).toBe(200);
    expect((await call('GET', '/api/accounts/you/insights')).json()).toMatchObject({
      backfill: { running: false },
    });

    const refusals: [string, object][] = [
      [`/pulls/${pr.id}/ai`, { task: 'brief' }],
      [`/ai/runs/${done.id}/resume`, {}],
      [`/ai/runs/${suggested.id}/accept`, { index: 0 }],
      [`/ai/runs/${reviewed.id}/draft`, { indices: [0] }],
      [`/ai/runs/${summarised.id}/summary`, {}],
      ['/insights/backfill', {}],
    ];

    for (const [path, payload] of refusals) {
      const response = await call('POST', `/api/accounts/you${path}`, payload);

      expect({ path, status: response.statusCode, body: response.json() }).toMatchObject({
        path,
        status: 409,
        body: { code: 'ACCOUNT_NOT_ACTIVE', account: 'you', selected: DEMO_SECOND_ACCOUNT },
      });
    }

    expect(await runs()).toHaveLength(4);
  });

  it("stops another account's run, and serves a run only through its own account's path", async () => {
    const { call, runs, start, away } = await demo(10_000);
    const id = await start('brief');

    await away();

    const elsewhere = await call(
      'POST',
      `/api/accounts/${DEMO_SECOND_ACCOUNT}/ai/runs/${id}/pause`,
    );

    expect(elsewhere.statusCode).toBe(404);

    const paused = await call('POST', `/api/accounts/you/ai/runs/${id}/pause`);

    expect(paused.statusCode).toBe(200);
    expect((await runs()).find((run) => run.id === id)?.status).toBe('paused');
    expect((await call('DELETE', `/api/accounts/you/ai/runs/${id}`)).statusCode).toBe(200);
    expect((await runs()).find((run) => run.id === id)?.status).toBe('cancelled');
  });

  it('reports nothing reached after a switch: a cached run, a prepared draft, a resume', async () => {
    const { service, pr, call, runs, finished, start } = await demo();
    const brief = await finished(await start('brief'));
    const review = await finished(await start('full_review'));

    expect(
      (await call('POST', `/api/accounts/you/ai/runs/${review.id}/draft`, { indices: [0] }))
        .statusCode,
    ).toBe(200);

    /** Holds `method` once, switches while it is held, then lets it go. */
    const acrossSwitch = async <T>(target: object, method: string, send: () => Promise<T>) => {
      let release: (() => void) | null = null;
      const original = (target as Record<string, (...args: unknown[]) => unknown>)[method];
      const spy = vi
        .spyOn(target as Record<string, (...args: unknown[]) => unknown>, method)
        .mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
          return new Promise((resolve) => {
            release = () => resolve(original.apply(this, args));
          });
        });
      const sent = send();

      await vi.waitFor(() => expect(release).not.toBeNull());
      await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
      release!();

      const answer = await sent;

      spy.mockRestore();
      await service.switchAccount(DEMO_SECOND_ACCOUNT, 'you');

      return answer;
    };

    // The same brief again would be answered from the run already made, after its input is built.
    const cached = await acrossSwitch(AiRunner.prototype as unknown as object, 'buildInput', () =>
      call('POST', `/api/accounts/you/pulls/${pr.id}/ai`, { task: 'brief' }),
    );

    expect(cached.json()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });

    // The same preparation again would return the draft already prepared, after a refresh.
    const prepared = await acrossSwitch(service, 'refresh', () =>
      call('POST', `/api/accounts/you/ai/runs/${review.id}/draft`, { indices: [0] }),
    );

    expect(prepared.json()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect((await runs()).filter((run) => run.task === 'brief')).toEqual([
      expect.objectContaining({ id: brief.id }),
    ]);
  });

  it('never queues a resume for an account switched away from while it waited', async () => {
    const { service, call, runs, start } = await demo(10_000);
    const id = await start('brief');

    await call('POST', `/api/accounts/you/ai/runs/${id}/pause`);

    let release: (() => void) | null = null;

    vi.spyOn(service, 'refresh').mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(null))),
    );

    const resumed = call('POST', `/api/accounts/you/ai/runs/${id}/resume`);

    await vi.waitFor(() => expect(release).not.toBeNull());
    await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
    release!();

    expect((await resumed).json()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect((await runs()).find((run) => run.id === id)?.status).toBe('paused');
  });

  it('checks the account in the turn the resume goes on in, not just as its last wait ends', async () => {
    const { service, call, runs, start } = await demo(10_000);
    const id = await start('brief');

    await call('POST', `/api/accounts/you/ai/runs/${id}/pause`);

    // The plan check is the resume's last wait before it queues the run.
    const original = AiRunner.prototype.codexStatus;
    let release: (() => void) | null = null;
    let read: Promise<unknown> | null = null;

    vi.spyOn(AiRunner.prototype, 'codexStatus').mockImplementationOnce(function (this: AiRunner) {
      read = new Promise((resolve) => (release = () => resolve(original.call(this))));

      return read as ReturnType<typeof original>;
    });

    const resumed = call('POST', `/api/accounts/you/ai/runs/${id}/resume`);

    await vi.waitFor(() => expect(release).not.toBeNull());

    // The account changes in the turn after the check settles: after anything that waited on the
    // check itself, before the resume goes on.
    const status = service.status;

    void read!.then(() => {
      service.status = { ...status, account: { ...status.account!, login: DEMO_SECOND_ACCOUNT } };
    });
    release!();

    expect((await resumed).json()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    service.status = status;
    expect((await runs()).find((run) => run.id === id)?.status).toBe('paused');
  });

  it('refuses a suggestion made for an older head, however late the head moved', async () => {
    const { fixture, service, store, pr, call, finished, start } = await demo();
    const run = await finished(await start('draft_comments'));
    const drafts = new DraftStore(store);
    const move = async (head: string) => {
      fixture.scenario.world.pulls.find((pull) => pull.snapshot.id === pr.id)!.snapshot.headOid =
        head;
      await service.refresh(pr.id, 'you');
    };
    const accept = () => call('POST', `/api/accounts/you/ai/runs/${run.id}/accept`, { index: 0 });

    // The head moves while the comment's diff check is on its way.
    let release: (() => void) | null = null;
    const check = vi
      .spyOn(
        ReviewService.prototype as unknown as { assertCommentable: () => Promise<void> },
        'assertCommentable',
      )
      .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const late = accept();

    await vi.waitFor(() => expect(release).not.toBeNull());
    await move('e'.repeat(40));
    release!();
    expect((await late).json()).toMatchObject({ code: 'HEAD_MOVED' });
    expect(drafts.draft('you', pr.id)).toBeNull();
    check.mockRestore();

    // Already moved: refused before anything is checked.
    expect((await accept()).json()).toMatchObject({ code: 'HEAD_MOVED' });
    expect(drafts.draft('you', pr.id)).toBeNull();
  });

  it('reads Insights for the ranges offered, and the default for anything else', async () => {
    const { call } = await demo();
    const days = async (query: string) =>
      (await call('GET', `/api/accounts/you/insights${query}`)).json().insights.range.days;

    expect(await days('?days=7')).toBe(7);
    expect(await days('?days=90')).toBe(90);
    expect(await days('?days=45')).toBe(30);
    expect(await days('')).toBe(30);
  });

  it('names the account on AI events', async () => {
    const { events, finished, start } = await demo();

    await finished(await start('brief'));

    expect(events.filter((event) => event.type === 'ai.updated')).not.toEqual([]);
    expect(
      events.filter((event) => event.type === 'ai.updated' && event.account !== 'you'),
    ).toEqual([]);
  });
});

describe('history imports per account', () => {
  async function imports() {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const events = new EventBus();
    const service = new SyncService(store, fixture, events, fixture);
    const updates: (string | null)[] = [];

    cleanups.push(() => store.close());
    cleanups.push(() => service.stop());
    await service.sync();
    events.subscribe(({ event }) => {
      if (event.type === 'insights.updated') updates.push(event.account);
    });

    const importer = historyImporter(service);

    cleanups.push(importer.close);

    return { store, fixture, service, updates, ...importer };
  }

  it("runs each account's import on its own, and drains them all on close", async () => {
    const { fixture, service, backfill, clock, scheduler, row, updates } = await imports();
    const held = new Map<string, () => void>();
    // Once an account's reads are let go, the rest of its import reads at once.
    const free = new Set<string>();

    vi.spyOn(fixture, 'searchPullIds').mockImplementation(async (query) => {
      const login = query.login;

      if (!free.has(login))
        await new Promise<void>((resolve) =>
          held.set(login, () => {
            free.add(login);
            resolve();
          }),
        );

      return [];
    });

    backfill.request('you');

    // Shown as running at once, before it starts.
    expect(updates).toEqual(['you']);
    expect(backfill.state('you').running).toBe(true);

    clock.fire();
    await vi.waitFor(() => expect([...held.keys()]).toEqual(['you']));
    await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
    backfill.request(DEMO_SECOND_ACCOUNT);
    // One import for each account: the second starts beside the first.
    clock.fire();

    expect(backfill.state(DEMO_SECOND_ACCOUNT).running).toBe(true);
    await vi.waitFor(() => expect([...held.keys()].sort()).toEqual(['you', DEMO_SECOND_ACCOUNT]));

    const closed = scheduler.close();
    let done = false;

    void closed.then(() => (done = true));
    held.get('you')!();
    await vi.waitFor(() => expect(row('you')?.claimedBy ?? null).toBe(null));

    // Its window finished, it stopped, and the next start resumes it.
    expect(backfill.state('you').running).toBe(false);
    expect(backfill.state(DEMO_SECOND_ACCOUNT).running).toBe(true);
    expect(done).toBe(false);

    held.get(DEMO_SECOND_ACCOUNT)!();
    await closed;
    expect(backfill.state(DEMO_SECOND_ACCOUNT).running).toBe(false);
    expect(row('you')).toMatchObject({ claimedBy: null, attempts: 0 });
  });

  it('saves nothing from a window during which glab signed in as someone else', async () => {
    const { store, fixture, service, backfill, imported } = await imports();
    let signedIn = 'you';
    let reads = 0;
    const eventsOf = (id: string) =>
      store.activity('you').filter((event) => event.prId === id).length;
    // Two PRs whose history holds your activity: one read in each of the first two windows.
    const [first, second] = service
      .listFor('you')
      .items.map((item) => service.detailFor('you', item.id)!.snapshot)
      .filter((snapshot) => extractActivity(snapshot, 'you', []).length > 0);

    store.db.delete(activityEvents).run();

    // A forge that cannot carry the account with each call, as GitLab's.
    Object.assign(fixture, {
      traits: { ...fixture.traits, checksAccount: true },
      verifyAccount: async (login: string) => {
        if (signedIn !== login) throw new AccountUnavailable(login, signedIn);
      },
    });
    vi.spyOn(fixture, 'searchPullIds').mockImplementation(async () => {
      reads += 1;
      // The second window (an older, historical one) is read as someone else.
      if (reads === 3) signedIn = 'someone-else';

      return reads <= 2 ? [first.id] : [second.id];
    });

    await imported('you');

    const state = backfill.state('you');

    expect(state.lastError).toContain('someone-else');
    expect(state.doneWindows).toEqual([]);
    expect(eventsOf(first.id)).toBeGreaterThan(0);
    expect(eventsOf(second.id)).toBe(0);
  });

  it('never counts a window whose save rolled back as done', async () => {
    const { store, fixture, backfill, imported } = await imports();
    let windows = 0;

    vi.spyOn(fixture, 'searchPullIds').mockResolvedValue([]);

    const set = store.settings.set.bind(store.settings);

    // The second window's checkpoint fails as it is written, inside its transaction.
    vi.spyOn(store.settings, 'set').mockImplementation((setting, value) => {
      if (
        setting.key === 'backfill:you' &&
        (value as { lastError: string | null }).lastError === null
      )
        if (++windows === 2) throw new Error('Disk full');

      return set(setting, value);
    });

    await imported('you');

    const state = backfill.state('you');

    expect(state.lastError).toContain('Disk full');
    // Only the first window (the newest, never marked done) was saved: nothing counts as done.
    expect(state.doneWindows).toEqual([]);
  });

  it('keeps a confirmed limit as the cooldown, resumes after it, and keeps saved progress through a refused import', async () => {
    const { store, fixture, service, backfill, row, ran, imported } = await imports();
    const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const verifyAccount = vi.fn(async () => undefined);

    Object.assign(fixture, { verifyAccount, traits: { ...fixture.traits, checksAccount: true } });
    store.settings.set(BACKFILL.of('you'), {
      doneWindows: ['2026-08-07..2026-09-06'],
      finishedAt: null,
      lastError: null,
    });
    vi.spyOn(fixture, 'searchPullIds').mockRejectedValue(
      new GitHubError('Rate limited.', retryAt, 403, 'rate_limit'),
    );

    await imported('you', { force: true });

    expect(backfill.state('you').doneWindows).toEqual(['2026-08-07..2026-09-06']);
    expect(() => service.assertNotCoolingDown('you')).toThrow();
    // Resumed once the cooldown ends, the refresh still to finish.
    expect(row('you')).toMatchObject({ notBefore: service.cooldown('you'), attempts: 0 });
    expect(store.settings.get(BACKFILL.of('you'))?.force).toEqual(
      expect.objectContaining({ windows: [] }),
    );

    // An import that starts under the cooldown asks the forge nothing, not even who it is, and
    // loses nothing.
    vi.mocked(fixture.searchPullIds).mockClear();
    verifyAccount.mockClear();
    store.scheduledWork.delete({ kind: 'insights.backfill', key: 'you' });
    backfill.request('you');
    await ran('you');

    expect(fixture.searchPullIds).not.toHaveBeenCalled();
    expect(verifyAccount).not.toHaveBeenCalled();
    // Put off until the cooldown ends.
    expect(row('you')).toMatchObject({ notBefore: service.cooldown('you'), attempts: 0 });
    expect(backfill.state('you')).toMatchObject({
      doneWindows: ['2026-08-07..2026-09-06'],
      lastError: expect.stringContaining('rate limited'),
    });
  });
});
