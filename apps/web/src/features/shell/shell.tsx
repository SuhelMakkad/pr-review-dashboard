import { Fragment, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { useShortcuts, type Shortcut } from '@/lib/shortcuts';
import { setBadge } from '@/lib/notifications';
import { useMine, useNotificationSettings, usePulls, useStatus } from '@/lib/queries';
import { useRemountKey } from '@/lib/remount-key';
import { useEffect } from 'react';
import { useAppearance } from '@/lib/theme';
import { Enter, MotionProvider } from '@/ui/motion';
import { TooltipProvider } from '@/ui/tooltip';
import { undoLast } from '@/features/pulls/actions';
import { queueMeta, queueSlugs } from '@/features/pulls/meta';
import { CheatSheet } from '@/features/shell/cheat-sheet';
import { CommandPalette } from '@/features/shell/command-palette';
import { Sidebar } from '@/features/shell/sidebar';
import { StatusBar, type Hint } from '@/features/shell/status-bar';
import { ActivityDrawer } from '@/features/activity/activity-drawer';
import { useActivityOpen } from '@/features/activity/use-operations';

function hintsFor(pathname: string): Hint[] {
  if (pathname.startsWith('/inbox/')) {
    return pathname.split('/').length > 3
      ? [
          { keys: 'j', label: 'Next' },
          { keys: 'Enter', label: 'Open' },
          { keys: 'e', label: 'Done' },
          { keys: 's', label: 'Snooze' },
        ]
      : [
          { keys: 'j', label: 'Select' },
          { keys: '/', label: 'Filter' },
        ];
  }

  if (pathname.startsWith('/mine'))
    return [
      { keys: 'j', label: 'Next' },
      { keys: 'Enter', label: 'Open' },
    ];

  if (pathname.startsWith('/pr/'))
    return [
      { keys: 'Escape', label: 'Back' },
      { keys: 'o', label: 'GitHub' },
    ];

  return [];
}

export function Shell() {
  const activityOpen = useActivityOpen();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { theme } = useAppearance();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const accountScope = useRemountKey(useStatus().data?.account?.login);
  // Moving between sections (inbox, mine, a PR, insights, settings) eases the new page in.
  const section = pathname.split('/')[1] ?? '';
  const pulls = usePulls();
  const mine = useMine();
  const notifySettings = useNotificationSettings();
  const attention = (pulls.data?.items ?? []).filter((item) => item.queue === 'attention').length;
  const needsYou = (mine.data?.items ?? []).filter((item) => item.group === 'needs_you').length;
  const badge = attention + (notifySettings.data?.badgeIncludesMine ? needsYou : 0);

  useEffect(() => {
    setBadge(badge);
    document.title = badge > 0 ? `(${badge}) Review Desk` : 'Review Desk';
  }, [badge]);

  const goTo: Shortcut[] = queueSlugs.map((slug) => ({
    keys: queueMeta[slug].keys,
    label: `Go to ${queueMeta[slug].label.toLowerCase()}`,
    group: 'Navigate',
    run: () => navigate({ to: '/inbox/$queue', params: { queue: slug } }),
  }));

  useShortcuts([
    {
      keys: '$mod+k',
      label: 'Command palette',
      group: 'General',
      allowInInput: true,
      run: () => setPaletteOpen((open) => !open),
    },
    {
      keys: '[Shift]+?',
      label: 'Keyboard shortcuts',
      group: 'General',
      run: () => setShortcutsOpen(true),
    },
    { keys: 'z', label: 'Undo last action', group: 'General', run: () => void undoLast() },
    ...goTo,
    { keys: 'g m', label: 'Go to my PRs', group: 'Navigate', run: () => navigate({ to: '/mine' }) },
    {
      keys: 'g t',
      label: 'Go to insights',
      group: 'Navigate',
      run: () => navigate({ to: '/insights' }),
    },
    {
      keys: 'g s',
      label: 'Go to settings',
      group: 'Navigate',
      run: () => navigate({ to: '/settings' }),
    },
  ]);

  return (
    <MotionProvider>
      <TooltipProvider>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-elevated focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <div className="grid h-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]">
          <Sidebar />
          {/* Eases aside for the activity drawer instead of jumping to its new width. */}
          <main
            id="main"
            className="drawer-push min-w-0 bg-panel"
            data-drawer-open={activityOpen || undefined}
          >
            {/* Every page belongs to one account: a switch remounts it, dropping unsaved edits. */}
            <Fragment key={accountScope}>
              <Enter key={section} className="h-full">
                <Outlet />
              </Enter>
            </Fragment>
          </main>
          <StatusBar hints={hintsFor(pathname)} />
        </div>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        <ActivityDrawer />
        <CheatSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <Toaster
          theme={theme}
          position="bottom-right"
          offset={40}
          toastOptions={{ className: 'text-sm' }}
          visibleToasts={3}
        />
      </TooltipProvider>
    </MotionProvider>
  );
}
