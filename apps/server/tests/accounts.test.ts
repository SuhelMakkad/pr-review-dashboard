import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAction } from '@review-desk/shared/operations';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { GhCredentials, GitHubError, safeError } from '@/github/index.js';
import { OperationQueue } from '@/operations/queue.js';
import { SyncService } from '@/sync/service.js';
import { SELECTED_ACCOUNT } from '@/db/settings.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const tokens: Record<string, string> = {
  'work-me': 'work-token-0123456789',
  'home-me': 'home-token-0123456789',
};

/**
 * Answers `gh auth status`, `gh auth token` and `gh api user` the way the GitHub CLI does; the
 * last as the token in the environment, `ambient` (null when the check fails).
 */
function fakeGh(ambient: () => string | null = () => null) {
  return vi.fn(async (args: string[], _env?: NodeJS.ProcessEnv) => {
    if (args[0] === 'api') {
      const login = ambient();

      return login
        ? { code: 0, stdout: `${login}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' };
    }

    if (args[1] === 'status') {
      // One sign-in failed verification, so gh exits non-zero but still prints every account.
      return {
        code: 1,
        stderr: '',
        stdout: JSON.stringify({
          hosts: {
            'github.com': [
              { state: 'error', active: true, login: '', tokenSource: 'GH_TOKEN' },
              { state: 'success', active: false, login: 'work-me', tokenSource: 'keyring' },
              { state: 'error', active: false, login: 'home-me', tokenSource: 'keyring' },
            ],
          },
        }),
      };
    }

    const user = args[args.indexOf('--user') + 1];

    return tokens[user]
      ? { code: 0, stdout: `${tokens[user]}\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: `no oauth token found for github.com account ${user}` };
  });
}

function demo() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());

  return { store, fixture, service };
}

describe('GitHub CLI accounts', () => {
  it('lists stored sign-ins and skips tokens that come from the environment', async () => {
    const credentials = new GhCredentials(fakeGh());

    expect(await credentials.list()).toEqual([
      { login: 'work-me', forge: 'github', host: 'github.com', cliActive: false, ok: true },
      { login: 'home-me', forge: 'github', host: 'github.com', cliActive: false, ok: false },
    ]);
  });

  it("follows the GitHub CLI until an account is picked or named, then sends that account's token", async () => {
    const run = fakeGh();
    const credentials = new GhCredentials(run);
    const tokenReads = () => run.mock.calls.filter(([args]) => args[1] === 'token').length;

    vi.stubEnv('GITHUB_TOKEN', 'environment-token-0123');
    vi.stubEnv('GH_DEBUG', 'api');

    const unpinned = await credentials.environment();

    expect(unpinned.GH_TOKEN).toBeUndefined();
    expect(unpinned.GITHUB_TOKEN).toBe('environment-token-0123');
    expect(unpinned.GH_DEBUG).toBeUndefined();
    expect(run).not.toHaveBeenCalled();

    // Work that names an account gets its token, even before anything is picked in the app.
    expect((await credentials.bind('home-me').environment()).GH_TOKEN).toBe(tokens['home-me']);

    credentials.select('work-me');

    const pinned = await credentials.environment();

    expect(pinned.GH_TOKEN).toBe(tokens['work-me']);
    expect(pinned.GITHUB_TOKEN).toBeUndefined();

    // Work that belongs to another account keeps that account's token.
    expect((await credentials.bind('home-me').environment()).GH_TOKEN).toBe(tokens['home-me']);

    await credentials.environment();
    expect(tokenReads()).toBe(2);

    credentials.forget();
    await credentials.environment();
    expect(tokenReads()).toBe(3);
  });

  it("uses a token from the environment only for its own login, never for a picked sign-in's", async () => {
    let ambient: string | null = 'work-me';
    const run = fakeGh(() => ambient);
    const credentials = new GhCredentials(run);
    const probes = () => run.mock.calls.filter(([args]) => args[0] === 'api').length;

    vi.stubEnv('GH_TOKEN', 'environment-token-0123');

    // The environment's token is work-me's, verified once with GitHub.
    const own = await credentials.bind('work-me').environment();

    expect(own.GH_TOKEN).toBe('environment-token-0123');
    expect(run.mock.calls.find(([args]) => args[0] === 'api')?.[0]).toEqual([
      'api',
      'user',
      '--hostname',
      'github.com',
      '--jq',
      '.login',
    ]);

    // Picked in the app, work-me keeps its stored sign-in's token: the two can differ in access.
    credentials.select('work-me');
    expect((await credentials.environment()).GH_TOKEN).toBe(tokens['work-me']);

    // Another account never gets the environment's token, and its own is read without it.
    expect((await credentials.bind('home-me').environment()).GH_TOKEN).toBe(tokens['home-me']);

    const read = run.mock.calls.find(([args]) => args.includes('home-me'));

    expect(read?.[1]?.GH_TOKEN).toBeUndefined();
    expect(read?.[1]?.GITHUB_TOKEN).toBeUndefined();

    // A check that fails counts as unknown, never blocks a named account, and is tried again.
    ambient = null;
    vi.stubEnv('GH_TOKEN', 'another-environment-token');
    credentials.forget();
    credentials.select(null);

    expect((await credentials.bind('home-me').environment()).GH_TOKEN).toBe(tokens['home-me']);

    const before = probes();

    ambient = 'home-me';
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await credentials.bind('home-me').environment()).GH_TOKEN).toBe(
      'another-environment-token',
    );
    expect(probes()).toBe(before + 1);
  });

  it('sends exactly the verified token from the environment, and never takes an Enterprise one for github.com', async () => {
    const run = fakeGh(() => 'work-me');
    const credentials = new GhCredentials(run);

    // Only an Enterprise token: it is for another host, so nothing is probed and the account's own
    // stored sign-in is used. (github.com's own variables cleared, as on any machine.)
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'enterprise-token-0123');

    expect((await credentials.bind('work-me').environment()).GH_TOKEN).toBe(tokens['work-me']);
    expect(run.mock.calls.some(([args]) => args[0] === 'api')).toBe(false);

    // GITHUB_TOKEN verified as work-me's: that very token goes out, as GH_TOKEN, and nothing else.
    vi.stubEnv('GITHUB_TOKEN', 'environment-token-0123');

    const env = await credentials.bind('work-me').environment();
    const probe = run.mock.calls.find(([args]) => args[0] === 'api')?.[1];

    expect(env.GH_TOKEN).toBe('environment-token-0123');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(probe?.GH_TOKEN).toBe('environment-token-0123');
    expect(probe?.GH_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it('explains a missing sign-in and keeps tokens out of error messages', async () => {
    const credentials = new GhCredentials(fakeGh());

    credentials.select('gone-user');

    const error = await credentials.environment().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({
      outcome: 'auth',
      message: expect.stringContaining('gone-user is not signed in to the GitHub CLI'),
    });

    credentials.select('work-me');
    await credentials.environment();

    expect(safeError(new Error(`Request failed with ${tokens['work-me']}`))).toBe(
      'Request failed with [redacted]',
    );
  });
});

