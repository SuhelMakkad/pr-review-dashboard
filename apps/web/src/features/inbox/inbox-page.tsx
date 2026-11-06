import { useEffect, useMemo, useRef } from 'react';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { CircleAlert, Inbox } from 'lucide-react';
import type { PullRequestItem } from '@review-desk/shared/types';
import { refOf } from '@/lib/pr-ref';
import { usePulls } from '@/lib/queries';
import { useShortcuts } from '@/lib/shortcuts';
import { shortDateTime } from '@/lib/time';
import { EmptyState } from '@/ui/empty-state';
import { Kbd } from '@/ui/kbd';
import { inQueue, isFollowUp, queueMeta, type QueueSlug } from '@/features/pulls/meta';
import { useCurrentPull } from '@/features/pulls/use-current-pull';
import { Digest } from '@/features/inbox/digest';
import { FilterBar } from '@/features/inbox/filter-bar';
import { activeFilterCount, matchesFilters, type InboxSearch } from '@/features/inbox/filters';
import { InboxContext } from '@/features/inbox/inbox-context';
import { QueueRow } from '@/features/inbox/queue-row';

interface Section {
  label: string | null;
  items: PullRequestItem[];
}

/** Auto-select the first PR only once per app load, so closing the pane stays closed. */
let autoSelected = false;

/** Restores first-load behaviour (used by tests that mount the app repeatedly). */
export function resetInboxAutoSelect() {
  autoSelected = false;
}

