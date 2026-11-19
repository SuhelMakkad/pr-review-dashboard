// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiffManifest } from '@review-desk/shared/diff';
import { adoptStatus } from '@/lib/live';
import { githubCommand } from '@/lib/operation-command';
import { useSyncNow } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';
import {
  canMarkViewed,
  diffView,
  linesShown,
  useReview,
  viewedTarget,
} from '@/features/review/use-review';
import { status } from '@test/fixtures';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const response = (body: unknown) => ({ ok: true, status: 202, json: async () => body }) as Response;

it('reuses the command ID after a lost acceptance response and creates a new ID for a later action', async () => {
  const ids: string[] = [];
  const fetch = vi.fn(async (_path: string, options: RequestInit) => {
    const { operationId } = JSON.parse(String(options.body));
    ids.push(operationId);
    if (ids.length === 1) throw new TypeError('Connection closed after acceptance');

    return response({ operation: { id: operationId } });
  });
  vi.stubGlobal('fetch', fetch);
  const path = `/api/test/${crypto.randomUUID()}`;

  await expect(githubCommand(path, { account: 'you', body: 'Saved reply' })).rejects.toThrow(
    'not reachable',
  );
  await githubCommand(path, { account: 'you', body: 'Saved reply' });
  await githubCommand(path, { account: 'you', body: 'Saved reply' });

  expect(ids[0]).toBe(ids[1]);
  expect(ids[2]).not.toBe(ids[1]);
});

it('rolls back a rejected viewed update without undoing a newer change on another file', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const writes: {
    body: { path: string };
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }[] = [];
  vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
    if (path.includes('/viewed'))
      return new Promise<Response>((resolve, reject) =>
        writes.push({ body: JSON.parse(String(options?.body)), resolve, reject }),
      );
    if (path.startsWith('/api/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(
      response({ body: '', event: 'COMMENT', comments: [], githubPendingReview: null }),
    );
  });
  const key = ['diff', 'pr-one', 'full'];
  client.setQueryData(key, {
    files: [
      { path: 'a.ts', viewed: 'UNVIEWED' },
      { path: 'b.ts', viewed: 'UNVIEWED' },
    ],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useReview('pr-one', 'you'), { wrapper });

  try {
    act(() => hook.result.current.setViewed.mutate({ path: 'a.ts', viewed: true }));
    await waitFor(() => expect(writes).toHaveLength(1));
    act(() => hook.result.current.setViewed.mutate({ path: 'b.ts', viewed: true }));
    await waitFor(() => expect(writes).toHaveLength(2));

    await act(async () => {
      writes[1].resolve(response({ operation: { id: 'second' } }));
    });
    await act(async () => {
      writes[0].reject(new Error('First request rejected'));
    });

    await waitFor(() =>
      expect(client.getQueryData<DiffManifest>(key)?.files.map((file) => file.viewed)).toEqual([
        'UNVIEWED',
        'VIEWED',
      ]),
    );
  } finally {
    client.clear();
  }
});

