import { useEffect, useMemo, useRef } from 'react';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { GitPullRequestDraft } from 'lucide-react';
import type { AuthorItem } from '@review-desk/shared/author';
import { refOf } from '@/lib/pr-ref';
import { useMine } from '@/lib/queries';
import { useShortcuts } from '@/lib/shortcuts';
import { EmptyState } from '@/ui/empty-state';
import { ErrorState } from '@/ui/error-state';
import { ListSkeleton } from '@/ui/skeleton';
import { Kbd } from '@/ui/kbd';
import { FadeSwap, IndicatorGroup, LayoutScroll, ListItem, ListPresence } from '@/ui/motion';
import { useRouteRef } from '@/features/pulls/use-current-pull';
import { sameRef } from '@/lib/pr-ref';
import { groupMeta, groupOrder } from '@/features/mine/meta';
import { MineRow } from '@/features/mine/mine-row';

function layoutStorage() {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** Your own open PRs, grouped by whose move it is. */
export function MinePage() {
  const navigate = useNavigate();
  const mine = useMine();
  const ref = useRouteRef();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const layout = useDefaultLayout({ id: 'mine-panes', storage: layoutStorage() });
  const items = mine.data?.items ?? [];
  const sections = useMemo(
    () =>
      groupOrder
        .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
        .filter((section) => section.items.length),
    [items],
  );
  const flat = sections.flatMap((section) => section.items);
  const listState = mine.isPending ? 'loading' : mine.error && !mine.data ? 'error' : 'ready';
  const current = ref ? flat.find((item) => sameRef(item, ref)) : undefined;
  const index = current ? flat.indexOf(current) : -1;

  const select = (item: AuthorItem | undefined, replace = true) => {
    if (!item) return;

    const target = refOf(item);

    void navigate({
      to: '/mine/$owner/$repo/$number',
      params: { ...target, number: String(target.number) },
      replace,
    });
  };

  const open = (item: AuthorItem | undefined) => {
    if (!item) return;

    const target = refOf(item);

    void navigate({
      to: '/pr/$owner/$repo/$number/files',
      params: { ...target, number: String(target.number) },
      search: {},
    });
  };

  useEffect(() => {
    if (current) rowRefs.current.get(current.id)?.scrollIntoView({ block: 'nearest' });
  }, [current?.id]);

  const move = (delta: number) => {
    if (flat.length === 0) return;

    select(flat[index === -1 ? 0 : Math.min(flat.length - 1, Math.max(0, index + delta))]);
  };

  useShortcuts([
    { keys: 'j', label: 'Next PR', group: 'Queue', run: () => move(1) },
    { keys: 'k', label: 'Previous PR', group: 'Queue', run: () => move(-1) },
    { keys: 'Enter', label: 'Open the review workspace', group: 'Queue', run: () => open(current) },
    {
      keys: 'Escape',
      label: 'Close reading pane',
      group: 'Queue',
      run: () => ref && void navigate({ to: '/mine' }),
    },
  ]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="flex items-baseline gap-2 text-base font-semibold">
          My pull requests
          <span className="text-sm font-normal text-fg-subtle tabular-nums">{items.length}</span>
        </h1>
        <span className="text-xs text-fg-muted">
          What stands between each of your PRs and merging.
        </span>
      </header>
      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="list" defaultSize="44" minSize="28" className="flex flex-col">
          <IndicatorGroup>
            <LayoutScroll
              role="listbox"
              aria-label="My pull requests"
              aria-busy={mine.isPending}
              tabIndex={0}
              className="scroll-thin min-h-0 flex-1 overflow-y-auto outline-none"
            >
              {/* Loading, failed and loaded each fade into the next; an error centres itself. */}
              <FadeSwap
                swapKey={listState}
                className={listState === 'error' ? 'grid min-h-full place-items-center' : undefined}
              >
                {listState === 'loading' && <ListSkeleton rows={4} />}

                {listState === 'error' && (
                  <ErrorState
                    title="Could not load your pull requests"
                    error={mine.error}
                    onRetry={() => void mine.refetch()}
                  />
                )}

                {mine.data && flat.length === 0 && (
                  <div className="grid place-items-center pt-10">
                    <EmptyState
                      icon={<GitPullRequestDraft size={28} />}
                      title="No open PRs of yours"
                      hint="PRs you open appear here with what blocks them."
                    />
                  </div>
                )}
                <ListPresence>
                  {sections.map((section) => (
                    <ListItem key={section.group}>
                      <div role="group" aria-label={groupMeta[section.group].label}>
                        <div className="sticky top-0 z-10 flex h-7 items-center gap-2 border-b border-line bg-sunken/95 px-4 text-2xs font-medium tracking-wide text-fg-subtle uppercase backdrop-blur">
                          {groupMeta[section.group].label}
                          <span className="tabular-nums">{section.items.length}</span>
                        </div>
                        <ListPresence>
                          {section.items.map((item) => (
                            <ListItem key={item.id}>
                              <MineRow
                                ref={(element) => {
                                  if (element) rowRefs.current.set(item.id, element);
                                  else rowRefs.current.delete(item.id);
                                }}
                                item={item}
                                selected={item.id === current?.id}
                                onSelect={() => select(item, false)}
                                onOpen={() => open(item)}
                              />
                            </ListItem>
                          ))}
                        </ListPresence>
                      </div>
                    </ListItem>
                  ))}
                </ListPresence>
              </FadeSwap>
            </LayoutScroll>
          </IndicatorGroup>
        </Panel>
        <Separator className="w-px bg-line outline-none hover:bg-accent data-[separator=active]:bg-accent" />
        <Panel id="reader" minSize="34" className="flex flex-col">
          {ref ? (
            <Outlet />
          ) : (
            <div className="grid h-full place-items-center">
              <EmptyState
                title="Select one of your PRs"
                hint={
                  <span className="inline-flex items-center gap-1.5">
                    <Kbd keys="j" /> <Kbd keys="k" /> to move
                  </span>
                }
              />
            </div>
          )}
        </Panel>
      </Group>
    </div>
  );
}
