import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { forgeTraits } from '@review-desk/shared/traits';
import { createApp } from '@/app.js';
import { failed } from '@/http/serve.js';
import { EventBus } from '@/events.js';
import { SELECTED_ACCOUNT, WRITE_COOLDOWN } from '@/db/settings.js';
import { Store } from '@/db/store.js';
import type { GitHubApi } from '@/github/api.js';
import { GitHubError, safeError } from '@/github/errors.js';
import {
  messageIds,
  render,
  renderStored,
  say,
  UNKNOWN_MESSAGE,
  wordingOf,
  type Message,
} from '@/messages.js';
import { OperationQueue } from '@/operations/queue.js';
import type { OperationRecord } from '@/operations/types.js';
import { ReviewError } from '@/review/errors.js';
import { SyncService } from '@/sync/service.js';
import { snapshot } from '@test/fixtures.js';

const GITHUB = 'octo';
const GITLAB = 'rev@git.example.com';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

/** Parameters for any entry: each takes the ones it names. */
const SAMPLE = { login: 'ana', reason: 'a reason.', path: 'src/app.ts' };
const sample = (id: (typeof messageIds)[number]) => ({ id, params: SAMPLE }) as Message;

describe('the message catalog', () => {
  it("words every message in each forge's own terms", () => {
    expect(messageIds.length).toBeGreaterThan(50);

    for (const id of messageIds) {
      const github = render(sample(id), GITHUB);
      const gitlab = render(sample(id), GITLAB);

      expect(github, id).not.toMatch(/undefined|\{|\bMRs?\b|merge request/);
      expect(gitlab, id).not.toMatch(/undefined|\{|GitHub|\bPRs?\b|pull request/);
      // Only the message about GitLab's own earlier approvals names GitLab for GitHub too.
      if (id !== 'stop.legacy-gitlab-approval') expect(github, id).not.toContain('GitLab');
    }
  });

  it("words a message for the account's forge, and GitHub's without one", () => {
    expect(render(say('pull.untracked'), GITLAB)).toBe('This MR is no longer tracked.');
    expect(render(say('pull.untracked'), GITHUB)).toBe('This PR is no longer tracked.');
    expect(render(say('pull.untracked'), null)).toBe('This PR is no longer tracked.');
    expect(render(say('outbox.checking-account'), GITLAB)).toBe(
      'Checking the GitLab account and merge request.',
    );
  });

  it('words a message given as a parameter for the same account, and starts its sentence', () => {
    const stopped = say('stop.nothing-more-approving', { reason: say('stop.untracked') });

    expect(render(stopped, GITLAB)).toBe(
      'This MR is no longer tracked. Nothing more is sent; check the MR, then approve it yourself if it still applies.',
    );
    expect(render(say('outbox.not-posted', { reason: say('stop.own') }), GITHUB)).toBe(
      'Not posted: you cannot approve your own PR.',
    );
  });

  it('inserts text parameters as they are, never reworded', () => {
    const changed = say('outbox.viewed-file-changed', { path: 'docs/GitHub pull request.md' });

    expect(render(changed, GITLAB)).toBe(
      'Not marked viewed: docs/GitHub pull request.md changed after you viewed it. Look at the new diff first.',
    );
    expect(render('Plain text stays as it is: GitHub.', GITLAB)).toBe(
      'Plain text stays as it is: GitHub.',
    );
  });

  it('says it cannot show a message it no longer has, or a damaged one', () => {
    expect(render({ id: 'retired.message' } as never, GITLAB)).toBe(UNKNOWN_MESSAGE);
    expect(render({ id: 'toString' } as never, GITLAB)).toBe(UNKNOWN_MESSAGE);
    expect(render({ text: 'no id' } as never, GITLAB)).toBe(UNKNOWN_MESSAGE);
    expect(render(null as never, GITLAB)).toBe(UNKNOWN_MESSAGE);

    // A message the catalog has, stored without the parameters its entry names.
    for (const params of [undefined, {}, { path: 7 }, { path: null }, ['src/app.ts'], 'src/app.ts'])
      expect(render({ id: 'outbox.viewed-file-gone', params } as never, GITLAB)).toBe(
        UNKNOWN_MESSAGE,
      );

    // One damaged inside another is the part it cannot show.
    expect(
      render({ id: 'outbox.not-posted', params: { reason: { id: 'x' } } } as never, GITLAB),
    ).toBe(`Not posted: ${UNKNOWN_MESSAGE}`);
  });

  it('is made with the parameters its ID names, even from an ID of several kinds', () => {
    const id = 'pull.untracked' as 'pull.untracked' | 'review.cli-changed';

    // @ts-expect-error: `review.cli-changed` needs its `login`.
    expect(say(id)).toEqual({ id: 'pull.untracked' });
    // @ts-expect-error: and `pull.untracked` takes none.
    say('pull.untracked', { login: 'ana' });
    // A refusal's code stays a text.
    // @ts-expect-error: a code is a string.
    failed(409, { error: say('pull.untracked'), code: 7 });

    expect(say('review.cli-changed', { login: 'ana' })).toEqual({
      id: 'review.cli-changed',
      params: { login: 'ana' },
    });
  });

  it("words a stored row's text as Activity always has, and its messages from the catalog", () => {
    // Text stored before the catalog was written for GitHub.
    expect(renderStored('Checking GitHub before retrying.', GITLAB)).toBe(
      'Checking GitLab before retrying.',
    );
    expect(renderStored('Checking GitHub before retrying.', GITHUB)).toBe(
      'Checking GitHub before retrying.',
    );
    expect(renderStored(say('outbox.untracked'), GITLAB)).toBe(
      'Not posted: this MR is no longer tracked.',
    );
  });
});

describe('a refusal', () => {
  it("keeps its message to be worded where it is shown, and says it in GitHub's words for logs", () => {
    const refusal = new ReviewError('NOT_ADDED', 409, say('queue.not-added'));

    expect(refusal.wording).toEqual({ id: 'queue.not-added' });
    expect(refusal.message).toBe('Only PRs you added yourself can be removed.');
    expect(wordingOf(refusal, () => 'redacted')).toEqual({ id: 'queue.not-added' });

    // Its text parameters are redacted as any error text is, nested ones included.
    const token = `ghp_${'a'.repeat(36)}`;
    const leaked = new ReviewError(
      'ACCOUNT_CHANGED',
      409,
      say('outbox.not-posted', { reason: say('review.cli-changed', { login: token }) }),
    );

    expect(wordingOf(leaked, safeError)).toEqual({
      id: 'outbox.not-posted',
      params: { reason: { id: 'review.cli-changed', params: { login: '[redacted]' } } },
    });

    // Any other error, or a refusal in plain text, is its redacted message.
    expect(wordingOf(new Error('token=secret'), () => 'redacted')).toBe('redacted');
    expect(wordingOf(new ReviewError('X', 409, 'Plain.'), (error) => String(error))).toBe(
      'Error: Plain.',
    );
  });
});

/** A synced GitLab account with one open MR, served by the app. */
async function gitlabApp(options: { feedLimit?: string } = {}) {
  const store = new Store(':memory:');
  const api = {
    identity: vi.fn(async () => ({ login: GITLAB })),
    teams: vi.fn(async () => []),
    capabilities: vi.fn(async () => ({ requestChanges: true })),
    discover: vi.fn(async (_login: string, source: string) => {
      if (source === 'assigned' && options.feedLimit)
        throw new GitHubError('Rate limited', options.feedLimit, 429, 'rate_limit');

      return source === 'requested' ? ['mr-1'] : [];
    }),
    detect: vi.fn(async (list: string[]) => ({
      results: list.map((id) => ({ id, state: 'OPEN' as const, fingerprint: randomUUID() })),
      budget: null,
    })),
    snapshot: vi.fn(async (id: string, _login: string, sources: string[]) =>
      snapshot({
        id,
        number: 1,
        url: 'https://git.example.com/team/app/-/merge_requests/1',
        sources: sources as never,
      }),
    ),
    traits: forgeTraits.gitlab,
    verifyAccount: vi.fn(async () => undefined),
  } as unknown as GitHubApi;

  // The CLI's accounts, for switching.
  const accounts = { list: async () => [{ login: GITLAB, ok: true }], select: vi.fn() };

  store.settings.set(SELECTED_ACCOUNT, GITLAB);

  const service = new SyncService(store, api, new EventBus(), accounts as never);

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();

  const app = await createApp(service, { sessionToken: 'test-session' });

  cleanups.push(() => app.close());

  const headers = {
    host: '127.0.0.1:4317',
    'x-review-desk': '1',
    'x-review-desk-session': 'test-session',
  };
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  return { store, service, call };
}

const mrs = `/api/accounts/${encodeURIComponent(GITLAB)}/pulls`;

/** Puts a GitHub account in use. The GitLab account stays known, by the status it saved. */
function useGitHub(service: SyncService) {
  service.status = { ...service.status, account: { login: GITHUB } } as typeof service.status;

  expect(service.status.account?.login).toBe(GITHUB);
}

describe("the server's answers", () => {
  it('refuse in the words of the account the path names, not the one in use', async () => {
    const { service, call } = await gitlabApp();

    useGitHub(service);

    // A refusal a handler returns.
    const missing = await call('GET', `${mrs}/mr-404`);

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'This MR is no longer tracked for this account.' });

    // And one a handler throws.
    const untracked = await call('DELETE', `${mrs}/mr-1/track`, {});

    expect(untracked.statusCode).toBe(409);
    expect(untracked.json()).toMatchObject({
      code: 'NOT_ADDED',
      error: 'Only MRs you added yourself can be removed.',
    });
  });

  it('refuse a stale switch in the words of the account its check found', async () => {
    const { service, call } = await gitlabApp();
    const stale = await call('POST', '/api/accounts/switch', { from: 'someone', to: GITLAB });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'ACCOUNT_CHANGED',
      error: 'GitLab account changed. Refresh before switching.',
    });

    // Worded when the check failed: a switch that finishes before it is sent changes nothing.
    const refusal = await service.switchAccount('someone', GITLAB).catch((error) => error);

    useGitHub(service);
    expect(render((refusal as ReviewError).wording, GITHUB)).toBe(
      'GitLab account changed. Refresh before switching.',
    );
  });

  it("show each field of an Activity row in its account's words, not the one in use", async () => {
    const { store, service, call } = await gitlabApp();

    useGitHub(service);
    const queue = new OperationQueue(service, { mutationIntervalMs: 0 });
    const row = (id: string, fields: Partial<OperationRecord>): OperationRecord => ({
      id,
      account: GITLAB,
      prId: 'mr-1',
      repository: 'team/app',
      number: 1,
      title: 'An MR',
      prUrl: 'https://git.example.com/team/app/-/merge_requests/1',
      action: { type: 'reply', threadId: 'thread-1', body: 'Thanks' },
      status: 'needs_attention',
      progress: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      retryAt: null,
      dismissedAt: null,
      error: null,
      result: null,
      steps: [],
      attempts: 0,
      requestKey: id,
      ...fields,
    });

    // From before the catalog: text written for GitHub, as Activity always showed it.
    store.operations.insert(
      row('legacy', {
        progress: 'Unconfirmed. Open GitHub to verify before taking another action.',
        error: {
          code: 'UNCONFIRMED',
          message: 'The previous request may have reached GitHub. Check its result first.',
        },
      }),
    );
    // A newer progress over an older error: each field is worded on its own.
    store.operations.insert(
      row('mixed', {
        progress: say('outbox.not-posted', { reason: say('stop.own') }),
        error: { code: 'POST_STOPPED', message: 'Not posted: this PR is no longer tracked.' },
      }),
    );

    expect(queue.get(GITLAB, 'legacy')).toMatchObject({
      progress: 'Unconfirmed. Open GitLab to verify before taking another action.',
      error: { message: 'The previous request may have reached GitLab. Check its result first.' },
    });

    const shown = await call('GET', `/api/accounts/${encodeURIComponent(GITLAB)}/operations/mixed`);

    expect(shown.statusCode).toBe(200);
    expect(shown.json().operation).toMatchObject({
      progress: 'Not posted: you cannot approve your own MR.',
      // The old string, as `forForge` words it: "PR" was never reworded.
      error: { message: 'Not posted: this PR is no longer tracked.' },
    });

    // A damaged field says it cannot be shown; the row, and Activity, still show.
    store.operations.insert(
      row('damaged', {
        progress: { id: 'outbox.viewed-file-gone' } as never,
        error: { code: 'X', message: say('outbox.unconfirmed') },
      }),
    );

    const damaged = await call(
      'GET',
      `/api/accounts/${encodeURIComponent(GITLAB)}/operations/damaged`,
    );

    expect(damaged.statusCode).toBe(200);
    expect(damaged.json().operation).toMatchObject({
      progress: UNKNOWN_MESSAGE,
      error: { message: 'Unconfirmed. Open GitLab to verify before taking another action.' },
    });
    expect(
      (await call('GET', `/api/accounts/${encodeURIComponent(GITLAB)}/operations`)).statusCode,
    ).toBe(200);
  });

  it("say a GitLab account's cooldown in GitLab's words", async () => {
    const { service } = await gitlabApp({
      feedLimit: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(service.status.error).toBe(
      'GitLab rate limit reached. Refresh will resume automatically after the cooldown.',
    );
  });

  it('say a cooldown in the words of the account cooling down, not the one in use', async () => {
    const { store, service } = await gitlabApp();

    store.settings.set(WRITE_COOLDOWN.of(GITHUB), new Date(Date.now() + 60_000).toISOString());

    expect(() => service.assertNotCoolingDown(GITHUB)).toThrow(
      'GitHub is rate limited. Saved data is still available.',
    );
  });
});
