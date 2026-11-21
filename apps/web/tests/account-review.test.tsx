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

const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));

vi.mock('sonner', () => ({
  toast: Object.assign(toasts.info, { error: toasts.error, success: toasts.success }),
}));

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
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

  it('never brings back an id another tab forgot, however their changes interleave', async () => {
    const key = (id: string) =>
      JSON.stringify({ path: `/api/accounts/me/pulls/${id}/review`, body: {}, method: 'POST' });

    // An earlier version's shared map, holding A and B.
    localStorage.setItem(
      'review-desk-pending-command-ids',
      JSON.stringify([
        [key('a'), 'a'],
        [key('b'), 'b'],
      ]),
    );
    vi.resetModules();

    const first = await import('@/lib/operation-command');

    vi.resetModules();

    const second = await import('@/lib/operation-command');
    const left = () =>
      ['a', 'b'].flatMap((id) => first.legacyIds(`/api/accounts/me/pulls/${id}/review`, 'POST'));

    // One tab forgets A while the other forgets B and keeps, then clears, an id of its own.
    vi.stubGlobal('fetch', async () => reply({ operation: { id: 'c' } }, 202));
    expect(first.forgetLegacy(key('a'), 'a')).toBe(true);

    const sending = second.githubCommand('/api/accounts/me/pulls/c/viewed', {});

    expect(second.forgetLegacy(key('b'), 'b')).toBe(true);
    await sending;

    expect(left()).toEqual([]);
  });

  it.each([
    ['its retirement saved', false],
    ['its retirement kept only in this tab, storage full', true],
  ])('never sends an earlier version’s id again once it was retired: %s', async (_case, full) => {
    const path = `/api/accounts/me/threads/${crypto.randomUUID()}/replies`;
    const body = { prId: 'p1', body: 'Same reply' };
    const sent: string[] = [];

    // An earlier version kept this reply's id in its shared map.
    localStorage.setItem(
      'review-desk-pending-command-ids',
      JSON.stringify([[JSON.stringify({ path, body, method: 'POST' }), 'legacy']]),
    );
    vi.resetModules();

    const { githubCommand, legacyIds } = await import('@/lib/operation-command');

    vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).operationId);

      return reply({ operation: { id: sent.at(-1) } }, 202);
    });

    if (full)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Quota exceeded');
      });

    // Its own retry, then the same reply sent twice more, on purpose.
    await githubCommand(path, body);
    await githubCommand(path, body);
    await githubCommand(path, body);

    expect(sent[0]).toBe('legacy');
    expect(sent.slice(1)).not.toContain('legacy');
    expect(new Set(sent).size).toBe(3);
    expect(legacyIds(path, 'POST')).toEqual([]);
    vi.restoreAllMocks();
  });

  it('retries an unsettled request with its own id, though another tab retired it meanwhile', async () => {
    const path = `/api/accounts/me/threads/${crypto.randomUUID()}/replies`;
    const body = { prId: 'p1', body: 'Sent once' };
    const key = JSON.stringify({ path, body, method: 'POST' });
    const sent: string[] = [];

    localStorage.setItem('review-desk-pending-command-ids', JSON.stringify([[key, 'legacy']]));
    vi.resetModules();

    const first = await import('@/lib/operation-command');

    vi.resetModules();

    const second = await import('@/lib/operation-command');

    vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).operationId);

      // This tab's first answer is lost; the server accepted it.
      if (sent.length === 1) throw new TypeError('Failed to fetch');

      return reply({ operation: { id: sent.at(-1) } }, 202);
    });

    await expect(first.githubCommand(path, body)).rejects.toThrow();
    // Another tab replays it, and retires it once its receipt answers.
    await second.githubCommand(path, body);
    // This tab's own retry: the same request, never a second reply.
    await first.githubCommand(path, body);

    expect(sent).toEqual(['legacy', 'legacy', 'legacy']);
  });

  it('retires a legacy id it settled though the earlier versions’ map became unreadable meanwhile', async () => {
    const path = `/api/accounts/me/threads/${crypto.randomUUID()}/replies`;
    const body = { prId: 'p1', body: 'Once' };
    const key = JSON.stringify({ path, body, method: 'POST' });

    localStorage.setItem('review-desk-pending-command-ids', JSON.stringify([[key, 'legacy']]));
    vi.resetModules();

    const { githubCommand } = await import('@/lib/operation-command');
    const getItem = Storage.prototype.getItem;
    let reads = 0;

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      if (name === 'review-desk-pending-command-ids' && ++reads > 1) throw new Error('Unreadable');

      return getItem.call(this, name);
    });
    vi.stubGlobal('fetch', async () => reply({ operation: { id: 'legacy' } }, 202));
    await githubCommand(path, body);

    vi.restoreAllMocks();
    expect(localStorage.getItem('review-desk-retired-command:legacy')).not.toBeNull();
  });

  it('never reuses a live copy of an id another tab retired', async () => {
    const path = `/api/accounts/me/threads/${crypto.randomUUID()}/replies`;
    const body = { prId: 'p1', body: 'New reply' };
    const key = JSON.stringify({ path, body, method: 'POST' });
    const sent: string[] = [];

    // Saved by one tab just after another retired it.
    localStorage.setItem('review-desk-retired-command:old', '1');
    localStorage.setItem(`review-desk-pending-command:${key}`, 'old');
    vi.resetModules();

    const { githubCommand } = await import('@/lib/operation-command');

    vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).operationId);

      return reply({ operation: { id: sent.at(-1) } }, 202);
    });
    await githubCommand(path, body);

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe('old');
  });

  it('retires a forgotten legacy id though the earlier versions’ map cannot be read', async () => {
    const { forgetLegacy } = await import('@/lib/operation-command');
    const getItem = Storage.prototype.getItem;

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      if (name === 'review-desk-pending-command-ids') throw new Error('Unreadable');

      return getItem.call(this, name);
    });

    expect(forgetLegacy(JSON.stringify({ path: '/x', body: {}, method: 'POST' }), 'kept')).toBe(
      true,
    );

    vi.restoreAllMocks();
    expect(localStorage.getItem('review-desk-retired-command:kept')).not.toBeNull();
  });

  it('sends a retry with the id it was first sent with, though storage could not keep it', async () => {
    const { githubCommand } = await import('@/lib/operation-command');
    const sent: string[] = [];

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });
    vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).operationId);

      if (sent.length === 1) throw new TypeError('Failed to fetch');

      return reply({ operation: { id: sent.at(-1) } }, 202);
    });

    const path = `/api/accounts/me/threads/${crypto.randomUUID()}/replies`;

    await expect(githubCommand(path, { prId: 'p1', body: 'Once' })).rejects.toThrow();
    await githubCommand(path, { prId: 'p1', body: 'Once' });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    vi.restoreAllMocks();
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

  it.each([
    ['an account not in use', notActive],
    ['a PR that kept changing', { error: 'Try again.', code: 'QUEUE_CHANGED' }],
  ])('keeps the ID of an action refused for %s, to send again later', async (_case, refusal) => {
    const { githubCommand } = await import('@/lib/operation-command');
    const sent: string[] = [];
    let refuse = true;

    vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).operationId);

      return refuse ? reply(refusal, 409) : reply({ operation: { id: sent.at(-1) } }, 202);
    });

    const path = `/api/accounts/me/pulls/${crypto.randomUUID()}/review`;

    await expect(githubCommand(path, { event: 'COMMENT', body: '' })).rejects.toThrow(
      refusal.error,
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

    act(() => {
      hook.result.current.writer.edit('body', 'Typed before the switch');
      void hook.result.current.writer.flush();
    });
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
    const ids: string[] = [];
    const versions = (revision: number) => ({ revision, generation: 0, observation: 0 });
    const old = {
      prId: 'p1',
      body: 'Before the switch',
      event: 'COMMENT',
      comments: [],
      versions: versions(0),
    };
    // A committed apply, as the server answers it: the draft it left, and its attempt.
    const applied = (body: string, revision: number) =>
      reply({
        ...old,
        body,
        versions: versions(revision),
        attempt: { id: ids[revision - 1], state: 'committed', revision },
      });

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
      if (!path.includes('/summary')) return Promise.resolve(reply({ runs: [] }));

      ids.push(JSON.parse(String(options?.body)).writeId);

      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    adoptStatus(client, as('me', 1));
    client.setQueryData(queryKeys.draft('me', 'p1'), old);

    const hook = renderHook(() => useAi('p1', 'me'), { wrapper: wrapper(client) });

    // A reply that comes while the same account is shown fills the draft in.
    act(() => hook.result.current.applySummary.mutate('run-1'));
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => answers[0](applied('Applied', 1)));
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
    await act(async () => answers[1](applied('From before the switch', 2)));
    await waitFor(() => expect(hook.result.current.applySummary.isSuccess).toBe(true));

    expect(client.getQueryData(queryKeys.draft('me', 'p1'))).toBeUndefined();
    client.clear();
  });

  it('never starts a summary on a verdict whose save was refused', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const { useAi } = await import('@/features/ai/use-ai');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const paths: string[] = [];

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';

      paths.push(`${method} ${path}`);

      return Promise.resolve(
        method === 'PUT' ? reply(notActive, 409) : reply({ items: [], nextCursor: null, runs: [] }),
      );
    });
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => ({ review: useReview('p1', 'me'), ai: useAi('p1', 'me') }), {
      wrapper: wrapper(client),
    });

    act(() => hook.result.current.review.writer.edit('event', 'APPROVE'));
    await act(() =>
      hook.result.current.ai.start.mutateAsync({ task: 'draft_summary' }).catch(() => {}),
    );

    await waitFor(() => expect(hook.result.current.ai.start.error?.message).toBe(notActive.error));

    expect(paths).toContain('PUT /api/accounts/me/pulls/p1/draft');
    expect(paths).not.toContain('POST /api/accounts/me/pulls/p1/ai');
    client.clear();
  });

  it('lets a read on its way land when a write seeds the draft, keeping the newer of the two', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const { seedNewer } = await import('@/features/review/use-draft-writer');
    const { accountSwitches } = await import('@/lib/live');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reads: ((response: Response) => void)[] = [];
    const at = (revision: number, body: string) => ({
      prId: 'p1',
      body,
      event: 'COMMENT',
      comments: [],
      versions: { revision, generation: 0, observation: 0 },
    });
    const shown = () =>
      (client.getQueryData(queryKeys.draft('me', 'p1')) as { body?: string })?.body;

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) =>
      (options?.method ?? 'GET') === 'GET' && path.endsWith('/pulls/p1/draft')
        ? new Promise<Response>((resolve) => reads.push(resolve))
        : Promise.resolve(reply({ items: [], nextCursor: null })),
    );
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });

    // A write's answer lands while a newer read is on its way: the read still lands.
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => void seedNewer(client, 'me', 'p1', at(5, 'Written') as never, accountSwitches()));
    await act(async () => reads[0](reply(at(7, 'Read'))));
    await waitFor(() => expect(shown()).toBe('Read'));

    // A read that started before a newer write lands after it: it never undoes it.
    act(() => void hook.result.current.draft.refetch());
    await waitFor(() => expect(reads).toHaveLength(2));
    act(
      () => void seedNewer(client, 'me', 'p1', at(9, 'Written later') as never, accountSwitches()),
    );
    await act(async () => reads[1](reply(at(8, 'Read before it'))));
    await waitFor(() => expect(hook.result.current.draft.isFetching).toBe(false));

    expect(shown()).toBe('Written later');
    client.clear();
  });

  it('starts a summary only once the verdict chosen before it was saved', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const { useAi } = await import('@/features/ai/use-ai');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const paths: string[] = [];
    let saved: (response: Response) => void = () => {};

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';

      paths.push(`${method} ${path}`);

      if (method === 'PUT') {
        const { writeId } = JSON.parse(String(options?.body));

        return new Promise<Response>(
          (resolve) =>
            (saved = () =>
              resolve(
                reply({
                  prId: 'p1',
                  body: '',
                  event: 'APPROVE',
                  comments: [],
                  versions: { revision: 1, generation: 0, observation: 0 },
                  attempt: { id: writeId, state: 'committed', revision: 1 },
                }),
              )),
        );
      }

      return Promise.resolve(reply({ items: [], nextCursor: null, runs: [] }));
    });
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => ({ review: useReview('p1', 'me'), ai: useAi('p1', 'me') }), {
      wrapper: wrapper(client),
    });

    act(() => hook.result.current.review.writer.edit('event', 'APPROVE'));
    await waitFor(() => expect(paths).toContain('PUT /api/accounts/me/pulls/p1/draft'));
    act(() => hook.result.current.ai.start.mutate({ task: 'draft_summary' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(paths).not.toContain('POST /api/accounts/me/pulls/p1/ai');

    await act(async () => saved(reply({})));
    await waitFor(() => expect(paths).toContain('POST /api/accounts/me/pulls/p1/ai'));
    client.clear();
  });

  it.each([
    // Submitted: your text is in the review, retired from the draft.
    [
      'a submit carried into the draft it submitted',
      'POST /api/accounts/me/pulls/p1/review',
      'saved',
    ],
    // Discarded, its cleanup yet to come: your text is held, unsent, until it is final.
    [
      'a discard dropped into the draft it discarded',
      'DELETE /api/accounts/me/pulls/p1/draft',
      'saving',
    ],
  ])('never autosaves the summary %s', async (_case, sentAs, state) => {
    const { useReview } = await import('@/features/review/use-review');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const paths: string[] = [];

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';

      paths.push(`${method} ${path}`);

      return Promise.resolve(
        method === 'POST' || method === 'DELETE'
          ? reply({ operation: { id: JSON.parse(String(options?.body)).operationId } }, 202)
          : path.endsWith('/receipt-epoch')
            ? reply({ epoch: 0 })
            : reply({ items: [], nextCursor: null }),
      );
    });
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });

    // Typed, then sent before its autosave's pause was over.
    act(() => hook.result.current.writer.edit('body', 'Typed just before'));
    await act(() =>
      sentAs.startsWith('POST')
        ? hook.result.current.submit.mutateAsync({
            event: 'COMMENT',
            body: 'Typed just before',
            expectedHeadOid: 'abc',
            carried: hook.result.current.writer.carry(undefined).versions,
            expectedPendingReviewId: null,
          })
        : hook.result.current.discard.mutateAsync(hook.result.current.writer.carry(undefined)),
    );
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(paths).toContain(sentAs);
    expect(paths).not.toContain('PUT /api/accounts/me/pulls/p1/draft');
    expect(hook.result.current.writer.state('body')).toBe(state);
    client.clear();
  });

  it('retires, once a submit is accepted, only the versions it was sent with, keeping what you typed after', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saved: string[] = [];

    vi.stubGlobal('fetch', (_path: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : {};

      if (method === 'PUT') saved.push(body.body);

      return Promise.resolve(
        method === 'POST'
          ? reply({ operation: { id: body.operationId } }, 202)
          : method === 'PUT'
            ? reply({ error: 'Locked.', code: 'DRAFT_LOCKED' }, 409)
            : _path.endsWith('/receipt-epoch')
              ? reply({ epoch: 0 })
              : reply({ items: [], nextCursor: null }),
      );
    });
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });

    act(() => hook.result.current.writer.edit('body', 'Sent'));

    // Read with its values, as the sheet reads them on Submit.
    const carried = hook.result.current.writer.carry(undefined);

    expect(carried.body).toBe('Sent');

    // Typed on before the submit ran: never saved into the draft it submits, nor retired with
    // the review: kept for you to confirm.
    act(() => hook.result.current.writer.edit('body', 'Typed after'));
    await act(() =>
      hook.result.current.submit.mutateAsync({
        event: carried.event,
        body: carried.body,
        expectedHeadOid: 'abc',
        carried: carried.versions,
        expectedPendingReviewId: null,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(saved).toEqual([]);
    expect(hook.result.current.writer.value('body', undefined)).toBe('Typed after');
    expect(hook.result.current.writer.failure('body')).toMatch(/after you submitted/);
    client.clear();
  });

  it('adopts a submit id an earlier version kept for the draft, forgetting it there once recorded', async () => {
    localStorage.setItem(
      'review-desk-pending-command-ids',
      JSON.stringify([
        [
          JSON.stringify({
            path: '/api/accounts/me/pulls/p1/review',
            body: { event: 'COMMENT', body: 'Old', expectedHeadOid: 'abc' },
            method: 'POST',
          }),
          'kept-before',
        ],
      ]),
    );
    vi.resetModules();

    const { useReview } = await import('@/features/review/use-review');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        reply({ error: 'Nothing was received with this id.', code: 'NOT_FOUND' }, 404),
      ),
    );
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });

    expect(hook.result.current.writer.commandViews()).toMatchObject([
      { id: 'kept-before', kind: 'submit', legacy: true, canSendAgain: false },
    ]);
    // Forgotten there once recorded: never offered for adoption again.
    expect(
      (await import('@/lib/operation-command')).legacyIds(
        '/api/accounts/me/pulls/p1/review',
        'POST',
      ),
    ).toEqual([]);
    client.clear();
  });

  it('looks an unconfirmed submit up as soon as its operation changes', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const { handle } = await import('@/lib/live');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let received = false;
    let id = '';

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';

      if (method === 'POST') {
        id = JSON.parse(String(options?.body)).operationId;

        return Promise.reject(new TypeError('Failed to fetch'));
      }

      if (path.endsWith('/receipt-epoch')) return Promise.resolve(reply({ epoch: 0 }));
      if (path.includes('/receipt'))
        return Promise.resolve(
          received
            ? reply({ kind: 'forge', prId: 'p1', type: 'review', status: 'queued' })
            : reply({ error: 'Nothing was received with this id.', code: 'NOT_FOUND' }, 404),
        );

      return Promise.resolve(reply({ items: [], nextCursor: null }));
    });
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });

    await act(() =>
      hook.result.current.submit
        .mutateAsync({
          event: 'COMMENT',
          body: '',
          expectedHeadOid: 'abc',
          carried: hook.result.current.writer.carry(undefined).versions,
          expectedPendingReviewId: null,
        })
        .catch(() => {}),
    );

    expect(hook.result.current.writer.commandViews()).toMatchObject([{ phase: 'unknown' }]);

    received = true;
    act(() =>
      handle(
        client,
        { type: 'operation.updated', account: 'me', prId: 'p1', operationId: id, status: 'queued' },
        { value: false },
      ),
    );

    await waitFor(() => expect(hook.result.current.writer.commandViews()).toEqual([]));
    client.clear();
  });

  it('discards with what was shown at the click, offline too, never text typed after it', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const { onlineManager } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const paths: string[] = [];

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';

      paths.push(`${method} ${path}`);

      return Promise.resolve(
        method === 'DELETE'
          ? reply({ operation: { id: JSON.parse(String(options?.body)).operationId } }, 202)
          : path.endsWith('/receipt-epoch')
            ? reply({ epoch: 0 })
            : reply({ kind: 'forge', prId: 'p1', type: 'discard', status: 'running' }),
      );
    });
    client.setQueryData(queryKeys.status, as('me'));
    onlineManager.setOnline(false);

    try {
      const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });
      const writer = () => hook.result.current.writer;

      act(() => writer().edit('body', 'At the click'));

      const carried = writer().carry(undefined);

      act(() => hook.result.current.discard.mutate(carried));
      act(() => writer().edit('body', 'Typed after'));

      await waitFor(() => expect(paths).toContain('DELETE /api/accounts/me/pulls/p1/draft'));
      await waitFor(() => expect(writer().commandViews()).toMatchObject([{ phase: 'admitted' }]));

      expect(writer().commandViews()[0]!.carried?.body).toBe('At the click');
    } finally {
      onlineManager.setOnline(true);
      client.clear();
    }
  });

  it('keeps the newer draft whatever is published into its query, as it is published', async () => {
    const { useReview } = await import('@/features/review/use-review');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const at = (revision: number, body: string) => ({
      prId: 'p1',
      body,
      event: 'COMMENT',
      comments: [],
      versions: { revision, generation: 0, observation: 0 },
    });
    const key = queryKeys.draft('me', 'p1');

    vi.stubGlobal('fetch', (path: string) =>
      Promise.resolve(reply(path.endsWith('/pulls/p1/draft') ? at(3, 'Read') : { items: [] })),
    );
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useReview('p1', 'me'), { wrapper: wrapper(client) });

    await waitFor(() => expect(hook.result.current.draft.data).toMatchObject({ body: 'Read' }));

    // A newer draft, then an older one published over it (a read computed before it landed).
    act(() => void client.setQueryData(key, at(6, 'Newer')));
    act(() => void client.setQueryData(key, at(4, 'Older, published later')));

    expect(client.getQueryData(key)).toMatchObject({ body: 'Newer' });
    client.clear();
  });

  it('refreshes the drafts and Activity of the account an event names, and no other', () => {
    const client = new QueryClient();
    const keys = (login: string) => [
      queryKeys.draft(login, 'p1'),
      queryKeys.operations(login),
      queryKeys.ai(login, 'p1'),
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

describe('AI and Insights per account', () => {
  it('refreshes the AI runs and Insights of the account an event names', () => {
    const client = new QueryClient();
    const keys = (login: string) => [
      queryKeys.ai(login, 'p1'),
      queryKeys.aiReviews(login),
      queryKeys.insights(login, 30, ''),
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
    handle(client, { type: 'ai.updated', account: 'me', prId: 'p1', runId: 'r1' }, first);
    expect(stale()).toEqual([
      [true, true, false],
      [false, false, false],
    ]);

    reset();
    handle(client, { type: 'pulls.changed', account: 'me', ids: ['p1'] }, first);
    expect(stale()).toEqual([
      [true, true, false],
      [false, false, false],
    ]);

    reset();
    handle(client, { type: 'insights.updated', account: 'me' }, first);
    expect(stale()).toEqual([
      [false, false, true],
      [false, false, false],
    ]);

    // The review target is every account's.
    reset();
    handle(client, { type: 'insights.updated', account: null }, first);
    expect(stale()).toEqual([
      [false, false, true],
      [false, false, true],
    ]);
  });

  it('reads the AI runs of the account left again on a switch, as its restarts now wait', async () => {
    const { adoptStatus } = await import('@/lib/live');
    const client = new QueryClient();

    adoptStatus(client, as('me', 1));
    client.setQueryData(queryKeys.ai('me', 'p1'), { runs: [], restartAt: 'soon' });
    client.setQueryData(queryKeys.aiReviews('me'), { reviews: [] });
    adoptStatus(client, as('other', 2));

    expect(client.getQueryState(queryKeys.ai('me', 'p1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.aiReviews('me'))?.isInvalidated).toBe(true);
    client.clear();
  });

  it('says why a history re-read was refused', async () => {
    const { InsightsPage } = await import('@/features/insights/insights-page');
    const { render, screen, fireEvent } = await import('@testing-library/react');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    vi.stubGlobal('fetch', async (path: string, options?: RequestInit) =>
      options?.method === 'POST'
        ? reply(notActive, 409)
        : path.includes('/insights')
          ? reply({
              insights: null,
              backfill: { doneWindows: [], finishedAt: null, lastError: null, running: false },
              slaHours: 24,
              repositories: [],
            })
          : reply({}),
    );
    client.setQueryData(queryKeys.status, as('me'));
    render(
      <QueryClientProvider client={client}>
        <InsightsPage />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Re-read history' }));

    expect(await screen.findByText(notActive.error)).toBeInTheDocument();
    client.clear();
  });
});

describe('Insights refreshes and empty states', () => {
  it('reads every account’s Insights again after a first load that was on its way', async () => {
    const { QueryObserver } = await import('@tanstack/react-query');
    const client = new QueryClient();
    const answers: ((value: string) => void)[] = [];
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.insights('me', 30, ''),
      queryFn: () => new Promise<string>((resolve) => answers.push(resolve)),
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      await vi.waitFor(() => expect(answers).toHaveLength(1));

      // The load left before the review target changed, and answers with the old one.
      handle(client, { type: 'insights.updated', account: null }, { value: false });
      answers[0]('Old target');

      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]('New target');
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe('New target'));
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it('shows Insights as empty, with nothing to read again, when signed out', async () => {
    const { InsightsPage } = await import('@/features/insights/insights-page');
    const { render, screen } = await import('@testing-library/react');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetches: string[] = [];

    vi.stubGlobal('fetch', async (path: string) => {
      fetches.push(path);

      return reply({});
    });
    client.setQueryData(queryKeys.status, status({ account: null }));
    render(
      <QueryClientProvider client={client}>
        <InsightsPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Insights appear after the first sync.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-read history' })).toBeDisabled();
    expect(fetches.filter((path) => path.includes('/insights'))).toEqual([]);
    client.clear();
  });
});

describe('adding by hand, per account', () => {
  const added = (membershipId: string | null) => ({
    account: 'me',
    snapshot: {
      id: 'p9',
      repository: 'acme/web',
      number: 9,
      url: 'https://github.com/acme/web/pull/9',
      author: { login: 'carol' },
    },
    item: { queue: 'needs_attention', sources: ['manual'] },
    triage: {},
    membershipId,
  });

  it("undoes an add only by the membership it made, for the add's own account", async () => {
    const { useTrackPull } = await import('@/features/pulls/use-track');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sent: { method: string; path: string; body: unknown }[] = [];
    let answer = added('membership-1');

    vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
      sent.push({
        method: options?.method ?? 'GET',
        path,
        body: options?.body ? JSON.parse(String(options.body)) : null,
      });

      return reply(options?.method === 'DELETE' ? { tracked: false } : answer);
    });
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useTrackPull(), { wrapper: wrapper(client) });

    await act(() =>
      hook.result.current.mutateAsync({
        ref: { owner: 'acme', repo: 'web', number: 9 },
        account: 'me',
      }),
    );

    const [, options] = toasts.success.mock.calls.at(-1)!;

    // Another account is shown by the time Undo is pressed: the add was me's, and so is its Undo.
    client.setQueryData(queryKeys.status, as('other'));
    await act(async () => options.action.onClick());

    expect(sent.find((call) => call.method === 'DELETE')).toEqual({
      method: 'DELETE',
      path: '/api/accounts/me/pulls/p9/track',
      body: { membershipId: 'membership-1' },
    });

    // An add of a PR already added made nothing to undo.
    answer = added(null);
    client.setQueryData(queryKeys.status, as('me'));
    hook.rerender();
    await act(() =>
      hook.result.current.mutateAsync({
        ref: { owner: 'acme', repo: 'web', number: 9 },
        account: 'me',
      }),
    );

    expect(toasts.success.mock.calls.at(-1)![1]).toBeUndefined();
    client.clear();
  });

  it("says an add's Undo left the PR in the queue when a feed still lists it", async () => {
    const { useTrackPull } = await import('@/features/pulls/use-track');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    vi.stubGlobal('fetch', async (_path: string, options?: RequestInit) =>
      reply(options?.method === 'DELETE' ? { tracked: true } : added('membership-3')),
    );
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useTrackPull(), { wrapper: wrapper(client) });

    await act(() =>
      hook.result.current.mutateAsync({
        ref: { owner: 'acme', repo: 'web', number: 9 },
        account: 'me',
      }),
    );
    await act(async () => toasts.success.mock.calls.at(-1)![1].action.onClick());

    await waitFor(() =>
      expect(toasts.info).toHaveBeenCalledWith(expect.stringContaining('stays in your queue')),
    );
    client.clear();
  });

  it('adds for the account shown when you added, even when the add waited past a switch', async () => {
    const { onlineManager } = await import('@tanstack/react-query');
    const { AddToQueueButton } = await import('@/features/pulls/use-track');
    const { render, screen, fireEvent } = await import('@testing-library/react');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const posts: string[] = [];

    vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
      if (options?.method === 'POST') posts.push(path);

      return reply(options?.method === 'POST' ? added(null) : { account: 'me', items: [] });
    });
    client.setQueryData(queryKeys.status, as('me'));
    render(
      <QueryClientProvider client={client}>
        <AddToQueueButton pullRef={{ owner: 'acme', repo: 'web', number: 9 }} />
      </QueryClientProvider>,
    );

    // Offline, the add waits; meanwhile the page comes to show another account.
    onlineManager.setOnline(false);

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Add to review queue' }));
      await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.isPaused).toBe(true));
      act(() => {
        client.setQueryData(queryKeys.status, as('other'));
      });
    } finally {
      onlineManager.setOnline(true);
    }

    await waitFor(() => expect(posts).toEqual(['/api/accounts/me/pulls/track']));
    client.clear();
  });

  it('opens an added PR only while its account is still shown', async () => {
    const { useAddAndOpen } = await import('@/features/pulls/use-track');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let answer: ((response: Response) => void) | null = null;

    vi.stubGlobal('fetch', (path: string, options?: RequestInit) =>
      options?.method === 'POST'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : Promise.resolve(reply({ account: 'me', items: [] })),
    );
    client.setQueryData(queryKeys.status, as('me'));

    const hook = renderHook(() => useAddAndOpen(), { wrapper: wrapper(client) });
    let done: Promise<unknown> = Promise.resolve();

    act(() => {
      done = hook.result.current.add({ owner: 'acme', repo: 'web', number: 9 });
    });
    await waitFor(() => expect(answer).not.toBeNull());
    client.setQueryData(queryKeys.status, as('other'));
    await act(async () => {
      answer!(reply(added('membership-2')));
      await done;
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(toasts.info).toHaveBeenCalledWith('Added for me.');
    client.clear();
  });
});
