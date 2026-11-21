// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { routes } from '@review-desk/shared/contract';
import { api } from '@/lib/api';
import { pathOf } from '@/lib/call';
import { frameReader, UNREADABLE_WINDOW_MS } from '@/lib/live';
import { readStatus } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('addresses from the contract', () => {
  // As the routes were built before the contract: a command's saved ID is keyed by its address.
  const before = (account: string, path: string) =>
    `/api/accounts/${encodeURIComponent(account)}${path}`;
  const account = 'ann@git.example.com:8443';
  const id = 'PR_acme/web#1';
  const pr = { account, id };
  const enc = encodeURIComponent(id);

  it.each([
    [routes.submit, pr, `/pulls/${enc}/review`],
    [routes.commentNow, pr, `/pulls/${enc}/comments`],
    [routes.viewed, pr, `/pulls/${enc}/viewed`],
    [routes.reviewers, pr, `/pulls/${enc}/reviewers`],
    [routes.discard, pr, `/pulls/${enc}/draft`],
    [routes.reply, { account, threadId: 't/1' }, `/threads/${encodeURIComponent('t/1')}/replies`],
    [
      routes.resolve,
      { account, threadId: 't/1' },
      `/threads/${encodeURIComponent('t/1')}/resolution`,
    ],
  ] as const)('builds %s as it always was', (route, params, path) => {
    expect(pathOf(route, params as never)).toBe(before(account, path));
  });

  it('leaves out query values that are not set', () => {
    expect(pathOf(routes.operations, { account }, { cursor: undefined })).toBe(
      before(account, '/operations'),
    );
    expect(pathOf(routes.insights, { account }, { days: 7, repo: '' })).toBe(
      `${before(account, '/insights')}?days=7`,
    );
  });
});

describe('frames the page cannot read', () => {
  it('read everything again once, after the last of a burst, and not once closed', () => {
    vi.useFakeTimers();

    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const frames = frameReader(client);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    frames.read('not json');
    vi.advanceTimersByTime(UNREADABLE_WINDOW_MS - 50);
    frames.read(JSON.stringify({ type: 'pulls.changed', account: 'me' }));
    vi.advanceTimersByTime(UNREADABLE_WINDOW_MS - 1);
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(1);

    // A readable frame is applied as before.
    invalidate.mockClear();
    frames.read(JSON.stringify({ type: 'triage.updated', account: 'me', id: 'p1' }));
    expect(invalidate).toHaveBeenCalled();

    // Closed with a refresh still due: none comes.
    invalidate.mockClear();
    frames.read('{');
    frames.close();
    vi.advanceTimersByTime(UNREADABLE_WINDOW_MS * 2);
    expect(invalidate).not.toHaveBeenCalled();
    client.clear();
  });
});

describe('cancellation', () => {
  it('rejects a cancelled request with its abort, not as an unreachable server', async () => {
    const controller = new AbortController();

    vi.stubGlobal('fetch', (_path: string, init?: RequestInit) =>
      Promise.reject(
        init?.signal?.aborted ? new DOMException('Aborted', 'AbortError') : new Error(),
      ),
    );
    controller.abort();

    await expect(api('/api/status', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(api('/api/status')).rejects.toThrow('not reachable');
  });

  it('writes nothing from a status poll cancelled after its answer arrived', async () => {
    const client = new QueryClient();
    let answer: ((response: Response) => void) | null = null;

    // The answer comes, but only once the poll has been cancelled.
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );

    const poll = readStatus(client).catch(() => undefined);

    await vi.waitFor(() => expect(answer).not.toBeNull());
    await client.cancelQueries({ queryKey: ['status-poll'] });
    answer!({
      ok: true,
      status: 200,
      json: async () => ({ account: { login: 'me' }, revision: 1 }),
    } as Response);
    await poll;
    // The cancelled read settles at once; its own work goes on after it, and is let finish.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.getQueryData(queryKeys.status)).toBeUndefined();
    client.clear();
  });
});
