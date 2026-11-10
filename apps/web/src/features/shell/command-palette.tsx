import { useRef, useState } from 'react';
import { Command } from 'cmdk';
import { toast } from 'sonner';
import { VisuallyHidden } from 'radix-ui';
import { useNavigate } from '@tanstack/react-router';
import {
  AlarmClock,
  ArrowUpRight,
  CheckCheck,
  Copy,
  GitPullRequest,
  Keyboard,
  ListMinus,
  ListPlus,
  MessageSquare,
  Monitor,
  RefreshCw,
  Rows3,
  Search,
  Settings,
  Activity,
  UsersRound,
} from 'lucide-react';
import { formatRef, parsePrRef, refOf, sameRef } from '@/lib/pr-ref';
import { useAccounts, useMine, usePulls, useSyncNow } from '@/lib/queries';
import { appearance } from '@/lib/theme';
import { snoozePresets } from '@/lib/time';
import { DialogTitle, Modal } from '@/ui/dialog';
import { Kbd } from '@/ui/kbd';
import { usePullActions } from '@/features/pulls/actions';
import { queueMeta, queueSlugs } from '@/features/pulls/meta';
import { useCurrentPull } from '@/features/pulls/use-current-pull';
import { onlyAddedByHand, useAddAndOpen, useUntrackPull } from '@/features/pulls/use-track';
import { openActivity } from '@/features/activity/use-operations';
import { useAccountSwitcher } from '@/features/shell/account-menu';

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
  const mine = useMine();
  const sync = useSyncNow();
  const addPull = useAddAndOpen();
  const untrack = useUntrackPull();
  const actions = usePullActions();
  const { item: current } = useCurrentPull();
  const accounts = useAccounts(open);
  const switcher = useAccountSwitcher();
  // Compared with the live status: a cached list can predate the last switch.
  const otherAccounts = (accounts.data?.accounts ?? []).filter(
    (account) => account.ok && account.login !== switcher.current,
  );
  const items = pulls.data?.items ?? [];
  const pastedRef = parsePrRef(query);
  const pastedTracked =
    pastedRef && [...items, ...(mine.data?.items ?? [])].some((item) => sameRef(item, pastedRef));

  // Running a command clears the query, but only once the palette has faded out of view.
  const clearOnExit = useRef(false);

  const run = (action: () => void) => () => {
    clearOnExit.current = true;
    onOpenChange(false);
    action();
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      onExitComplete={() => {
        if (!clearOnExit.current) return;

        clearOnExit.current = false;
        setQuery('');
      }}
      className="top-[14vh] w-[640px] overflow-hidden"
      aria-describedby={undefined}
    >
      <VisuallyHidden.Root>
        <DialogTitle>Command palette</DialogTitle>
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
                Open {formatRef(pastedRef)}
              </Command.Item>
              {!pastedTracked && (
                <Command.Item
                  value={`add-link ${query}`}
                  className={itemClass}
                  onSelect={run(
                    () =>
                      void addPull
                        .add(pastedRef)
                        .catch((error: Error) => toast.error(error.message)),
                  )}
                >
                  <ListPlus size={15} className="text-fg-subtle" aria-hidden="true" />
                  Add {formatRef(pastedRef)} to review queue
                </Command.Item>
              )}
            </Command.Group>
          )}

          {current && (
            <Command.Group heading={`#${current.number} ${current.title}`} className={groupClass}>
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
                <Command.Item className={itemClass} onSelect={run(() => actions.markSeen(current))}>
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
              {onlyAddedByHand(current) && (
                <Command.Item className={itemClass} onSelect={run(() => untrack.mutate(current))}>
                  <ListMinus size={15} className="text-fg-subtle" aria-hidden="true" />
                  Remove from review queue
                </Command.Item>
              )}
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
                  onSelect={run(() => navigate({ to: '/inbox/$queue', params: { queue: slug } }))}
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
            <Command.Item className={itemClass} onSelect={run(() => navigate({ to: '/settings' }))}>
              <Settings size={15} className="text-fg-subtle" aria-hidden="true" />
              Settings
              <Kbd keys="g s" className="ml-auto" />
            </Command.Item>
          </Command.Group>

          <Command.Group heading="App" className={groupClass}>
            <Command.Item className={itemClass} onSelect={run(openActivity)}>
              <Activity size={15} className="text-fg-subtle" aria-hidden="true" />
              View GitHub activity
            </Command.Item>
            <Command.Item className={itemClass} onSelect={run(() => sync.mutate())}>
              <RefreshCw size={15} className="text-fg-subtle" aria-hidden="true" />
              Sync with GitHub now
            </Command.Item>
            {otherAccounts.map((account) => (
              <Command.Item
                key={account.login}
                value={`switch github account ${account.login}`}
                className={itemClass}
                disabled={switcher.switching}
                onSelect={run(() => switcher.switchTo(account.login))}
              >
                <UsersRound size={15} className="text-fg-subtle" aria-hidden="true" />
                Switch GitHub account to {account.login}
              </Command.Item>
            ))}
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
    </Modal>
  );
}
