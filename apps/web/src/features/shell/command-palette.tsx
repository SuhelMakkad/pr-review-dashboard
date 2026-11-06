import { useState } from 'react';
import { Command } from 'cmdk';
import { Dialog, VisuallyHidden } from 'radix-ui';
import { useNavigate } from '@tanstack/react-router';
import {
  AlarmClock,
  ArrowUpRight,
  CheckCheck,
  Copy,
  GitPullRequest,
  Keyboard,
  MessageSquare,
  Monitor,
  RefreshCw,
  Rows3,
  Search,
  Settings,
} from 'lucide-react';
import { parsePrUrl, refOf } from '@/lib/pr-ref';
import { usePulls, useSyncNow } from '@/lib/queries';
import { appearance } from '@/lib/theme';
import { snoozePresets } from '@/lib/time';
import { Kbd } from '@/ui/kbd';
import { usePullActions } from '@/features/pulls/actions';
import { queueMeta, queueSlugs } from '@/features/pulls/meta';
import { useCurrentPull } from '@/features/pulls/use-current-pull';

const itemClass =
  'flex h-9 cursor-default items-center gap-2.5 rounded-sm px-2.5 text-sm text-fg data-[selected=true]:bg-selected aria-disabled:opacity-50';
const groupClass =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:uppercase';

