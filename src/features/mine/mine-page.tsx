import { useEffect, useMemo, useRef } from 'react';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { GitPullRequestDraft } from 'lucide-react';
import type { AuthorItem } from '../../../shared/author';
import { refOf } from '../../lib/pr-ref';
import { useMine } from '../../lib/queries';
import { useShortcuts } from '../../lib/shortcuts';
import { EmptyState } from '../../ui/empty-state';
import { Kbd } from '../../ui/kbd';
import { useRouteRef } from '../pulls/use-current-pull';
import { sameRef } from '../../lib/pr-ref';
import { groupMeta, groupOrder } from './meta';
import { MineRow } from './mine-row';

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
          <div
            role="listbox"
            aria-label="My pull requests"
            tabIndex={0}
            className="scroll-thin min-h-0 flex-1 overflow-y-auto outline-none"
          >
            {mine.data && flat.length === 0 && (
              <div className="grid place-items-center pt-10">
                <EmptyState
                  icon={<GitPullRequestDraft size={28} />}
                  title="No open PRs of yours"
                  hint="PRs you open appear here with what blocks them."
                />
              </div>
            )}
            {sections.map((section) => (
              <div key={section.group} role="group" aria-label={groupMeta[section.group].label}>
                <div className="sticky top-0 z-10 flex h-7 items-center gap-2 border-b border-line bg-sunken/95 px-4 text-2xs font-medium tracking-wide text-fg-subtle uppercase backdrop-blur">
                  {groupMeta[section.group].label}
                  <span className="tabular-nums">{section.items.length}</span>
                </div>
                {section.items.map((item) => (
                  <MineRow
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
