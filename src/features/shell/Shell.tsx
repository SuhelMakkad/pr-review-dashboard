import { useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { useShortcuts, type Shortcut } from '../../lib/shortcuts';
import { useAppearance } from '../../lib/theme';
import { TooltipProvider } from '../../ui/Tooltip';
import { undoLast } from '../pulls/actions';
import { queueMeta, queueSlugs } from '../pulls/meta';
import { CheatSheet } from './CheatSheet';
import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';
import { StatusBar, type Hint } from './StatusBar';

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
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { theme } = useAppearance();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
      keys: 'g s',
      label: 'Go to settings',
      group: 'Navigate',
      run: () => navigate({ to: '/settings' }),
    },
  ]);

  return (
    <TooltipProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-elevated focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <div className="grid h-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]">
        <Sidebar />
        <main id="main" className="min-w-0 bg-panel">
          <Outlet />
        </main>
        <StatusBar hints={hintsFor(pathname)} />
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      <CheatSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <Toaster
        theme={theme}
        position="bottom-right"
        offset={40}
        toastOptions={{ className: 'text-sm' }}
        visibleToasts={3}
      />
    </TooltipProvider>
  );
}
