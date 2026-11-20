// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { Query, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffManifest } from '@review-desk/shared/diff';
import { adoptStatus } from '@/lib/live';
import { githubCommand } from '@/lib/operation-command';
import { useStatus, useSyncNow } from '@/lib/queries';
import { Notes } from '@/features/pulls/notes';
import { queryKeys } from '@/lib/query-keys';
import {
  canMarkViewed,
  diffView,
  linesShown,
  useReview,
  viewedTarget,
} from '@/features/review/use-review';
import { status } from '@test/fixtures';
import { defaultAiSettings } from '@review-desk/shared/ai';
import { withSaved } from '@/features/settings/pages/automation';

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
    if (path.includes('/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(
      response({ body: '', event: 'COMMENT', comments: [], githubPendingReview: null }),
    );
  });
  const key = queryKeys.diff('you', 'pr-one', 'full');
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
    if (path.includes('/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(response({ operation: { id: 'viewed' } }));
  });

  // The detail already has revision B; the rendered diff is still A, and another view shows B.
  const shown = queryKeys.diff('you', 'pr-one', 'full');
  const newer = queryKeys.diff('you', 'pr-one', 'since');
  const revision = (head: string) => ({ headOid: head.repeat(40), baseOid: 'c'.repeat(40) });

  client.setQueryData(queryKeys.detail('you', 'pr-one'), {
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
    if (path.includes('/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(response({ operation: { id: 'viewed' } }));
  });

  const key = queryKeys.diff('you', 'pr-one', 'full');
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
    if (path.includes('/operations'))
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

it("rolls a rejected viewed update back only in its own account's diff, after a switch", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reject: (error: Error) => void = () => {};
  vi.stubGlobal('fetch', (path: string) => {
    if (path.includes('/viewed')) return new Promise<Response>((_, fail) => (reject = fail));
    if (path.includes('/operations'))
      return Promise.resolve(response({ items: [], nextCursor: null }));

    return Promise.resolve(
      response({ body: '', event: 'COMMENT', comments: [], githubPendingReview: null }),
    );
  });
  const yours = queryKeys.diff('you', 'pr-one', 'full');
  const theirs = queryKeys.diff('other', 'pr-one', 'full');
  client.setQueryData(queryKeys.status, status({ account: { login: 'you' }, revision: 1 }));
  client.setQueryData(yours, { account: 'you', files: [{ path: 'a.ts', viewed: 'UNVIEWED' }] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useReview('pr-one', 'you'), { wrapper });
  const viewed = (key: readonly unknown[]) =>
    client.getQueryData<DiffManifest>(key)?.files[0].viewed;

  try {
    act(() => hook.result.current.setViewed.mutate({ path: 'a.ts', viewed: true }));
    await waitFor(() => expect(viewed(yours)).toBe('VIEWED'));

    // The switch happens while the write is pending; the other account viewed the same file.
    act(() => adoptStatus(client, status({ account: { login: 'other' }, revision: 2 })));
    client.setQueryData(theirs, { account: 'other', files: [{ path: 'a.ts', viewed: 'VIEWED' }] });
    await act(async () => reject(new Error('Rejected after the switch')));

    await waitFor(() => expect(hook.result.current.setViewed.isError).toBe(true));
    expect(viewed(yours)).toBe('UNVIEWED');
    expect(viewed(theirs)).toBe('VIEWED');
  } finally {
    client.clear();
  }
});

it('keeps the new account when a sync reply from before a switch arrives', async () => {
  const client = new QueryClient();
  let answer: (() => void) | null = null;
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        // Sent before the switch: the server numbered it before the switch's status.
        answer = () => resolve(response(status({ account: { login: 'you' }, revision: 2 })));
      }),
  );
  client.setQueryData(queryKeys.status, status({ account: { login: 'you' }, revision: 1 }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSyncNow(), { wrapper });

  try {
    act(() => hook.result.current.mutate());
    await waitFor(() => expect(answer).not.toBeNull());
    act(() => adoptStatus(client, status({ account: { login: 'other' }, revision: 3 })));
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

it('shows only the saved switch from a save’s reply, so a late reply cannot undo a later save', () => {
  const settings = {
    ...defaultAiSettings(),
    postFindings: true,
    approveFindings: true,
    autoReview: { enabled: false, since: null },
  };
  // An automatic-review save sent before approval was turned on, answered after it.
  const late = {
    ...defaultAiSettings(),
    postFindings: true,
    approveFindings: false,
    autoReview: { enabled: true, since: '2026-11-20T10:00:00.000Z' },
  };

  expect(withSaved(settings, late, 'autoReview')).toEqual({
    ...settings,
    autoReview: late.autoReview,
  });
  expect(withSaved(settings, { ...late, approveFindings: true }, 'approveFindings')).toEqual(
    settings,
  );
});

describe('the private note', () => {
  it('keeps the text you went back to while an older save is still on its way', async () => {
    const sent: string[] = [];
    const releases = new Map<string, () => void>();
    const onSave = vi.fn(async (note: string) => {
      sent.push(note);
      await new Promise<void>((resolve) => releases.set(note, resolve));
    });
    const view = render(<Notes account="you" id="pr-two" saved="A" onSave={onSave} />);
    const box = () => screen.getByRole('textbox', { name: 'Private note' });
    const showSaved = (note: string) =>
      view.rerender(<Notes account="you" id="pr-two" saved={note} onSave={onSave} />);

    // B is typed and its save is held; then A, the saved text, is typed back.
    fireEvent.change(box(), { target: { value: 'B' } });
    await waitFor(() => expect(sent).toEqual(['B']), { timeout: 2_000 });
    fireEvent.change(box(), { target: { value: 'A' } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));

    // Only B is on its way: A waits for it.
    expect(sent).toEqual(['B']);

    // B lands and the server shows it, while A's save is on its way: the editor keeps A.
    await act(async () => releases.get('B')!());
    await waitFor(() => expect(sent).toEqual(['B', 'A']));
    showSaved('B');
    expect(box()).toHaveValue('A');

    // A lands and the server shows it: the editor is clean, and follows the next saved note.
    await act(async () => releases.get('A')!());
    showSaved('A');
    showSaved('C');
    await waitFor(() => expect(box()).toHaveValue('C'));
    expect(sent).toEqual(['B', 'A']);
  });

  it('acknowledges a save whose saved note arrives before its reply, and joins one queue across editors', async () => {
    const sent: string[] = [];
    const releases = new Map<string, () => void>();
    const onSave = vi.fn(async (note: string) => {
      sent.push(note);
      await new Promise<void>((resolve) => releases.set(note, resolve));
    });
    const first = render(<Notes account="you" id="pr-three" saved="" onSave={onSave} />);
    const box = () => screen.getByRole('textbox', { name: 'Private note' });

    fireEvent.change(box(), { target: { value: 'One' } });
    await waitFor(() => expect(sent).toEqual(['One']), { timeout: 2_000 });

    // The editor goes away (a switch) and another opens for the same PR: its save waits for the
    // first one, whatever order their replies would come in.
    first.unmount();

    const second = render(<Notes account="you" id="pr-three" saved="One" onSave={onSave} />);

    fireEvent.change(box(), { target: { value: 'Two' } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
    expect(sent).toEqual(['One']);

    await act(async () => releases.get('One')!());
    await waitFor(() => expect(sent).toEqual(['One', 'Two']));

    // The server's note shows Two before Two's reply: once the reply comes, the editor is clean
    // and follows a newer note from elsewhere.
    second.rerender(<Notes account="you" id="pr-three" saved="Two" onSave={onSave} />);
    await act(async () => releases.get('Two')!());
    second.rerender(<Notes account="you" id="pr-three" saved="Three" onSave={onSave} />);

    await waitFor(() => expect(box()).toHaveValue('Three'));
    expect(sent).toEqual(['One', 'Two']);
  });

  it('drops the draft of a save that lands after its editor closed, never saving it again', async () => {
    let release: () => void = () => {};
    const onSave = vi.fn(
      (_note: string) => new Promise<void>((resolve) => (release = () => resolve())),
    );
    const first = render(<Notes account="you" id="pr-four" saved="" onSave={onSave} />);
    const box = () => screen.getByRole('textbox', { name: 'Private note' });

    fireEvent.change(box(), { target: { value: 'Held' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Held'), { timeout: 2_000 });

    // The editor closes (a switch away), then the save lands.
    first.unmount();
    await act(async () => release());

    expect(sessionStorage.getItem('review-desk-draft:you:pr-four')).toBeNull();

    // Another window has saved a newer note by the time the editor opens again: it shows that one,
    // and saves nothing.
    render(<Notes account="you" id="pr-four" saved="Newer" onSave={onSave} />);
    expect(box()).toHaveValue('Newer');
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed save as an edit, even when the stale saved note matches it', async () => {
    const releases = new Map<string, { resolve: () => void; reject: () => void }>();
    const onSave = vi.fn(
      (note: string) =>
        new Promise<void>((resolve, reject) =>
          releases.set(note, { resolve, reject: () => reject(new Error('Refused')) }),
        ),
    );
    const view = render(<Notes account="you" id="pr-five" saved="A" onSave={onSave} />);
    const box = () => screen.getByRole('textbox', { name: 'Private note' });

    fireEvent.change(box(), { target: { value: 'B' } });
    await waitFor(() => expect(releases.has('B')).toBe(true), { timeout: 2_000 });
    fireEvent.change(box(), { target: { value: 'A' } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));

    // B is saved; A's save, after it, fails, while the cached note still says A.
    await act(async () => releases.get('B')!.resolve());
    await waitFor(() => expect(releases.has('A')).toBe(true));
    await act(async () => releases.get('A')!.reject());

    expect(sessionStorage.getItem('review-desk-draft:you:pr-five')).toBe('A');

    // The refresh then brings B: the editor keeps your A, to save again.
    view.rerender(<Notes account="you" id="pr-five" saved="B" onSave={onSave} />);
    expect(box()).toHaveValue('A');
    await waitFor(() => expect(onSave.mock.calls.filter(([note]) => note === 'A').length).toBe(2), {
      timeout: 2_000,
    });
  });

  it('forgets a failed edit once you go back to the saved text', async () => {
    let fail = true;
    const onSave = vi.fn(async () => {
      if (fail) throw new Error('Refused');
    });
    const first = render(<Notes account="you" id="pr-six" saved="Original" onSave={onSave} />);
    const box = () => screen.getByRole('textbox', { name: 'Private note' });

    // An edit fails to save; then the saved text is typed back, and saves.
    fireEvent.change(box(), { target: { value: 'Draft' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Draft'), { timeout: 2_000 });
    fail = false;
    fireEvent.change(box(), { target: { value: 'Original' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Original'), { timeout: 2_000 });
    await waitFor(() => expect(sessionStorage.getItem('review-desk-draft:you:pr-six')).toBeNull());

    // Reopened, the editor shows the saved text and sends nothing: the discarded edit is gone.
    first.unmount();
    render(<Notes account="you" id="pr-six" saved="Original" onSave={onSave} />);
    expect(box()).toHaveValue('Original');
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('confirms a save in an editor opened while it was on its way', async () => {
    let release: () => void = () => {};
    const onSave = vi.fn(
      (_note: string) => new Promise<void>((resolve) => (release = () => resolve())),
    );
    const first = render(<Notes account="you" id="pr-seven" saved="" onSave={onSave} />);
    const box = () => screen.getByRole('textbox', { name: 'Private note' });

    fireEvent.change(box(), { target: { value: 'One' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('One'), { timeout: 2_000 });

    // The editor closes and opens again before the reply, with the older note still cached.
    first.unmount();

    const second = render(<Notes account="you" id="pr-seven" saved="" onSave={onSave} />);

    expect(box()).toHaveValue('One');

    // The reply comes, and another window has saved Two since: the editor shows it, and never
    // sends One again.
    await act(async () => release());
    second.rerender(<Notes account="you" id="pr-seven" saved="Two" onSave={onSave} />);
    expect(box()).toHaveValue('Two');
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('follows a newer saved note until you type, and saves only what you typed', async () => {
    const onSave = vi.fn(async () => undefined);
    const view = render(<Notes account="you" id="pr-one" saved="Older note" onSave={onSave} />);
    const box = () => screen.getByRole('textbox', { name: 'Private note' });

    // A fresher copy arrives (another window, or this account's own after a switch back).
    view.rerender(<Notes account="you" id="pr-one" saved="Newer note" onSave={onSave} />);
    await waitFor(() => expect(box()).toHaveValue('Newer note'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
    expect(onSave).not.toHaveBeenCalled();

    // Typed here: kept, and saved, whatever arrives meanwhile.
    fireEvent.change(box(), { target: { value: 'Mine' } });
    view.rerender(<Notes account="you" id="pr-one" saved="Someone else's" onSave={onSave} />);
    expect(box()).toHaveValue('Mine');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Mine'), { timeout: 2_000 });
  });
});

describe('the status shown', () => {
  it('keeps a newer status adopted while a poll’s result is being committed', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const commit = Query.prototype.setData;
    let interleaved = false;

    vi.stubGlobal('fetch', () =>
      Promise.resolve(response(status({ account: { login: 'you' }, revision: 8 }))),
    );
    // Just before the poll's result is written into its query, a switch's status arrives.
    const spy = vi.spyOn(Query.prototype, 'setData').mockImplementation(function (
      this: Query,
      ...args: Parameters<Query['setData']>
    ) {
      // The fetch's own result, not a write made by hand (`setQueryData`) while it was on its way.
      const polled = this.state.fetchStatus === 'fetching' && !args[1]?.manual;

      if (polled && !interleaved) {
        interleaved = true;
        adoptStatus(client, status({ account: { login: 'other' }, revision: 9 }));
      }

      return commit.apply(this, args);
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useStatus(), { wrapper });

    try {
      await waitFor(() => expect(interleaved).toBe(true));
      await waitFor(() => expect(client.isFetching()).toBe(0));

      expect(hook.result.current.data).toMatchObject({ account: { login: 'other' }, revision: 9 });
    } finally {
      spy.mockRestore();
      client.clear();
    }
  });

  it('is never moved back by a poll that left before a newer status', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let answer: () => void = () => {};

    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(response(status({ account: { login: 'you' }, revision: 8 })));
        }),
    );

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useStatus(), { wrapper });

    try {
      // The poll is on its way when a switch's status arrives.
      await waitFor(() => expect(client.isFetching({ queryKey: ['status-poll'] })).toBe(1));
      act(() => adoptStatus(client, status({ account: { login: 'other' }, revision: 9 })));
      await act(async () => answer());
      await waitFor(() => expect(client.isFetching({ queryKey: ['status-poll'] })).toBe(0));

      expect(hook.result.current.data).toMatchObject({ account: { login: 'other' }, revision: 9 });
    } finally {
      client.clear();
    }
  });
});