it('names the diff the workspace renders, even when the PR detail is a revision ahead', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const bodies: unknown[] = [];

  vi.stubGlobal('fetch', (path: string, options?: RequestInit) => {
    if (path.includes('/viewed')) bodies.push(JSON.parse(String(options?.body)));
    if (path.startsWith('/api/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(response({ operation: { id: 'viewed' } }));
  });

  // The detail already has revision B; the rendered diff is still A, and another view shows B.
  const shown = ['diff', 'pr-one', 'full'];
  const newer = ['diff', 'pr-one', 'since'];
  const revision = (head: string) => ({ headOid: head.repeat(40), baseOid: 'c'.repeat(40) });

  client.setQueryData(queryKeys.detail('pr-one'), {
    account: 'you',
    snapshot: { ...revision('b'), files: [{ path: 'a.ts', viewedKey: 'diff-b' }] },
  });
  client.setQueryData(shown, {
    revision: revision('a'),
    files: [{ path: 'a.ts', viewed: 'UNVIEWED', viewedKey: 'diff-a' }],
  });
  client.setQueryData(newer, {
    revision: revision('b'),
    files: [{ path: 'a.ts', viewed: 'UNVIEWED', viewedKey: 'diff-b' }],
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useReview('pr-one', 'you'), { wrapper });

  try {
    const target = viewedTarget(client.getQueryData<DiffManifest>(shown)!, 'a.ts');

    act(() => hook.result.current.setViewed.mutate({ path: 'a.ts', viewed: true, target }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      path: 'a.ts',
      viewed: true,
      target: { headOid: 'a'.repeat(40), baseOid: 'c'.repeat(40), fileKey: 'diff-a' },
    });

    // Shown as viewed only where that diff is rendered.
    expect(client.getQueryData<DiffManifest>(shown)?.files[0].viewed).toBe('VIEWED');
    expect(client.getQueryData<DiffManifest>(newer)?.files[0].viewed).toBe('UNVIEWED');
  } finally {
    client.clear();
  }
});

it('leaves a view refreshed to a newer diff alone when an older mark fails', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reject!: (error: Error) => void;

  vi.stubGlobal('fetch', (path: string) => {
    if (path.includes('/viewed')) return new Promise<Response>((_, fail) => (reject = fail));
    if (path.startsWith('/api/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(response({ operation: { id: 'viewed' } }));
  });

  const key = ['diff', 'pr-one', 'full'];
  const revision = (head: string) => ({ headOid: head.repeat(40), baseOid: 'c'.repeat(40) });

  client.setQueryData(key, {
    revision: revision('a'),
    files: [{ path: 'a.ts', viewed: 'VIEWED', viewedKey: 'diff-a' }],
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useReview('pr-one', 'you'), { wrapper });

  try {
    const target = viewedTarget(client.getQueryData<DiffManifest>(key)!, 'a.ts');

    act(() => hook.result.current.setViewed.mutate({ path: 'a.ts', viewed: false, target }));
    await waitFor(() => expect(reject).toBeTypeOf('function'));

    // The view refreshes to the next revision, where the file changed since you viewed it.
    client.setQueryData(key, {
      revision: revision('b'),
      files: [{ path: 'a.ts', viewed: 'DISMISSED', viewedKey: 'diff-b' }],
    });
    await act(async () => reject(new Error('Unmark rejected')));

    expect(client.getQueryData<DiffManifest>(key)?.files[0].viewed).toBe('DISMISSED');
  } finally {
    client.clear();
  }
});

it('does not let an older viewed failure roll back a newer choice for the same file', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const writes: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  vi.stubGlobal('fetch', (path: string) => {
    if (path.includes('/viewed'))
      return new Promise<Response>((resolve, reject) => writes.push({ resolve, reject }));
    if (path.startsWith('/api/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(
      response({ body: '', event: 'COMMENT', comments: [], githubPendingReview: null }),
    );
  });
  const key = ['diff', 'pr-two', 'full'];
  client.setQueryData(key, { files: [{ path: 'a.ts', viewed: 'VIEWED' }] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useReview('pr-two', 'you'), { wrapper });

  try {
    act(() => hook.result.current.setViewed.mutate({ path: 'a.ts', viewed: false }));
    await waitFor(() => expect(writes).toHaveLength(1));
    act(() => hook.result.current.setViewed.mutate({ path: 'a.ts', viewed: true }));
    await waitFor(() => expect(writes).toHaveLength(2));

    await act(async () => {
      writes[1].resolve(response({ operation: { id: 'newest' } }));
    });
    await act(async () => {
      writes[0].reject(new Error('Older request rejected'));
    });

    await waitFor(() =>
      expect(client.getQueryData<DiffManifest>(key)?.files[0].viewed).toBe('VIEWED'),
    );
  } finally {
    client.clear();
  }
});

it.each([
  ['a switch in this window', 'status'],
  ['another window, whose diff arrives before any status', 'data'],
] as const)(
  "does not roll a rejected viewed update back into another account's diff after %s",
  async (_, through) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reject: (error: Error) => void = () => {};
    vi.stubGlobal('fetch', (path: string) => {
      if (path.includes('/viewed')) return new Promise<Response>((_, fail) => (reject = fail));
      if (path.startsWith('/api/operations'))
        return Promise.resolve(response({ items: [], nextCursor: null }));

      return Promise.resolve(
        response({ body: '', event: 'COMMENT', comments: [], githubPendingReview: null }),
      );
    });
    const key = ['diff', 'pr-one', 'full'];
    client.setQueryData(queryKeys.status, status({ account: { login: 'you' } }));
    client.setQueryData(key, { account: 'you', files: [{ path: 'a.ts', viewed: 'UNVIEWED' }] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useReview('pr-one', 'you'), { wrapper });
    const viewed = () => client.getQueryData<DiffManifest>(key)?.files[0].viewed;

    try {
      act(() => hook.result.current.setViewed.mutate({ path: 'a.ts', viewed: true }));
      await waitFor(() => expect(viewed()).toBe('VIEWED'));

      // The switch happens while the write is pending; the other account viewed the same file.
      if (through === 'status')
        act(() => adoptStatus(client, status({ account: { login: 'other' } })));
      client.setQueryData(key, { account: 'other', files: [{ path: 'a.ts', viewed: 'VIEWED' }] });
      await act(async () => reject(new Error('Rejected after the switch')));

      await waitFor(() => expect(hook.result.current.setViewed.isError).toBe(true));
      expect(viewed()).toBe('VIEWED');
    } finally {
      client.clear();
    }
  },
);

it('keeps the new account when a sync reply from before a switch arrives', async () => {
  const client = new QueryClient();
  let answer: (() => void) | null = null;
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        answer = () => resolve(response(status({ account: { login: 'you' } })));
      }),
  );
  client.setQueryData(queryKeys.status, status({ account: { login: 'you' } }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSyncNow(), { wrapper });

  try {
    act(() => hook.result.current.mutate());
    await waitFor(() => expect(answer).not.toBeNull());
    act(() => adoptStatus(client, status({ account: { login: 'other' } })));
    await act(async () => answer!());

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(client.getQueryData(queryKeys.status)).toMatchObject({ account: { login: 'other' } });
  } finally {
    client.clear();
  }
});

it('marks a file viewed only where the view can say which diff it shows', () => {
  const revision = { headOid: 'a'.repeat(40), baseOid: null };

  expect(
    canMarkViewed({ revision, files: [{ path: 'a.ts' }] } as unknown as DiffManifest, 'a.ts'),
  ).toBe(true);
  expect(
    canMarkViewed(
      {
        revision,
        keyed: true,
        files: [{ path: 'a.ts', viewedKey: 'diff-a' }],
      } as unknown as DiffManifest,
      'a.ts',
    ),
  ).toBe(true);
  expect(
    canMarkViewed(
      { revision, keyed: true, files: [{ path: 'a.ts' }] } as unknown as DiffManifest,
      'a.ts',
    ),
  ).toBe(false);
  expect(canMarkViewed(undefined, 'a.ts')).toBe(false);
});

it('takes selected lines only from the patch they were selected in', () => {
  const manifest = (head: string, changes: Partial<DiffManifest> = {}): DiffManifest => ({
    prId: 'pr',
    revision: { headOid: head.repeat(40), baseOid: 'c'.repeat(40) },
    mode: 'full',
    kind: 'full',
    fromOid: 'c'.repeat(40),
    toOid: head.repeat(40),
    files: [],
    ...changes,
  });
  const selected = { path: 'a.ts', view: diffView(manifest('a')) };

  expect(linesShown(selected, 'a.ts', manifest('a'))).toBe(true);
  // The same file, refreshed to the next revision before the composer opened.
  expect(linesShown(selected, 'a.ts', manifest('b'))).toBe(false);
  // Another file, or the same revision compared from your last review.
  expect(linesShown(selected, 'b.ts', manifest('a'))).toBe(false);
  expect(
    linesShown(selected, 'a.ts', manifest('a', { mode: 'since-review', fromOid: 'd'.repeat(40) })),
  ).toBe(false);
  // The live patch shown while the revision's own could not be confirmed names no patch: lines
  // selected there are not taken once the confirmed patch for that revision comes back.
  const unpinned = manifest('a', { unpinned: true });

  expect(diffView(unpinned)).toBeUndefined();
  expect(linesShown({ path: 'a.ts', view: diffView(unpinned) }, 'a.ts', manifest('a'))).toBe(false);
  expect(linesShown(selected, 'a.ts', unpinned)).toBe(false);
});