describe('switching accounts', () => {
  it("switches without touching either account's data and remembers the choice", async () => {
    const { store, service } = demo();

    await service.sync();

    const id = service.list().items[0].id;

    service.update(id, { account: 'you', note: 'Private to you' });

    const status = await service.switchAccount('you', DEMO_SECOND_ACCOUNT);

    expect(status.account?.login).toBe(DEMO_SECOND_ACCOUNT);
    expect(status.lastSuccessfulSync).toBeNull();

    // The switch starts the new account's first sync by itself.
    await vi.waitFor(() => expect(service.status.lastSuccessfulSync).not.toBeNull());

    expect(service.status.account?.login).toBe(DEMO_SECOND_ACCOUNT);
    expect(service.list().items).toEqual([]);

    // A restart keeps working as the account picked in the app.
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const restarted = new SyncService(store, fixture, new EventBus(), fixture);

    expect(restarted.status.account?.login).toBe(DEMO_SECOND_ACCOUNT);
    expect((await fixture.identity()).login).toBe(DEMO_SECOND_ACCOUNT);

    // Switching back shows the saved queue straight away, before the sync finishes.
    await service.switchAccount(DEMO_SECOND_ACCOUNT, 'you');

    expect(service.detail(id)?.triage.note).toBe('Private to you');
  });

  it('refuses accounts the GitHub CLI cannot use and requests from a stale window', async () => {
    const { store, fixture, service } = demo();

    await service.sync();

    await expect(service.switchAccount('you', 'nobody')).rejects.toMatchObject({
      code: 'NOT_SIGNED_IN',
    });
    await expect(service.switchAccount('someone-else', DEMO_SECOND_ACCOUNT)).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    });

    vi.spyOn(fixture, 'list').mockResolvedValue([
      { login: 'you', forge: 'github', host: 'github.com', cliActive: true, ok: true },
      {
        login: DEMO_SECOND_ACCOUNT,
        forge: 'github',
        host: 'github.com',
        cliActive: false,
        ok: false,
      },
    ]);

    await expect(service.switchAccount('you', DEMO_SECOND_ACCOUNT)).rejects.toMatchObject({
      code: 'SIGN_IN_FAILED',
    });
    expect(service.status.account?.login).toBe('you');
    expect(store.settings.get(SELECTED_ACCOUNT)).toBeNull();

    const fixed = new SyncService(store, fixture, new EventBus());

    await expect(fixed.switchAccount('you', DEMO_SECOND_ACCOUNT)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('lets a sync in progress finish as the previous account first', async () => {
    const { fixture, service } = demo();
    const discover = fixture.discover.bind(fixture);
    let release: (() => void) | undefined;

    vi.spyOn(fixture, 'discover').mockImplementation(async (login, source) => {
      if (source === 'requested' && !release)
        await new Promise<void>((resolve) => (release = resolve));

      return discover(login, source);
    });

    const syncing = service.sync();

    await vi.waitFor(() => expect(release).toBeDefined());

    const switching = service.switchAccount('you', DEMO_SECOND_ACCOUNT);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.status.account?.login).toBe('you');

    release!();
    await syncing;
    await switching;

    expect(service.status.account?.login).toBe(DEMO_SECOND_ACCOUNT);
    expect(service.store.snapshots('you').length).toBeGreaterThan(0);
  });
});

