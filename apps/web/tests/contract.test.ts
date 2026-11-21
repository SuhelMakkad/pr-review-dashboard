// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
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
  it('read everything again after the first of them, once per window, and not once closed', () => {
    vi.useFakeTimers();

    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const frames = frameReader(client);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.setQueryData(['anything'], 1);
    frames.read('not json');
    vi.advanceTimersByTime(UNREADABLE_WINDOW_MS - 50);
    // Joins the refresh already due, which comes after it.
    frames.read(JSON.stringify({ type: 'pulls.changed', account: 'me' }));
    vi.advanceTimersByTime(49);
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

  it('keep refreshing through a burst that never stops', () => {
    vi.useFakeTimers();

    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const frames = frameReader(client);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.setQueryData(['anything'], 1);

    // One unreadable frame every 200 ms for a second: windows at 0, 400 and 800 ms.
    for (let at = 0; at <= 800; at += 200) {
      frames.read('not json');
      vi.advanceTimersByTime(200);
    }

    vi.advanceTimersByTime(UNREADABLE_WINDOW_MS);
    expect(invalidate).toHaveBeenCalledTimes(3);
    frames.close();
    client.clear();
  });

  it.each([
    ['a status', { type: 'status', status: {} }],
    ['a notification', { type: 'notify', notifications: [{}] }],
  ])('read everything again rather than show %s of the wrong shape', (_case, frame) => {
    vi.useFakeTimers();

    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const frames = frameReader(client);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.setQueryData(['anything'], 1);
    frames.read(JSON.stringify(frame));
    vi.advanceTimersByTime(UNREADABLE_WINDOW_MS);

    expect(client.getQueryData(queryKeys.status)).toBeUndefined();
    expect(invalidate).toHaveBeenCalled();
    frames.close();
    client.clear();
  });

  it('let a slow read finish through a burst, and read it once more when it lands', async () => {
    vi.useFakeTimers();

    const client = new QueryClient();
    const frames = frameReader(client);
    let reads = 0;
    let aborted = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['slow'],
      queryFn: ({ signal }) => {
        reads += 1;
        signal.addEventListener('abort', () => (aborted += 1));

        // The first read is quick; each read again takes four windows.
        return new Promise<number>((resolve) =>
          setTimeout(() => resolve(reads), reads === 1 ? 0 : UNREADABLE_WINDOW_MS * 4),
        );
      },
    });
    const unsubscribe = observer.subscribe(() => {});

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(1);

    // An unreadable frame every 200 ms for 1.2 s: recoveries keep coming while the read is slow.
    for (let at = 0; at < 1200; at += 200) {
      frames.read('not json');
      await vi.advanceTimersByTimeAsync(200);
    }

    await vi.advanceTimersByTimeAsync(UNREADABLE_WINDOW_MS * 12);

    expect(aborted).toBe(0);
    // The first recovery's read, then one more after it lands, for the frames during it.
    expect(reads).toBe(3);
    expect(observer.getCurrentResult().data).toBe(3);
    unsubscribe();
    frames.close();
    client.clear();
  });
});

describe('saved command IDs', () => {
  it('sends the ID saved for an action again through the contract', async () => {
    const { pathOf: built } = await import('@/lib/call');
    const params = { account: 'me', id: 'p1' };

    localStorage.setItem(
      'review-desk-pending-command-ids',
      JSON.stringify([
        [
          JSON.stringify({
            path: built(routes.viewed, params),
            body: { path: 'a.ts', viewed: true },
            method: 'POST',
          }),
          'saved-id',
        ],
      ]),
    );
    vi.resetModules();

    const { command } = await import('@/lib/call');
    const { routes: fresh } = await import('@review-desk/shared/contract');
    const sent: string[] = [];

    vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).operationId);

      return { ok: true, status: 202, json: async () => ({ operation: { id: sent.at(-1) } }) };
    });

    await command(fresh.viewed, params, { path: 'a.ts', viewed: true });

    expect(sent).toEqual(['saved-id']);
    localStorage.clear();
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