function layoutStorage() {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

export function InboxPage() {
  const { queue } = useParams({ from: '/inbox/$queue' }) as { queue: QueueSlug };
  const search = useSearch({ from: '/inbox/$queue' });
  const navigate = useNavigate();
  const pulls = usePulls();
  const { ref, item: current } = useCurrentPull();
  const filterRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const meta = queueMeta[queue];
  const all = pulls.data?.items ?? [];
  const layout = useDefaultLayout({ id: 'inbox-panes', storage: layoutStorage() });

  const queued = useMemo(() => all.filter((item) => inQueue(item, queue)), [all, queue]);
  const visible = useMemo(
    () => queued.filter((item) => matchesFilters(item, search)),
    [queued, search],
  );

  const sections: Section[] = useMemo(() => {
    if (queue !== 'attention') return [{ label: null, items: visible }];

    return [
      { label: 'Follow-ups', items: visible.filter(isFollowUp) },
      { label: 'First reviews', items: visible.filter((item) => !isFollowUp(item)) },
    ].filter((section) => section.items.length > 0);
  }, [visible, queue]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const index = current ? flat.findIndex((item) => item.id === current.id) : -1;

  const setSearch = (next: Partial<InboxSearch>) =>
    navigate({
      to: '.',
      search: (previous: InboxSearch) => ({ ...previous, ...next }),
      replace: true,
    });

  const select = (item: PullRequestItem | undefined, replace = true) => {
    if (!item) return;

    const target = refOf(item);

    void navigate({
      to: '/inbox/$queue/$owner/$repo/$number',
      params: { queue, owner: target.owner, repo: target.repo, number: String(target.number) },
      search: (previous: InboxSearch) => previous,
      replace,
    });
  };

  const open = (item: PullRequestItem | null | undefined) => {
    if (!item) return;

    const target = refOf(item);

    void navigate({
      to: '/pr/$owner/$repo/$number/files',
      params: { owner: target.owner, repo: target.repo, number: String(target.number) },
      search: {},
    });
  };

  const close = () =>
    navigate({
      to: '/inbox/$queue',
      params: { queue },
      search: (previous: InboxSearch) => previous,
    });

  useEffect(() => {
    if (autoSelected || ref || flat.length === 0) return;

    autoSelected = true;
    select(flat[0]);
  }, [flat.length, ref]);

  useEffect(() => {
    if (current) rowRefs.current.get(current.id)?.scrollIntoView({ block: 'nearest' });
  }, [current?.id]);

  const move = (delta: number) => {
    if (flat.length === 0) return;

    const next =
      index === -1
        ? delta > 0
          ? 0
          : flat.length - 1
        : Math.min(flat.length - 1, Math.max(0, index + delta));

    select(flat[next]);
  };

  useShortcuts([
    { keys: 'j', label: 'Next PR', group: 'Queue', run: () => move(1) },
    { keys: 'k', label: 'Previous PR', group: 'Queue', run: () => move(-1) },
    { keys: 'ArrowDown', label: 'Next PR', group: 'Queue', run: () => move(1), hidden: true },
    { keys: 'ArrowUp', label: 'Previous PR', group: 'Queue', run: () => move(-1), hidden: true },
    { keys: 'Enter', label: 'Review changes', group: 'Queue', run: () => open(current) },
    { keys: 'Escape', label: 'Close reading pane', group: 'Queue', run: () => ref && void close() },
    {
      keys: '/',
      label: 'Filter',
      group: 'Queue',
      run: () => {
        filterRef.current?.focus();
        filterRef.current?.select();
      },
    },
  ]);

  const navigation = useMemo(
    () => ({
      advance: () => {
        if (index === -1) return;

        const next = flat[index + 1] ?? flat[index - 1];

        if (next) select(next);
        else void close();
      },
    }),
    [flat, index, queue],
  );

  const nextWake = all
    .filter((item) => item.snoozedUntil)
    .map((item) => item.snoozedUntil!)
    .sort()[0];

  const filtered = activeFilterCount(search) > 0 || Boolean(search.q);

  return (
    <InboxContext.Provider value={navigation}>
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line px-4">
          <h1 className="flex shrink-0 items-baseline gap-2 text-base font-semibold">
            {meta.label}
            <span className="text-sm font-normal text-fg-subtle tabular-nums">
              {filtered ? `${visible.length} of ${queued.length}` : queued.length}
            </span>
          </h1>
          <FilterBar ref={filterRef} search={search} items={queued} onChange={setSearch} />
        </header>

        {queue === 'attention' && <Digest items={queued} onFilter={setSearch} />}

        <Group
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          <Panel id="list" defaultSize="44" minSize="28" className="flex flex-col">
            <div
              role="listbox"
              aria-label={`${meta.label} pull requests`}
              aria-activedescendant={current ? `row-${current.id}` : undefined}
              tabIndex={0}
              className="scroll-thin min-h-0 flex-1 overflow-y-auto outline-none"
            >
              {pulls.isPending && <ListSkeleton />}

              {pulls.error && !pulls.data && (
                <EmptyState
                  icon={<CircleAlert size={28} />}
                  title="Can't reach Review Desk"
                  hint={pulls.error.message}
                />
              )}

              {pulls.data && flat.length === 0 && (
                <div className="grid place-items-center pt-10">
                  {filtered ? (
                    <EmptyState
                      title="No matching pull requests"
                      hint="Try a different filter."
                      action={
                        <button
                          type="button"
                          className="text-sm text-accent underline"
                          onClick={() =>
                            setSearch({
                              q: undefined,
                              repo: undefined,
                              author: undefined,
                              reason: undefined,
                              ci: undefined,
                              draft: undefined,
                            })
                          }
                        >
                          Clear filters
                        </button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={<Inbox size={28} />}
                      title={meta.empty}
                      hint={
                        <>
                          {meta.emptyHint}
                          {queue === 'attention' && nextWake && (
                            <span className="mt-2 block text-fg-subtle">
                              Next snoozed PR wakes {shortDateTime(nextWake)}.
                            </span>
                          )}
                        </>
                      }
                    />
                  )}
                </div>
              )}

              {sections.map((section) => (
                <div
                  key={section.label ?? 'all'}
                  role="group"
                  aria-label={section.label ?? meta.label}
                >
                  {section.label && (
                    <div className="sticky top-0 z-10 flex h-7 items-center gap-2 border-b border-line bg-sunken/95 px-4 text-2xs font-medium tracking-wide text-fg-subtle uppercase backdrop-blur">
                      {section.label}
                      <span className="tabular-nums">{section.items.length}</span>
                    </div>
                  )}
                  {section.items.map((item) => (
                    <QueueRow
                      key={item.id}
                      ref={(element) => {
                        if (element) rowRefs.current.set(item.id, element);
                        else rowRefs.current.delete(item.id);
                      }}
                      item={item}
                      selected={item.id === current?.id}
                      onSelect={() => select(item, false)}
                      onOpen={() => open(item)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </Panel>

          <Separator className="w-px bg-line transition-colors outline-none hover:bg-accent focus-visible:bg-accent data-[separator=active]:bg-accent" />

          <Panel id="reader" minSize="34" className="flex flex-col">
            {ref ? (
              <Outlet />
            ) : (
              <div className="grid h-full place-items-center">
                <EmptyState
                  title="Select a pull request"
                  hint={
                    <span className="inline-flex items-center gap-1.5">
                      <Kbd keys="j" /> <Kbd keys="k" /> to move, <Kbd keys="Enter" /> to open
                    </span>
                  }
                />
              </div>
            )}
          </Panel>
        </Group>
      </div>
    </InboxContext.Provider>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading pull requests">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="flex h-[var(--row-h)] items-center gap-3 border-b border-line px-4"
        >
          <div className="h-3 flex-1 animate-pulse rounded-xs bg-sunken" />
          <div className="h-3 w-16 animate-pulse rounded-xs bg-sunken" />
        </div>
      ))}
    </div>
  );
}
