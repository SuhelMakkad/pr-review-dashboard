// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubOperation } from '@review-desk/shared/operations';
import { handle } from '@/lib/live';
import { queryKeys } from '@/lib/query-keys';
import { status } from '@test/fixtures';

const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({
  toast: Object.assign(toasts.info, { error: toasts.error, success: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const as = (login: string, revision = 1) => status({ account: { login }, revision });
const reply = (body: unknown, code = 200) =>
  ({ ok: code < 400, status: code, json: async () => body }) as Response;
const notActive = {
  error: "You're using other now. Switch back to me to do this.",
  code: 'ACCOUNT_NOT_ACTIVE',
  account: 'me',
  selected: 'other',
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('action IDs across the move to account routes', () => {
  it("names a legacy route's saved action by its account's own route", async () => {
    const { scopedKey } = await import('@/lib/operation-command');
    const key = (path: string, body: object, method = 'POST') =>
      JSON.stringify({ path, body, method });

    expect(scopedKey(key('/api/pulls/p%2F1/review', { account: 'me', event: 'COMMENT' }))).toBe(
      key('/api/accounts/me/pulls/p%2F1/review', { event: 'COMMENT' }),
    );
    expect(
      scopedKey(key('/api/threads/t1/replies', { account: 'me', prId: 'p1', body: 'Yes' })),
    ).toBe(key('/api/accounts/me/threads/t1/replies', { prId: 'p1', body: 'Yes' }));
    expect(scopedKey(key('/api/pulls/p1/draft', { account: 'me' }, 'DELETE'))).toBe(
      key('/api/accounts/me/pulls/p1/draft', {}, 'DELETE'),
    );
    // Already on an account's route, or not one this applies to: as it was.
    expect(scopedKey(key('/api/accounts/me/pulls/p1/review', {}))).toBe(
      key('/api/accounts/me/pulls/p1/review', {}),
    );
    expect(scopedKey('not json')).toBe('not json');
  });

  it('sends an ID saved by an earlier version again on the account’s route', async () => {
    localStorage.setItem(
      'review-desk-pending-command-ids',
      JSON.stringify([
        [
          JSON.stringify({
            path: '/api/pulls/p1/viewed',
            body: { account: 'me', path: 'a.ts', viewed: true },
            method: 'POST',
          }),
          'saved-before-the-move',
        ],
      ]),
    );
    vi.resetModules();

    const { githubCommand } = await import('@/lib/operation-command');
    const sent: string[] = [];

    vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).operationId);

      return reply({ operation: { id: sent.at(-1) } }, 202);
    });

    await githubCommand('/api/accounts/me/pulls/p1/viewed', { path: 'a.ts', viewed: true });

    expect(sent).toEqual(['saved-before-the-move']);
  });

  it('keeps the ID of an action refused for an account not in use, to send again later', async () => {
    const { githubCommand } = await import('@/lib/operation-command');
    const sent: string[] = [];
    let refuse = true;

    vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).operationId);

      return refuse ? reply(notActive, 409) : reply({ operation: { id: sent.at(-1) } }, 202);
    });

    const path = `/api/accounts/me/pulls/${crypto.randomUUID()}/review`;

    await expect(githubCommand(path, { event: 'COMMENT', body: '' })).rejects.toThrow(
      'Switch back to me',
    );
    refuse = false;
    await githubCommand(path, { event: 'COMMENT', body: '' });

    expect(sent[0]).toBe(sent[1]);
  });
});

