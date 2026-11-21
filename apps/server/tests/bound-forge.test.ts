import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveAccess, prepareReviewWorkspace, type RepositoryExporter } from '@/ai/workspace.js';
import { githubOperations } from '@/db/schema.js';
import { initialStatus, STATUS, WRITE_COOLDOWN } from '@/db/settings.js';
import { DraftStore } from '@/db/drafts.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import type { DiffManifest } from '@review-desk/shared/diff';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { AccountUnavailable } from '@/forge/account.js';
import { BoundForge, ForgeRouter } from '@/forge/router.js';
import type { GitHubApi } from '@/github/api.js';
import { GhCredentials } from '@/github/credentials.js';
import { GitHubError } from '@/github/errors.js';
import { OperationQueue } from '@/operations/queue.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/service.js';
import { snapshot } from '@test/fixtures.js';

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
 * Answers `gh auth token --user` from `tokens`, `gh auth token` with the token of `active()`, and
 * `gh api user` as the login of the token in its environment.
 */
function fakeGh(active: () => string = () => 'work-me', ambient: string | null = null) {
  return vi.fn(async (args: string[], _env?: NodeJS.ProcessEnv) => {
    if (args[0] === 'api')
      return ambient
        ? { code: 0, stdout: `${ambient}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'HTTP 401' };

    const user = args.includes('--user') ? args[args.indexOf('--user') + 1] : active();

    return tokens[user]
      ? { code: 0, stdout: `${tokens[user]}\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: `no oauth token found for ${user}` };
  });
}

