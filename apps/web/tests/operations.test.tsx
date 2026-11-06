// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiffManifest } from '@review-desk/shared/diff';
import { githubCommand } from '@/lib/operation-command';
import { useReview } from '@/features/review/use-review';

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
