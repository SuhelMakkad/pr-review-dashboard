// @vitest-environment jsdom
import { queryKeys } from '@/lib/query-keys';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from '@/router';
import { resetInboxAutoSelect } from '@/features/inbox/inbox-page';
import { deriveItem, emptyTriage } from '@review-desk/shared/attention';
import { defaultAiSettings } from '@review-desk/shared/ai';
import { defaultNotificationSettings } from '@review-desk/shared/notify';
import type { LocalTriageState, PullRequestSnapshot } from '@review-desk/shared/types';
import { review, snapshot, status } from '@test/fixtures';

// The Insights page always crashes here, standing in for any page that throws while rendering.
vi.mock('@/features/insights/insights-page', () => ({
  InsightsPage: () => {
    throw new Error('Insights exploded');
  },
}));

/** While `frame` is set, the status bar throws, so the app frame itself crashes. */
const crash = vi.hoisted(() => ({ frame: false }));

vi.mock('@/features/shell/status-bar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/shell/status-bar')>();

  return {
    ...actual,
    StatusBar: (props: Parameters<typeof actual.StatusBar>[0]) => {
      if (crash.frame) throw new Error('Status bar exploded');

      return <actual.StatusBar {...props} />;
    },
  };
});

const followUp = snapshot({
  id: 'follow',
  number: 2,
  title: 'Follow up after code changes',
  headOid: 'changed',
  repository: 'acme/another',
  author: { login: 'bob' },
  reviews: [review({ commitOid: 'old' })],
});
const firstReview = snapshot({
  id: 'first',
  number: 1,
  title: 'First review needed',
  reviews: [],
  sources: ['requested'],
});
const caughtUp = snapshot({ id: 'quiet', number: 3, title: 'Already approved and quiet' });
const snapshots = [followUp, firstReview, caughtUp];
/** The account the mock server works as; both accounts track the same PRs. */
let account = 'me';
/** Local triage per account and PR, keyed `account:id`. */
let triage: Record<string, LocalTriageState> = {};
/** While set, triage writes are saved at once but answered only when it resolves. */
let heldReply: Promise<void> | null = null;
/** While set, the status still names this account: news of a switch has not reached it yet. */
let laggingStatus: string | null = null;
/** How the status answers: as usual, as a failed request, or with no account signed in. */
let statusAnswer: 'ok' | 'fails' | 'signed out' = 'ok';
let writes: { id: string; body: Record<string, unknown> }[] = [];
/** PRs added by hand through `POST /api/pulls/track`, and every queue change sent. */
let added: PullRequestSnapshot[] = [];
let queueChanges: { method: string; path: string; body: Record<string, unknown> }[] = [];
const clients: QueryClient[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetInboxAutoSelect();
  account = 'me';
  heldReply = null;
  laggingStatus = null;
  statusAnswer = 'ok';
  triage = {};
  writes = [];
  added = [];
  queueChanges = [];
  firstReview.body = 'A useful **description**.';
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (requested: string, options?: RequestInit) => {
      // Like the server: `/api/accounts/<account>/…` serves the account it names, whichever is
      // selected; the legacy routes serve the selected one.
      const scoped = /^\/api\/accounts\/([^/]+)(\/.+)$/.exec(requested);
      const who = scoped ? decodeURIComponent(scoped[1]) : account;
      const path = scoped ? `/api${scoped[2]}` : requested;
      const state = (id: string) => triage[`${who}:${id}`] ?? emptyTriage();
      let data: unknown;

      if (path === '/api/mine') {
        data = { account: who, items: [] };
      } else if (path === '/api/accounts') {
        data = {
          switchable: true,
          accounts: ['me', 'other'].map((login) => ({
            login,
            current: login === account,
            cliActive: login === 'me',
            ok: true,
            inProgress: 0,
          })),
        };
      } else if (path === '/api/accounts/switch') {
        account = JSON.parse(String(options?.body)).to;
        data = { ...status(), account: { login: account } };
      } else if (path.startsWith('/api/operations')) {
        data = { items: [], nextCursor: null };
      } else if (path === '/api/ai') {
        data = { settings: defaultAiSettings(), providers: [] };
      } else if (/^\/api\/pulls\/[^/]+\/ai/.test(path)) {
        data = { runs: [] };
      } else if (/^\/api\/pulls\/[^/]+\/tickets/.test(path)) {
        data = { identifiers: [], issues: [], error: null };
      } else if (path === '/api/notifications/settings') {
        data = defaultNotificationSettings();
      } else if (path === '/api/linear/status') {
        data = {
          configured: false,
          connected: false,
          workspace: null,
          teamKeys: [],
          error: null,
          setupCommand: '',
        };
      } else if (path === '/api/status' && statusAnswer === 'fails') {
        return { ok: false, status: 503, json: async () => ({ error: 'Server unavailable' }) };
      } else if (path === '/api/status' && statusAnswer === 'signed out') {
        data = { ...status(), account: null };
      } else if (path === '/api/status') {
        data = {
          ...status(),
          account: { login: laggingStatus ?? account },
          lastSuccessfulSync: new Date().toISOString(),
        };
      } else if (path === '/api/pulls') {
        data = {
          account: who,
          items: [...snapshots, ...added].map((pr) => deriveItem(pr, state(pr.id), who, [])),
        };
      } else if (path === '/api/pulls/track') {
        const body = JSON.parse(String(options?.body));
        const pr = snapshot({
          id: 'added',
          number: body.number,
          repository: body.repository,
          url: `https://github.com/${body.repository}/pull/${body.number}`,
          title: 'Added by hand',
          author: { login: 'carol' },
          sources: ['manual'],
          reviews: [],
        });

        queueChanges.push({ method: 'POST', path, body });
        added = [pr];
        data = {
          account,
          snapshot: pr,
          item: deriveItem(pr, state(pr.id), account, []),
          triage: state(pr.id),
        };
      } else if (/^\/api\/pulls\/[^/]+\/draft(\?|$)/.test(path)) {
        data = {
          prId: decodeURIComponent(path.split('/')[3]),
          body: '',
          event: 'COMMENT',
          comments: [],
          updatedAt: null,
          githubPendingReview: null,
        };
      } else if (path.endsWith('/track') && options?.method === 'DELETE') {
        queueChanges.push({ method: 'DELETE', path, body: JSON.parse(String(options.body)) });
        added = [];
        data = { tracked: false };
      } else {
        const id = decodeURIComponent(path.split('/')[3]);
        const pr = [...snapshots, ...added].find((value) => value.id === id)!;

        if (options?.method === 'PATCH') {
          // A scoped write names its account in the path; a legacy one in its body.
          const body = { account: who, ...JSON.parse(String(options.body)) };
          const current = { ...state(id) };

          // Like the server: a legacy write for an account that is no longer active is refused.
          if (!scoped && body.account !== account)
            return {
              ok: false,
              status: 409,
              json: async () => ({ error: 'GitHub account changed. Refresh before updating.' }),
            };

          writes.push({ id, body });

          if (body.note !== undefined) current.note = body.note;
          if (body.done !== undefined) {
            current.doneAt = body.done ? new Date().toISOString() : null;
            current.doneActivityKeys = body.done
              ? deriveItem(pr, state(id), who, []).activityKeys
              : [];
          }

          triage[`${who}:${id}`] = current;
        }

        data = {
          account: who,
          snapshot: pr,
          item: deriveItem(pr, state(id), who, []),
          triage: state(id),
        };

        if (options?.method === 'PATCH' && heldReply) await heldReply;
      }

      return { ok: true, status: 200, json: async () => data };
    }),
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function mount(path = '/inbox/attention') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });

  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { user: userEvent.setup(), router };
}

