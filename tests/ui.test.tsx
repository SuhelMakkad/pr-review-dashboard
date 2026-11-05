// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from '../src/router';
import { resetInboxAutoSelect } from '../src/features/inbox/InboxPage';
import { initialStatus } from '../server/sync';
import { deriveItem, emptyTriage } from '../shared/attention';
import type { LocalTriageState } from '../shared/types';
import { review, snapshot } from './fixtures';

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
let triage: Record<string, LocalTriageState> = {};
let writes: { id: string; body: Record<string, unknown> }[] = [];
const clients: QueryClient[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetInboxAutoSelect();
  triage = {};
  writes = [];
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
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: RequestInit) => {
      const state = (id: string) => triage[id] ?? emptyTriage();
      let data: unknown;

      if (path === '/api/status') {
        data = {
          ...initialStatus(),
          account: { login: 'me' },
          lastSuccessfulSync: new Date().toISOString(),
        };
      } else if (path === '/api/pulls') {
        data = {
          account: 'me',
          items: snapshots.map((pr) => deriveItem(pr, state(pr.id), 'me', [])),
        };
      } else {
        const id = decodeURIComponent(path.split('/')[3]);
        const pr = snapshots.find((value) => value.id === id)!;

        if (options?.method === 'PATCH') {
          const body = JSON.parse(String(options.body));
          const current = { ...state(id) };

          writes.push({ id, body });

          if (body.note !== undefined) current.note = body.note;
          if (body.done !== undefined) {
            current.doneAt = body.done ? new Date().toISOString() : null;
            current.doneActivityKeys = body.done
              ? deriveItem(pr, state(id), 'me', []).activityKeys
              : [];
          }

          triage[id] = current;
        }

        data = {
          account: 'me',
          snapshot: pr,
          item: deriveItem(pr, state(id), 'me', []),
          triage: state(id),
        };
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
    const { router } = mount('/acme/repo/pull/3/files');

    await waitFor(() => expect(router.state.location.pathname).toBe('/pr/acme/repo/3'));
    expect(
      await screen.findByRole('heading', { name: /Already approved and quiet/ }),
    ).toBeInTheDocument();
  });
});