describe('GitHub actions across a switch', () => {
  it('finishes the action being sent, then holds the rest until you switch back', async () => {
    const { fixture, service } = demo();

    await service.sync();

    const queue = new OperationQueue(service, { mutationIntervalMs: 0, retryDelaysMs: [1] });
    queue.open();

    cleanups.push(() => queue.close());
    await queue.pause();

    const [first, second] = service.list().items;
    const approve = (prId: string): GitHubAction => {
      const pull = service.detail(prId)!.snapshot;

      return {
        type: 'review',
        review: {
          account: 'you',
          body: 'Looks good.',
          event: 'APPROVE',
          expectedHeadOid: pull.headOid,
        },
        draft: {
          body: 'Looks good.',
          event: 'APPROVE',
          comments: [],
          githubReviewId: pull.pendingReview?.id ?? null,
        },
      };
    };
    const sending = queue.enqueue('you', first.id, randomUUID(), approve(first.id)).operation;

    fixture.writeDelayMs = 100;
    queue.resume();
    await vi.waitFor(() => expect(queue.get('you', sending.id).status).toBe('running'));

    const release = await queue.hold();

    expect(queue.get('you', sending.id).status).toBe('succeeded');

    const waiting = queue.enqueue('you', second.id, randomUUID(), approve(second.id)).operation;

    await service.switchAccount('you', DEMO_SECOND_ACCOUNT);
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Queued as the previous account, so it waits rather than posting as the new one.
    expect(queue.inProgress('you')).toBe(1);
    expect(fixture.writes.filter((write) => write.op === 'SubmitReview')).toHaveLength(1);

    await service.switchAccount(DEMO_SECOND_ACCOUNT, 'you');
    queue.wake();
    await vi.waitFor(() => expect(queue.get('you', waiting.id).status).toBe('succeeded'), {
      timeout: 2500,
    });
  });
});

describe('account routes', () => {
  it('lists accounts and switches only from this window', async () => {
    const { service } = demo();

    await service.sync();

    const app = await createApp(service, { sessionToken: 'test-session-token' });

    cleanups.push(() => app.close());

    const headers = {
      host: '127.0.0.1:4317',
      'content-type': 'application/json',
      'x-review-desk': '1',
      'x-review-desk-session': 'test-session-token',
    };
    const list = await app.inject({ method: 'GET', url: '/api/accounts', headers });

    expect(list.json()).toEqual({
      switchable: true,
      accounts: [
        {
          login: 'you',
          forge: 'github',
          host: 'github.com',
          current: true,
          cliActive: true,
          ok: true,
          inProgress: 0,
        },
        {
          login: DEMO_SECOND_ACCOUNT,
          forge: 'github',
          host: 'github.com',
          current: false,
          cliActive: false,
          ok: true,
          inProgress: 0,
        },
      ],
    });

    // Diffs carry the account whose viewed state they show, so the browser can tell them apart.
    const pull = service.list().items[0];
    const diff = await app.inject({
      method: 'GET',
      url: `/api/accounts/you/pulls/${pull.id}/diff?mode=full`,
      headers,
    });

    expect(diff.json()).toMatchObject({ prId: pull.id, account: 'you' });

    const post = (payload: object, extra: Record<string, string> = headers) =>
      app.inject({ method: 'POST', url: '/api/accounts/switch', headers: extra, payload });

    expect(
      (
        await post(
          { from: 'you', to: DEMO_SECOND_ACCOUNT },
          { ...headers, 'x-review-desk-session': 'wrong' },
        )
      ).statusCode,
    ).toBe(401);
    expect((await post({ to: DEMO_SECOND_ACCOUNT })).statusCode).toBe(400);
    expect((await post({ from: 'stale', to: DEMO_SECOND_ACCOUNT })).json()).toMatchObject({
      code: 'ACCOUNT_CHANGED',
    });

    const switched = await post({ from: 'you', to: DEMO_SECOND_ACCOUNT });

    expect(switched.statusCode).toBe(200);
    expect(switched.json().account.login).toBe(DEMO_SECOND_ACCOUNT);
  });
});