const queue = () => screen.findByRole('listbox', { name: /needs attention pull requests/i });

describe('inbox', () => {
  it('groups follow-ups ahead of first reviews and auto-selects the first PR', async () => {
    const { router } = mount();
    const list = await queue();
    const groups = await within(list).findAllByRole('group');

    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Follow-ups',
      'First reviews',
    ]);
    expect(within(list).queryByText('Already approved and quiet')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/attention/acme/another/2'),
    );
    expect(
      await screen.findByRole('heading', { name: /Follow up after code changes/ }),
    ).toBeInTheDocument();
  });

  it('moves with j and k, closes the pane with Escape, and filters from the keyboard into the URL', async () => {
    const { user, router } = mount();

    await screen.findByRole('heading', { name: /Follow up after code changes/ });
    await user.keyboard('j');
    expect(await screen.findByRole('heading', { name: /First review needed/ })).toBeInTheDocument();

    await user.keyboard('k');
    await screen.findByRole('heading', { name: /Follow up after code changes/ });

    await user.keyboard('{Escape}');
    expect(await screen.findByText('Select a pull request')).toBeInTheDocument();

    await user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Filter pull requests' })).toHaveFocus();
    await user.keyboard('first');

    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'first' }));
    expect(
      within(await queue()).queryByText('Follow up after code changes'),
    ).not.toBeInTheDocument();
    expect(within(await queue()).getByText('First review needed')).toBeInTheDocument();
  });

  it('marks a PR done with E, advances to the next one and writes the triage update', async () => {
    const { user, router } = mount();

    await screen.findByRole('heading', { name: /Follow up after code changes/ });
    await user.keyboard('e');

    await waitFor(() =>
      expect(writes).toContainEqual({ id: 'follow', body: { account: 'me', done: true } }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/attention/acme/repo/1'),
    );
    expect(
      within(await queue()).queryByText('Follow up after code changes'),
    ).not.toBeInTheDocument();
  });

  it('does not undo with Z on an account other than the one the action was for', async () => {
    const { user } = mount();

    await screen.findByRole('heading', { name: /Follow up after code changes/ });
    await user.keyboard('e');
    await waitFor(() =>
      expect(writes).toContainEqual({ id: 'follow', body: { account: 'me', done: true } }),
    );

    screen.getByRole('button', { name: /^Switch GitHub account, now me\b/ }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: 'other' }));
    await screen.findByRole('button', { name: /^Switch GitHub account, now other\b/ });

    const before = writes.length;

    await user.keyboard('z');
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));

    expect(writes.slice(before)).toEqual([]);
    expect(triage['me:follow']?.doneAt).not.toBeNull();
  });

  it("undoes each account's own last action, and a toast only its own", async () => {
    const { user, router } = mount('/inbox/attention/acme/another/2');
    /** Marking done moves on to the next PR; this comes back to it. */
    const openFollow = async () => {
      await act(() => router.history.push('/inbox/attention/acme/another/2'));
      await screen.findByRole('heading', { name: /Follow up after code changes/ });
    };
    const switchTo = async (login: string) => {
      screen.getByRole('button', { name: /^Switch GitHub account, now / }).focus();
      await user.keyboard('{Enter}');
      await user.click(await screen.findByRole('menuitemradio', { name: login }));
      await screen.findByRole('button', {
        name: new RegExp(`^Switch GitHub account, now ${login}\\b`),
      });
    };
    const done = (login: string, value: boolean) => ({
      id: 'follow',
      body: { account: login, done: value },
    });

    await screen.findByRole('heading', { name: /Follow up after code changes/ });
    await user.keyboard('e');
    await waitFor(() => expect(writes).toContainEqual(done('me', true)));

    // `other` marks the same PR done.
    await switchTo('other');
    await openFollow();
    await user.keyboard('e');
    await waitFor(() => expect(writes).toContainEqual(done('other', true)));

    // `me`'s toast (the oldest, so the last listed), clicked while `other`'s own undo is still
    // available, does nothing. (A plain click: the toast's swipe handling needs pointer capture.)
    const before = writes.length;

    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' }).at(-1)!);
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(writes.slice(before)).toEqual([]);

    // Z undoes `other`'s action; its toast then cannot undo it a second time.
    await user.keyboard('z');
    await waitFor(() => expect(writes).toContainEqual(done('other', false)));
    expect(writes).not.toContainEqual(done('me', false));

    const undone = writes.length;

    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(writes.slice(undone)).toEqual([]);

    // Back on `me`, its own last action is still the one Z undoes.
    await switchTo('me');
    await openFollow();
    await user.keyboard('z');
    await waitFor(() => expect(writes).toContainEqual(done('me', false)));
  });

  it("shows the status's failure with a retry, and an empty queue with no account signed in", async () => {
    statusAnswer = 'fails';

    const { user } = mount();

    expect(await screen.findByText("Can't reach Review Desk")).toBeInTheDocument();

    statusAnswer = 'signed out';
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByText("Can't reach Review Desk")).toBeNull());
    expect(screen.queryByRole('heading', { name: /Follow up after code changes/ })).toBeNull();
  });

  it('autosaves a private note focused with N', async () => {
    const { user } = mount();

    await screen.findByRole('heading', { name: /Follow up after code changes/ });
    await user.keyboard('n');
    expect(screen.getByRole('textbox', { name: 'Private note' })).toHaveFocus();
    await user.keyboard('Ask about the rollback plan');

    await waitFor(() => expect(writes.at(-1)?.body.note).toBe('Ask about the rollback plan'), {
      timeout: 3000,
    });
    expect(await screen.findByText('Only on this device')).toBeInTheDocument();
  });

  it('renders untrusted Markdown without scripts, remote images, or JavaScript links', async () => {
    firstReview.body =
      '<script>alert(1)</script>\n\n![tracker](https://example.com/pixel.png)\n\n[bad](javascript:alert(1)) [ok](https://example.com)';

    mount('/inbox/attention/acme/repo/1');

    await screen.findByRole('heading', { name: /First review needed/ });

    expect(document.querySelector('script:not([src])')).toBeNull();
    expect(document.querySelector('img[src^="https://example.com"]')).toBeNull();
    expect(screen.getByText(/\[Image: tracker\]/)).toBeInTheDocument();
    expect(screen.getByText('bad').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://example.com');
  });
});