export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowShortcuts: () => void;
}) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const pulls = usePulls();
  const sync = useSyncNow();
  const actions = usePullActions();
  const { item: current } = useCurrentPull();
  const items = pulls.data?.items ?? [];
  const pastedRef = parsePrUrl(query);

  const run = (action: () => void) => () => {
    onOpenChange(false);
    setQuery('');
    action();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 dark:bg-black/50" />
        <Dialog.Content
          className="fixed top-[14vh] left-1/2 z-50 w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-elevated shadow-popover"
          aria-describedby={undefined}
        >
          <VisuallyHidden.Root>
            <Dialog.Title>Command palette</Dialog.Title>
          </VisuallyHidden.Root>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={15} className="text-fg-subtle" aria-hidden="true" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Jump to a PR, run an action, or paste a GitHub PR link…"
                className="h-12 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
              />
              <Kbd keys="Escape" />
            </div>
            <Command.List className="scroll-thin max-h-[56vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-8 text-center text-sm text-fg-muted">
                No matching PRs or actions.
              </Command.Empty>

              {pastedRef && (
                <Command.Group heading="GitHub link" className={groupClass}>
                  <Command.Item
                    value={`open-link ${query}`}
                    className={itemClass}
                    onSelect={run(() =>
                      navigate({
                        to: '/pr/$owner/$repo/$number',
                        params: { ...pastedRef, number: String(pastedRef.number) },
                      }),
                    )}
                  >
                    <GitPullRequest size={15} className="text-fg-subtle" aria-hidden="true" />
                    Open {pastedRef.owner}/{pastedRef.repo}#{pastedRef.number}
                  </Command.Item>
                </Command.Group>
              )}

              {current && (
                <Command.Group
                  heading={`#${current.number} ${current.title}`}
                  className={groupClass}
                >
                  <Command.Item
                    className={itemClass}
                    onSelect={run(() => actions.openOnGitHub(current))}
                  >
                    <ArrowUpRight size={15} className="text-fg-subtle" aria-hidden="true" />
                    Open on GitHub
                    <Kbd keys="o" className="ml-auto" />
                  </Command.Item>
                  <Command.Item className={itemClass} onSelect={run(() => actions.done(current))}>
                    <CheckCheck size={15} className="text-fg-subtle" aria-hidden="true" />
                    {current.doneAt ? 'Move back to its queue' : 'Mark done until new activity'}
                    <Kbd keys="e" className="ml-auto" />
                  </Command.Item>
                  {snoozePresets().map((preset) => (
                    <Command.Item
                      key={preset.key}
                      value={`snooze ${preset.label}`}
                      className={itemClass}
                      onSelect={run(() => actions.snooze(current, preset.until))}
                    >
                      <AlarmClock size={15} className="text-fg-subtle" aria-hidden="true" />
                      Snooze · {preset.label.toLowerCase()}
                    </Command.Item>
                  ))}
                  {current.unreadReplyKeys.length > 0 && (
                    <Command.Item
                      className={itemClass}
                      onSelect={run(() => actions.markSeen(current))}
                    >
                      <MessageSquare size={15} className="text-fg-subtle" aria-hidden="true" />
                      Mark replies as seen
                      <Kbd keys="m" className="ml-auto" />
                    </Command.Item>
                  )}
                  <Command.Item
                    className={itemClass}
                    onSelect={run(() => void actions.copyLink(current))}
                  >
                    <Copy size={15} className="text-fg-subtle" aria-hidden="true" />
                    Copy GitHub link
                    <Kbd keys="y" className="ml-auto" />
                  </Command.Item>
                </Command.Group>
              )}

              <Command.Group heading="Pull requests" className={groupClass}>
                {items.map((item) => {
                  const ref = refOf(item);

                  return (
                    <Command.Item
                      key={item.id}
                      value={`#${item.number} ${item.title} ${item.repository} ${item.author.login}`}
                      className={itemClass}
                      onSelect={run(() =>
                        navigate({
                          to: '/pr/$owner/$repo/$number',
                          params: { ...ref, number: String(ref.number) },
                        }),
                      )}
                    >
                      <GitPullRequest
                        size={15}
                        className="shrink-0 text-fg-subtle"
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-fg-subtle">
                        {item.repository}#{item.number}
                      </span>
                    </Command.Item>
                  );
                })}
              </Command.Group>

              <Command.Group heading="Go to" className={groupClass}>
                {queueSlugs.map((slug) => {
                  const meta = queueMeta[slug];
                  const Icon = meta.icon;

                  return (
                    <Command.Item
                      key={slug}
                      value={`go ${meta.label}`}
                      className={itemClass}
                      onSelect={run(() =>
                        navigate({ to: '/inbox/$queue', params: { queue: slug } }),
                      )}
                    >
                      <Icon size={15} className="text-fg-subtle" aria-hidden="true" />
                      {meta.label}
                      <Kbd keys={meta.keys} className="ml-auto" />
                    </Command.Item>
                  );
                })}
                <Command.Item
                  value="go insights trends review speed"
                  className={itemClass}
                  onSelect={run(() => navigate({ to: '/insights' }))}
                >
                  <GitPullRequest size={15} className="text-fg-subtle" aria-hidden="true" />
                  Insights
                  <Kbd keys="g t" className="ml-auto" />
                </Command.Item>
                <Command.Item
                  value="go my prs authored"
                  className={itemClass}
                  onSelect={run(() => navigate({ to: '/mine' }))}
                >
                  <GitPullRequest size={15} className="text-fg-subtle" aria-hidden="true" />
                  My PRs
                  <Kbd keys="g m" className="ml-auto" />
                </Command.Item>
                <Command.Item
                  className={itemClass}
                  onSelect={run(() => navigate({ to: '/settings' }))}
                >
                  <Settings size={15} className="text-fg-subtle" aria-hidden="true" />
                  Settings
                  <Kbd keys="g s" className="ml-auto" />
                </Command.Item>
              </Command.Group>

              <Command.Group heading="App" className={groupClass}>
                <Command.Item className={itemClass} onSelect={run(() => sync.mutate())}>
                  <RefreshCw size={15} className="text-fg-subtle" aria-hidden="true" />
                  Sync with GitHub now
                </Command.Item>
                <Command.Item className={itemClass} onSelect={run(appearance.cycleTheme)}>
                  <Monitor size={15} className="text-fg-subtle" aria-hidden="true" />
                  Switch theme (light · dark · system)
                </Command.Item>
                <Command.Item className={itemClass} onSelect={run(appearance.toggleDensity)}>
                  <Rows3 size={15} className="text-fg-subtle" aria-hidden="true" />
                  Toggle compact rows
                </Command.Item>
                <Command.Item className={itemClass} onSelect={run(onShowShortcuts)}>
                  <Keyboard size={15} className="text-fg-subtle" aria-hidden="true" />
                  Keyboard shortcuts
                  <Kbd keys="[Shift]+?" className="ml-auto" />
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
