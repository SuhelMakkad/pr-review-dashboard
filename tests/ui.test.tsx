// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../src/App';
import { initialStatus } from '../server/sync';
import { deriveItem, emptyTriage } from '../shared/attention';
import { snapshot } from './fixtures';

const first = snapshot({
  id: 'first',
  number: 1,
  title: 'First review needed',
  reviews: [],
  sources: ['requested'],
});
const second = snapshot({
  id: 'second',
  number: 2,
  title: 'Follow up after code changes',
  headOid: 'changed',
  repository: 'acme/another',
  author: { login: 'bob' },
});
const snapshots = [first, second];
const triage = emptyTriage();
const clients: QueryClient[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  triage.note = '';
  first.body = 'A useful **description**.';
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
      let data: unknown;

      if (path === '/api/status')
        data = {
          ...initialStatus(),
          account: { login: 'me' },
          lastSuccessfulSync: new Date().toISOString(),
        };
      else if (path === '/api/pulls')
        data = { account: 'me', items: snapshots.map((pr) => deriveItem(pr, triage, 'me', [])) };
      else {
        const id = path.split('/')[3];
        const pr = snapshots.find((value) => value.id === id)!;

        if (options?.method === 'PATCH')
          triage.note = JSON.parse(String(options.body)).note ?? triage.note;

        data = { account: 'me', snapshot: pr, item: deriveItem(pr, triage, 'me', []), triage };
      }

      return { ok: true, json: async () => data };
    }),
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

describe('dashboard workflow', () => {
  it('filters by search, repository, author, and attention reason', async () => {
    const user = mount();

    await screen.findByRole('button', { name: 'Show details for First review needed' });
    await user.type(screen.getByRole('textbox', { name: 'Search PRs' }), 'code changes');

    expect(
      screen.queryByRole('button', { name: 'Show details for First review needed' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show details for Follow up after code changes' }),
    ).toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Search PRs' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'acme/repo');
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Author' }), 'bob');

    expect(screen.getByText('No matching pull requests')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Attention reason' }),
      'first_review',
    );

    expect(
      screen.getByRole('button', { name: 'Show details for First review needed' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Show details for Follow up after code changes' }),
    ).not.toBeInTheDocument();
  });

  it('opens details, navigates tabs with the keyboard, and saves a private note locally', async () => {
    const user = mount();

    await user.click(
      await screen.findByRole('button', { name: 'Show details for First review needed' }),
    );
    await screen.findByRole('heading', { name: 'Your latest review' });
    await user.click(screen.getByRole('tab', { name: 'Files' }));

    expect(screen.getByText('src/app.ts')).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');

    await user.type(
      screen.getByRole('textbox', { name: 'Private note' }),
      'Check the regression test.',
    );
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('All changes saved locally');

    expect(triage.note).toBe('Check the regression test.');
    expect(
      vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'PATCH')[0][0],
    ).toContain('/triage');
  });

  it('switches themes and keeps queue navigation accessible', async () => {
    const user = mount();

    await user.click(screen.getByRole('button', { name: 'Dark theme' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('review-desk-theme')).toBe('dark');

    const nav = screen.getByRole('navigation', { name: 'Review queues' });

    await user.click(within(nav).getByRole('button', { name: /Waiting on author/ }));

    expect(screen.getByText('No PRs waiting on an author')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /Waiting on author/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('renders untrusted Markdown without scripts, remote images, or JavaScript links', async () => {
    first.body =
      '<script>alert(1)</script>\n\n![tracking image](https://example.com/pixel.png)\n\n[unsafe](javascript:alert(1))';

    const user = mount();

    await user.click(
      await screen.findByRole('button', { name: 'Show details for First review needed' }),
    );
    await screen.findByText('[Image: tracking image]');

    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('unsafe')).not.toHaveAttribute('href', 'javascript:alert(1)');
  });
});