describe('bound GitHub credentials', () => {
  it('keep the token chosen when bound through a switch, and read nothing until a call needs one', async () => {
    const run = fakeGh(() => 'work-me', 'work-me');
    const credentials = new GhCredentials(run);
    const reads = () => run.mock.calls.filter(([args]) => args[1] === 'token').length;

    // The environment's token is work-me's too, but a selected sign-in keeps its stored token.
    vi.stubEnv('GH_TOKEN', 'environment-token-0123');
    credentials.select('work-me');

    const bound = credentials.bind('work-me');

    // Receipt-only recovery reads nothing: no token, no check of the environment's.
    expect(run).not.toHaveBeenCalled();

    credentials.select('home-me');

    expect((await bound.environment()).GH_TOKEN).toBe(tokens['work-me']);
    // Bound after the switch, work-me is no longer selected and takes its verified environment token.
    expect((await credentials.bind('work-me').environment()).GH_TOKEN).toBe(
      'environment-token-0123',
    );

    // After GitHub rejects it, a stored token is read again, for that account only.
    const before = reads();

    await bound.environment();
    expect(reads()).toBe(before);

    bound.forget();
    await bound.environment();
    expect(reads()).toBe(before + 1);
  });

  it('keep the stored sign-in once a binding has used it, while a new binding checks again', async () => {
    let ambient: string | null = null;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'api')
        return ambient
          ? { code: 0, stdout: `${ambient}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'HTTP 502' };

      return { code: 0, stdout: `${tokens['home-me']}\n`, stderr: '' };
    });
    const credentials = new GhCredentials(run);

    vi.stubEnv('GH_TOKEN', 'environment-token-0123');

    const bound = credentials.bind('home-me');

    // The check of the environment's token goes unanswered: the stored sign-in is used.
    expect((await bound.environment()).GH_TOKEN).toBe(tokens['home-me']);

    // Answerable now, and the token is home-me's, but this binding's access does not change.
    ambient = 'home-me';
    credentials.forget();
    expect((await bound.environment()).GH_TOKEN).toBe(tokens['home-me']);
    expect((await credentials.bind('home-me').environment()).GH_TOKEN).toBe(
      'environment-token-0123',
    );
  });

  it('pin the token gh uses now, so its active account can switch without changing the work', async () => {
    let active = 'work-me';
    const credentials = new GhCredentials(fakeGh(() => active));

    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');

    const pinned = (await credentials.pin())!;

    active = 'home-me';
    pinned.forget();

    expect((await pinned.environment()).GH_TOKEN).toBe(tokens['work-me']);

    // The environment's token, when there is one, is what gh would use: it is pinned instead.
    vi.stubEnv('GH_TOKEN', 'environment-token-0123');
    expect((await (await credentials.pin())!.environment()).GH_TOKEN).toBe(
      'environment-token-0123',
    );

    // No sign-in and no token: nothing to pin.
    vi.stubEnv('GH_TOKEN', '');
    active = 'nobody';
    expect(await credentials.pin()).toBeNull();
  });
});

describe('archive access', () => {
  it("shares a bound forge's own GitHub credentials, and binds anew only without them", () => {
    const credentials = { environment: vi.fn(), forget: vi.fn() };
    const router = new ForgeRouter(
      {} as GitHubApi,
      { list: async () => [], select: () => undefined },
      { list: async () => [] },
      () => ({}) as GitHubApi,
    );
    const forge = new BoundForge('you', {} as GitHubApi, router, credentials);

    expect(archiveAccess('you', forge)).toEqual({ account: 'you', credentials });
    // A stand-in carries none: the run's account gets credentials of its own.
    expect(archiveAccess('you', {} as GitHubApi).credentials).not.toBe(credentials);
    expect(archiveAccess('ann@gitlab.example', forge)).toEqual({
      account: 'ann@gitlab.example',
      credentials: null,
    });
  });
});

describe('the router', () => {
  /** A client that answers `identity` as `login`, and names itself in `teams`. */
  const client = (login: string, failing = false) =>
    ({
      identity: vi.fn(async () => {
        if (failing) throw new GitHubError('Not signed in', null, 401, 'auth');

        return { login };
      }),
      teams: vi.fn(async () => [`${login}/team`]),
    }) as unknown as GitHubApi;

  function router({ stored = true, token = true, pin = true } = {}) {
    const gh = {
      list: vi.fn(async () =>
        stored
          ? [
              {
                login: 'octo',
                forge: 'github' as const,
                host: 'github.com',
                cliActive: true,
                ok: true,
              },
            ]
          : [],
      ),
      select: vi.fn(),
    };
    const glab = {
      list: vi.fn(async () => [
        {
          login: 'rev@gitlab.example',
          forge: 'gitlab' as const,
          host: 'gitlab.example',
          cliActive: true,
          ok: true,
        },
      ]),
    };
    const signedIn = stored || token;
    const forges = new ForgeRouter(
      client('selected', !signedIn),
      gh,
      glab,
      (host) => client(`rev@${host}`),
      {
        // Tagged, so a test can tell a client bound by name from the others.
        bound: (login) => ({ client: client(`bound-${login}`), credentials: null }),
        pinned: async () =>
          signedIn && pin
            ? { client: client(stored ? 'octo' : 'env-only'), credentials: null }
            : null,
      },
    );

    return forges;
  }

  it('discovers whose the credentials are with nothing selected, and keeps them after a selection', async () => {
    const forges = router();
    const { identity, forge } = await forges.discoverIdentity();

    expect(identity.login).toBe('octo');

    forges.select('someone-else');

    expect(await forge.teams()).toEqual(['octo/team']);
  });

  it('binds to the login it found by name when there was nothing to pin', async () => {
    // Signed in just as the sync started: no token could be pinned, yet the CLI now answers.
    const { identity, forge } = await router({ pin: false }).discoverIdentity();

    expect(identity.login).toBe('selected');
    expect(await forge.teams()).toEqual(['bound-selected/team']);
  });

  it('works as an environment-only login with no stored sign-in', async () => {
    const { identity, forge } = await router({ stored: false }).discoverIdentity();

    expect(identity.login).toBe('env-only');
    expect(await forge.teams()).toEqual(['env-only/team']);
  });

  it('falls back to the first GitLab account when GitHub has no sign-in at all', async () => {
    const { identity, forge } = await router({ stored: false, token: false }).discoverIdentity();

    expect(identity.login).toBe('rev@gitlab.example');
    expect(await forge.teams()).toEqual(['rev@gitlab.example/team']);
  });
});

describe('work bound to an account', () => {
  it("reads through the caller's own binding when it passes one, never binding again", async () => {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const sync = new SyncService(store, fixture, new EventBus());

    cleanups.push(() => store.close());
    await sync.sync();

    const pull = sync.detail(sync.list().items[0].id)!.snapshot;
    const listing = await fixture.pullFiles(pull.repository, pull.number);
    // A client of its own, apart from the fixture, so a read through either is told apart.
    const supplied = {
      snapshot: vi.fn(async () => pull),
      pullFiles: vi.fn(async () => listing),
    } as unknown as GitHubApi;
    const as = vi.spyOn(fixture, 'as');
    const snapshot = vi.spyOn(fixture, 'snapshot');
    const files = vi.spyOn(fixture, 'pullFiles');

    await sync.refresh(pull.id, 'you', supplied);
    await new DiffService(fixture).manifest(pull, 'full', null, 'you', supplied);

    expect(supplied.snapshot).toHaveBeenCalled();
    expect(supplied.pullFiles).toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
    expect(as).not.toHaveBeenCalled();
  });

  it("keeps a rate limit met by a receipt's account check out of the account's cooldown", async () => {
    const store = new Store(':memory:');
    const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const sync = new SyncService(store, github, new EventBus());

    cleanups.push(() => store.close());
    await sync.sync();

    const queue = new OperationQueue(sync, { mutationIntervalMs: 0, retryDelaysMs: [60_000] });

    cleanups.push(() => queue.close());
    queue.open();
    await queue.pause();

    const pull = sync.detail(sync.list().items[0].id)!.snapshot;

    new DraftStore(store).saveMeta('you', pull.id, { body: 'Pending', githubReviewId: 'PRR_x' });

    const { operation } = queue.enqueue(
      'you',
      pull.id,
      randomUUID(),
      { type: 'discard', reviewId: 'PRR_x' },
      { account: 'you', operationId: 'discard' },
    );

    let checks = 0;

    // The preflight refresh's two checks pass. The receipt's own check is then rate limited: it
    // may have run as anyone, so it is nobody's limit.
    Object.assign(github, {
      verifyAccount: vi.fn(async () => {
        if (++checks < 3) return;

        throw new GitHubError(
          'Rate limited.',
          new Date(Date.now() + 60 * 60_000).toISOString(),
          429,
          'rate_limit',
        );
      }),
    });
    queue.resume();

    // The receipt's own check ran and met the limit: the discard waits to retry, as nobody's limit.
    await vi.waitFor(() => expect(queue.get('you', operation.id).status).toBe('waiting'));
    expect(checks).toBe(3);
    expect(store.settings.get(WRITE_COOLDOWN.of('you'))).toBeNull();
    expect(sync.status.retryAt).toBeNull();
  });

  it("checks a verdict against the named account's own forge, not the one in use", () => {
    const store = new Store(':memory:');
    const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const sync = new SyncService(store, github, new EventBus());
    const reviews = new ReviewService(sync, github, new DiffService(github), sync.events);
    const gitlab = (login: string, capabilities?: { requestChanges: boolean }) =>
      store.settings.set(STATUS.of(login), {
        ...initialStatus(),
        account: { login },
        ...(capabilities ? { capabilities } : {}),
      });

    cleanups.push(() => store.close());
    // GitHub in use, which records every verdict: its status says nothing about GitLab's.
    sync.status = { ...initialStatus(), account: { login: 'you' } };
    gitlab('ann@gitlab.example', { requestChanges: true });
    gitlab('bob@gitlab.example');

    expect(() =>
      reviews.assertVerdictSupported('ann@gitlab.example', 'REQUEST_CHANGES'),
    ).not.toThrow();
    expect(() => reviews.assertVerdictSupported('bob@gitlab.example', 'REQUEST_CHANGES')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED' }),
    );
  });

  it('keeps a sync its own account when the selection changes while it runs', async () => {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const service = new SyncService(store, fixture, new EventBus(), fixture);
    const discover = fixture.discover.bind(fixture);
    let release: (() => void) | undefined;

    cleanups.push(() => store.close());
    cleanups.push(() => service.stop());
    cleanups.push(() => release?.());
    vi.spyOn(fixture, 'discover').mockImplementation(async (login, source) => {
      if (source === 'requested' && !release)
        await new Promise<void>((resolve) => (release = resolve));

      return discover(login, source);
    });

    const syncing = service.sync();

    await vi.waitFor(() => expect(release).toBeDefined());

    // Underneath the sync, as a switch made elsewhere would.
    fixture.select(DEMO_SECOND_ACCOUNT);
    release!();
    await syncing;

    expect(fixture.reads.length).toBeGreaterThan(0);
    expect(new Set(fixture.reads.map((read) => read.account))).toEqual(new Set(['you']));
    expect(service.status.account?.login).toBe('you');
  });

  it.each([2, 3])(
    'refuses a review workspace before the agent starts when glab signs in as someone else (check %i)',
    async (failing) => {
      const directory = mkdtempSync(join(tmpdir(), 'review-desk-bound-'));
      const exported: string[] = [];
      let checks = 0;
      const forge = {
        compare: vi.fn(async () => ({ mergeBaseOid: 'b'.repeat(40), files: [], commits: [] })),
        verifyAccount: vi.fn(async (account: string) => {
          if (++checks === failing) throw new AccountUnavailable(account, 'someone@gitlab.example');
        }),
      } as unknown as GitHubApi;
      const exporter: RepositoryExporter = async (_repository, oid) => {
        exported.push(oid);

        return [];
      };

      cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

      await expect(
        prepareReviewWorkspace(
          forge,
          snapshot({ baseOid: 'c'.repeat(40), headOid: 'd'.repeat(40) }),
          {} as DiffManifest,
          directory,
          new AbortController().signal,
          exporter,
          { account: 'ann@gitlab.example', credentials: null },
        ),
      ).rejects.toBeInstanceOf(AccountUnavailable);
      // Checked before the compare, between the downloads and after them: the second archive
      // is never fetched once a check fails.
      expect(exported).toEqual(failing === 2 ? ['b'.repeat(40)] : ['b'.repeat(40), 'd'.repeat(40)]);
    },
  );

  it('leaves an interrupted step uncertain when the sign-in changes around the receipt that would confirm it', async () => {
    const store = new Store(':memory:');
    const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const sync = new SyncService(store, github, new EventBus());

    cleanups.push(() => store.close());
    await sync.sync();

    const queue = new OperationQueue(sync, { mutationIntervalMs: 0 });

    queue.open();
    await queue.pause();

    const pull = sync.detail(sync.list().items.find((item) => item.number === 2041)!.id)!.snapshot;
    const { operation } = queue.enqueue('you', pull.id, randomUUID(), {
      type: 'reply',
      threadId: pull.threads[0].id,
      body: 'Interrupted',
    });
    const row = store.db
      .select()
      .from(githubOperations)
      .where(eq(githubOperations.id, operation.id))
      .get()!;

    // A discard whose deletion may have reached the forge: a missing review would confirm it.
    store.db
      .update(githubOperations)
      .set({
        status: 'running',
        data: {
          ...row.data,
          status: 'running',
          action: { type: 'discard', reviewId: 'PRR_gone' },
          steps: [
            {
              method: 'deleteReview',
              args: ['PRR_gone'],
              startedAt: new Date().toISOString(),
              completedAt: null,
              result: null,
              uncertain: true,
            },
          ],
        },
      })
      .where(eq(githubOperations.id, operation.id))
      .run();
    await queue.close();

    let checks = 0;

    // Reconciliation's identity read opens the bracket; glab signs in as someone else before the
    // check that closes it, after the receipt read.
    Object.assign(github, {
      verifyAccount: vi.fn(async (account: string) => {
        if (++checks === 1) throw new AccountUnavailable(account, 'someone-else');
      }),
    });

    const restarted = new OperationQueue(sync, { mutationIntervalMs: 0 });

    cleanups.push(() => restarted.close());
    restarted.open();

    await vi.waitFor(() =>
      expect(restarted.get('you', operation.id).status).toBe('needs_attention'),
    );
    const saved = store.db
      .select()
      .from(githubOperations)
      .where(eq(githubOperations.id, operation.id))
      .get()!;

    expect(saved.data.steps[0]).toMatchObject({ uncertain: true, completedAt: null });
    expect(checks).toBe(1);
  });
});