describe('drafts and Activity per account', () => {
  it('tells you why an autosave was not kept, after its sheet has closed', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let answer: (response: Response) => void = () => {};
    const paths: string[] = [];

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
      paths.push(`${options?.method ?? 'GET'} ${path}`);

      return options?.method === 'PUT'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : Promise.resolve(reply({ items: [], nextCursor: null }));
    });
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });

    act(() => hook.result.current.saveMeta.mutate({ body: 'Typed before the switch' }));
    await waitFor(() => expect(paths).toContain('PUT /api/accounts/me/pulls/p1/draft'));
    hook.unmount();
    await act(async () => answer(reply(notActive, 409)));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(notActive.error));
    client.clear();
  });

  it('never shows a draft from before a switch, nor refills it with a reply that crossed one', async () => {
    // From the same modules as the hook, which an earlier test's `resetModules` may have renewed.
    const { useAi } = await import('@/features/ai/use-ai');
    const { adoptStatus } = await import('@/lib/live');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const answers: ((response: Response) => void)[] = [];
    const old = { prId: 'p1', body: 'Before the switch', event: 'COMMENT', comments: [] };

    vi.stubGlobal('fetch', (path: string) =>
      path.includes('/summary')
        ? new Promise<Response>((resolve) => answers.push(resolve))
        : Promise.resolve(reply({ runs: [] })),
    );
    adoptStatus(client, as('me', 1));
    client.setQueryData(queryKeys.draft('me', 'p1'), old);

    const hook = renderHook(() => useAi('p1', 'me'), { wrapper: wrapper(client) });

    // A reply that comes while the same account is shown fills the draft in.
    act(() => hook.result.current.applySummary.mutate('run-1'));
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => answers[0](reply({ ...old, body: 'Applied' })));
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.draft('me', 'p1'))).toMatchObject({ body: 'Applied' }),
    );

    // Away and back while the next is on its way: the draft is gone, to be read afresh, and the
    // late reply does not bring the older one back.
    act(() => hook.result.current.applySummary.mutate('run-1'));
    await waitFor(() => expect(answers).toHaveLength(2));
    act(() => adoptStatus(client, as('other', 2)));
    act(() => adoptStatus(client, as('me', 3)));
    expect(client.getQueryData(queryKeys.draft('me', 'p1'))).toBeUndefined();
    await act(async () => answers[1](reply({ ...old, body: 'From before the switch' })));
    await waitFor(() => expect(hook.result.current.applySummary.isSuccess).toBe(true));

    expect(client.getQueryData(queryKeys.draft('me', 'p1'))).toBeUndefined();
    client.clear();
  });

  it('refreshes the drafts and Activity of the account an event names, and no other', () => {
    const client = new QueryClient();
    const keys = (login: string) => [
      queryKeys.draft(login, 'p1'),
      queryKeys.operations(login),
      queryKeys.ai('p1', login),
    ];
    const stale = () =>
      ['me', 'other'].map((login) =>
        keys(login).map((key) => Boolean(client.getQueryState(key)?.isInvalidated)),
      );
    const reset = () => {
      client.clear();
      for (const login of ['me', 'other'])
        for (const key of keys(login)) client.setQueryData(key, {});
    };
    const first = { value: false };

    reset();
    handle(client, { type: 'draft.updated', account: 'me', id: 'p1' }, first);
    expect(stale()).toEqual([
      [true, false, true],
      [false, false, false],
    ]);

    reset();
    handle(
      client,
      {
        type: 'operation.updated',
        account: 'me',
        prId: 'p1',
        operationId: 'o1',
        status: 'queued',
      },
      first,
    );
    expect(stale()).toEqual([
      [true, true, false],
      [false, false, false],
    ]);

    reset();
    handle(client, { type: 'pulls.changed', account: 'me', ids: ['p1'] }, first);
    expect(stale()[0][0]).toBe(true);
    expect(stale()[1][0]).toBe(false);
  });

  it('opens a reopened action’s PR only while its account is shown', async () => {
    const { reopened } = await import('@/features/activity/activity-drawer');
    const client = new QueryClient();
    const open = vi.fn();
    const operation = {
      id: 'o1',
      account: 'me',
      prId: 'p1',
      repository: 'acme/api',
      number: 7,
      prUrl: 'https://github.com/acme/api/pull/7',
      action: { type: 'reply', threadId: 't1', body: 'Saved' },
    } as unknown as GitHubOperation;

    client.setQueryData(queryKeys.status, as('other'));
    reopened(client, operation, open);

    expect(open).not.toHaveBeenCalled();
    expect(toasts.info).toHaveBeenCalledWith('Saved for me. Switch back to me to continue.');
    expect(localStorage.getItem('review-desk-recovered:me:p1')).toBe(
      JSON.stringify(operation.action),
    );

    client.setQueryData(queryKeys.status, as('me'));
    reopened(client, operation, open);

    expect(open).toHaveBeenCalledWith({
      to: '/pr/$owner/$repo/$number/files',
      params: { owner: 'acme', repo: 'api', number: '7' },
      search: { thread: 't1' },
    });
  });
});