describe('adding PRs by hand', () => {
  it('adds an untracked PR from the Not tracked screen, then removes it again', async () => {
    const { user } = mount('/inbox/attention/acme/web/77');

    expect(await screen.findByText('Not tracked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to review queue' }));

    expect(await screen.findByRole('heading', { name: /Added by hand/ })).toBeInTheDocument();
    expect(queueChanges).toEqual([
      {
        method: 'POST',
        path: '/api/pulls/track',
        body: { account: 'me', repository: 'acme/web', number: 77 },
      },
    ]);
    expect(screen.getByText(/Tracked because you added it/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove from queue' }));

    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).queryByText('Added by hand')).toBeNull(),
    );
    expect(queueChanges[1]).toEqual({
      method: 'DELETE',
      path: '/api/pulls/added/track',
      body: { account: 'me' },
    });
  });

  it('adds a PR from the inbox header and opens it', async () => {
    const { user, router } = mount();

    await queue();
    await user.click(screen.getByRole('button', { name: 'Add PR' }));

    const input = await screen.findByRole('textbox', { name: 'Pull request' });

    await user.type(input, 'not a pr{Enter}');
    expect(
      screen.getByText('Enter a PR or MR link, owner/repo#123, or group/project!123.'),
    ).toBeInTheDocument();
    expect(queueChanges).toEqual([]);

    await user.clear(input);
    await user.type(input, 'https://github.com/acme/web/pull/77{Enter}');

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/attention/acme/web/77'),
    );
    expect(await screen.findByRole('heading', { name: /Added by hand/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('switching accounts', () => {
  /** Waits past the note's 800 ms autosave, so a wrong save would have been sent. */
  const pastAutosave = () => act(() => new Promise((resolve) => setTimeout(resolve, 1200)));

  async function writeNote(user: ReturnType<typeof userEvent.setup>, text: string) {
    await screen.findByRole('heading', { name: /Follow up after code changes/ });
    await user.keyboard('n');
    expect(screen.getByRole('textbox', { name: 'Private note' })).toHaveFocus();
    await user.keyboard(text);
    await waitFor(() => expect(triage['me:follow']?.note).toBe(text), { timeout: 3000 });
  }

  it("keeps each account's private note on a PR both accounts track", async () => {
    triage['other:follow'] = { ...emptyTriage(), note: 'Note for other' };

    const { user } = mount('/inbox/attention/acme/another/2');

    await writeNote(user, 'Note for me');
    // Radix menus open from the keyboard in jsdom; pointer events need a real browser.
    screen.getByRole('button', { name: /^Switch GitHub account, now me\b/ }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: 'other' }));

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Private note' })).toHaveValue('Note for other'),
    );
    await pastAutosave();

    expect(triage['other:follow'].note).toBe('Note for other');
    expect(triage['me:follow'].note).toBe('Note for me');
    expect(writes.filter((write) => write.body.account === 'other')).toEqual([]);
  });

  it("ignores a reply to the previous account's autosave that arrives after the switch", async () => {
    let release = () => {};

    triage['other:follow'] = { ...emptyTriage(), note: 'Note for other' };
    heldReply = new Promise((resolve) => (release = resolve));

    const { user } = mount('/inbox/attention/acme/another/2');

    // The server saves the note at once; its reply waits until after the switch.
    await writeNote(user, 'Note for me');
    screen.getByRole('button', { name: /^Switch GitHub account, now me\b/ }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: 'other' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Private note' })).toHaveValue('Note for other'),
    );

    await act(async () => release());
    await pastAutosave();

    expect(screen.getByRole('textbox', { name: 'Private note' })).toHaveValue('Note for other');
    expect(clients[0].getQueryData(queryKeys.detail('other', 'follow'))).toMatchObject({
      account: 'other',
    });
    expect(triage['other:follow'].note).toBe('Note for other');
  });

  it('stays on the account shown while another window switches, until the status says so', async () => {
    let release = () => {};

    triage['other:follow'] = { ...emptyTriage(), note: 'Note for other' };
    heldReply = new Promise((resolve) => (release = resolve));

    const { user } = mount('/inbox/attention/acme/another/2');

    await writeNote(user, 'Note for me');

    // Another window switches. This one's PR is read for the account it shows, so a refetch
    // still brings `me`'s, and the late reply to `me`'s autosave lands on `me` alone.
    laggingStatus = 'me';
    account = 'other';
    await act(() => clients[0].invalidateQueries({ queryKey: queryKeys.detail('me', 'follow') }));
    await act(async () => release());
    await pastAutosave();

    expect(screen.getByRole('textbox', { name: 'Private note' })).toHaveValue('Note for me');
    expect(clients[0].getQueryData(queryKeys.detail('me', 'follow'))).toMatchObject({
      account: 'me',
    });

    // The status reaches this window: it shows the other account's note, and writes nothing to it.
    laggingStatus = null;
    await act(() => clients[0].invalidateQueries({ queryKey: ['status-poll'] }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Private note' })).toHaveValue('Note for other'),
    );
    await pastAutosave();

    expect(triage['other:follow'].note).toBe('Note for other');
    expect(triage['me:follow'].note).toBe('Note for me');
    expect(writes.filter((write) => write.body.account === 'other')).toEqual([]);
  });
});

describe('shell', () => {
  it('opens the command palette and jumps to a PR page', async () => {
    const { user, router } = mount();

    await queue();
    await user.keyboard('{Control>}k{/Control}');

    const input = await screen.findByPlaceholderText(/Jump to a PR/);

    await user.type(input, 'Already approved');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(router.state.location.pathname).toBe('/pr/acme/repo/3'));
  });

  it('lists the active shortcuts in the cheat sheet', async () => {
    const { user } = mount();

    await screen.findByRole('heading', { name: /Follow up after code changes/ });
    await user.keyboard('?');

    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

    expect(within(sheet).getByText('Done until new activity')).toBeInTheDocument();
    expect(within(sheet).getByText('Next PR')).toBeInTheDocument();
  });

  it('switches the theme from settings and remembers it', async () => {
    const { user } = mount('/settings');

    await user.click(await screen.findByRole('radio', { name: 'Dark' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('review-desk-theme')).toBe('dark');

    await act(async () => {
      await user.click(screen.getByRole('radio', { name: 'Light' }));
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('redirects GitHub-style PR paths to the PR page', async () => {
    const { router } = mount('/acme/repo/pull/3');

    await waitFor(() => expect(router.state.location.pathname).toBe('/pr/acme/repo/3'));
    expect(
      await screen.findByRole('heading', { name: /Already approved and quiet/ }),
    ).toBeInTheDocument();
  });

  it('sends GitHub "files changed" paths to the review workspace', async () => {
    const { router } = mount('/acme/repo/pull/3/files');

    await waitFor(() => expect(router.state.location.pathname).toBe('/pr/acme/repo/3/files'));
  });
});

describe('settings', () => {
  /** Answers `path` with `data`, and every other request as usual. */
  function respond(path: string, data: unknown) {
    const usual = globalThis.fetch;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) =>
        url === path ? { ok: true, status: 200, json: async () => data } : usual(url, options),
      ),
    );
  }

  const sections = () => screen.getByRole('navigation', { name: 'Settings sections' });

  it('opens on its first page with the list of pages beside it and the app sidebar kept', async () => {
    const { router } = mount('/settings');

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/appearance'));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Appearance' }),
    ).toBeInTheDocument();
    expect(within(sections()).getByRole('link', { name: 'Appearance' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('navigation', { name: 'Queues' })).toBeInTheDocument();
  });

  it('moves between pages from the list', async () => {
    const { user, router } = mount('/settings/appearance');

    await screen.findByRole('heading', { level: 2, name: 'Appearance' });
    await user.click(within(sections()).getByRole('link', { name: 'Data & privacy' }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Data & privacy' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/privacy');
  });

  it('sends an unknown page to the first one', async () => {
    const { router } = mount('/settings/nope');

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/appearance'));
  });

  it("lands Linear's sign-in on the Linear page, then drops the result from the URL", async () => {
    const { router } = mount('/settings?linear=failed');

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/linear'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Linear' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('flags a used-up Codex plan, a connected Linear and automatic reviews in the list', async () => {
    respond('/api/ai', {
      settings: { ...defaultAiSettings(), autoReview: { enabled: true, since: null } },
      providers: [
        { id: 'codex', label: 'Codex', available: true, version: '1.0', reason: null, demo: false },
      ],
      codex: {
        type: 'chatgpt',
        plan: 'ChatGPT Plus',
        windows: [{ label: '5-hour', usedPercent: 100, resetsAt: null }],
        limitReached: true,
        resetsAt: null,
        models: [],
        problem: 'The plan limit is reached.',
      },
    });
    respond('/api/linear/status', {
      configured: true,
      connected: true,
      method: 'oauth',
      workspace: 'Acme',
      teamKeys: ['DEMO'],
      error: null,
      canSignIn: true,
      setupCommand: '',
    });
    mount('/settings/ai');

    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });

    expect(
      await within(nav).findByRole('link', { name: 'AI agents, Needs attention' }),
    ).toBeInTheDocument();
    expect(await within(nav).findByRole('link', { name: 'Linear, Connected' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Automation, On' })).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: '5-hour usage' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });

  it('saves a notification switch as soon as it is flipped', async () => {
    const { user } = mount('/settings/notifications');
    const mentions = await screen.findByRole('switch', { name: 'Mentions' });

    expect(mentions).toBeChecked();
    await user.click(mentions);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/notifications/settings',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"mention":false'),
        }),
      ),
    );
  });
});

describe('error page', () => {
  const quiet: { mockRestore: () => void }[] = [];

  beforeEach(() => {
    // React and the router report every caught render error; these crashes are on purpose.
    quiet.push(
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    crash.frame = false;
    for (const spy of quiet.splice(0)) spy.mockRestore();
  });

  /** Waits for an element to finish animating in. */
  const shown = (element: HTMLElement) => waitFor(() => expect(element).toBeVisible());

  const details = () => screen.findByRole('button', { name: 'Technical details' });

  it('shows a crashed page inside the app frame and leaves it for the inbox', async () => {
    const { user, router } = mount('/insights');

    await shown(await screen.findByRole('heading', { name: 'Something went wrong on this page' }));
    expect(screen.getByRole('navigation', { name: 'Queues' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Go to your inbox' }));

    // The inbox opens on its first PR, so the path continues past the queue.
    await queue();
    expect(router.state.location.pathname).toMatch(/^\/inbox\/attention/);
    expect(screen.queryByRole('heading', { name: 'Something went wrong on this page' })).toBeNull();
  });

  it('folds the technical details away until asked for', async () => {
    const { user } = mount('/insights');
    const toggle = await details();

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Insights exploded/)).toBeNull();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await shown(await screen.findByText(/Error: Insights exploded/));

    await user.click(toggle);
    await waitFor(() => expect(screen.queryByText(/Insights exploded/)).toBeNull());
  });

  it('copies the details for a bug report and confirms it', async () => {
    const { user } = mount('/insights');

    await user.click(await screen.findByRole('button', { name: 'Copy details' }));

    await shown(await screen.findByText('Copied'));

    const report = await navigator.clipboard.readText();

    expect(report).toContain('Error: Insights exploded');
    expect(report).toContain('Page: /insights');
  });

  it('enters anew when trying again crashes again', async () => {
    const { user } = mount('/insights');

    await user.click(await details());
    expect(await details()).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(async () => expect(await details()).toHaveAttribute('aria-expanded', 'false'));
    await shown(screen.getByRole('heading', { name: 'Something went wrong on this page' }));
  });

  it('falls back to a full-window page when the app frame itself crashes', async () => {
    crash.frame = true;
    mount();

    // Visible, not just present: the page brings its own motion features, or it would stay hidden.
    await shown(await screen.findByRole('heading', { name: 'Review Desk ran into a problem' }));
    await shown(screen.getByRole('button', { name: 'Reload Review Desk' }));
    expect(screen.queryByRole('navigation', { name: 'Queues' })).toBeNull();
  });
});
