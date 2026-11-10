import { Link, useRouterState } from '@tanstack/react-router';
import {
  ChartColumn,
  ChevronsUpDown,
  GitPullRequest,
  GitPullRequestArrow,
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import { appearance, useAppearance } from '@/lib/theme';
import { useMine, usePulls, useStatus } from '@/lib/queries';
import { Avatar } from '@/ui/avatar';
import { cn } from '@/ui/cn';
import { Kbd } from '@/ui/kbd';
import { Tooltip } from '@/ui/tooltip';
import { inQueue, queueMeta, queueSlugs } from '@/features/pulls/meta';
import { AccountMenu, useSwitchingAccount } from '@/features/shell/account-menu';

const themeIcons = { light: Sun, dark: Moon, system: Monitor };

export function Sidebar() {
  const pulls = usePulls();
  const mine = useMine();
  const status = useStatus();
  const needsYou = (mine.data?.items ?? []).filter((item) => item.group === 'needs_you').length;
  const { theme } = useAppearance();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items = pulls.data?.items ?? [];
  const ThemeIcon = themeIcons[theme];
  const login = status.data?.account?.login;
  const switching = useSwitchingAccount();

  return (
    <aside
      className="flex w-[216px] flex-col border-r border-line bg-sunken"
      aria-label="Review Desk"
    >
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="grid size-6 place-items-center rounded-sm bg-accent text-accent-fg">
          <GitPullRequest size={14} strokeWidth={2.5} aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold tracking-tight">Review Desk</span>
      </div>

      <nav aria-label="Queues" className="flex flex-col gap-px px-2 pt-2">
        <div className="px-2 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
          Reviews
        </div>
        {queueSlugs.map((slug) => {
          const meta = queueMeta[slug];
          const Icon = meta.icon;
          const count = items.filter((item) => inQueue(item, slug)).length;
          const active = pathname.startsWith(`/inbox/${slug}`);

          return (
            <Tooltip key={slug} label={meta.label} shortcut={meta.keys} side="right">
              <Link
                to="/inbox/$queue"
                params={{ queue: slug }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors',
                  active
                    ? 'bg-selected font-medium text-fg'
                    : 'text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                <Icon size={15} aria-hidden="true" className={active ? 'text-accent' : ''} />
                <span className="flex-1 truncate">{meta.label}</span>
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    slug === 'attention' && count > 0
                      ? 'font-semibold text-accent'
                      : 'text-fg-subtle',
                  )}
                >
                  {count}
                </span>
              </Link>
            </Tooltip>
          );
        })}
      </nav>

      <nav aria-label="Authoring" className="mt-4 flex flex-col gap-px px-2">
        <div className="px-2 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
          Authoring
        </div>
        <Tooltip label="Your PRs and what blocks them" shortcut="g m" side="right">
          <Link
            to="/mine"
            aria-current={pathname.startsWith('/mine') ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors',
              pathname.startsWith('/mine')
                ? 'bg-selected font-medium text-fg'
                : 'text-fg-muted hover:bg-hover hover:text-fg',
            )}
          >
            <GitPullRequestArrow
              size={15}
              aria-hidden="true"
              className={pathname.startsWith('/mine') ? 'text-accent' : ''}
            />
            <span className="flex-1 truncate">My PRs</span>
            <span
              className={cn(
                'text-xs tabular-nums',
                needsYou > 0 ? 'font-semibold text-accent' : 'text-fg-subtle',
              )}
              title={`${needsYou} need you`}
            >
              {needsYou > 0 ? needsYou : (mine.data?.items.length ?? 0)}
            </span>
          </Link>
        </Tooltip>
      </nav>

      <nav aria-label="Insights" className="mt-4 flex flex-col gap-px px-2">
        <Tooltip label="Your review speed, volume and queue over time" shortcut="g t" side="right">
          <Link
            to="/insights"
            aria-current={pathname.startsWith('/insights') ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors',
              pathname.startsWith('/insights')
                ? 'bg-selected font-medium text-fg'
                : 'text-fg-muted hover:bg-hover hover:text-fg',
            )}
          >
            <ChartColumn
              size={15}
              aria-hidden="true"
              className={pathname.startsWith('/insights') ? 'text-accent' : ''}
            />
            <span className="flex-1 truncate">Insights</span>
          </Link>
        </Tooltip>
      </nav>

      <div className="mt-auto flex flex-col gap-px px-2 pb-2">
        <Link
          to="/settings"
          className={cn(
            'flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm',
            pathname.startsWith('/settings')
              ? 'bg-selected font-medium text-fg'
              : 'text-fg-muted hover:bg-hover hover:text-fg',
          )}
        >
          <Settings size={15} aria-hidden="true" />
          <span className="flex-1">Settings</span>
        </Link>
        <button
          type="button"
          onClick={appearance.cycleTheme}
          className="flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm text-fg-muted hover:bg-hover hover:text-fg"
          title="Switch between light, dark and system themes"
        >
          <ThemeIcon size={15} aria-hidden="true" />
          <span className="flex-1 text-left">
            {theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark theme' : 'Light theme'}
          </span>
        </button>
        <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
          <AccountMenu>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left hover:bg-hover data-[state=open]:bg-hover"
            >
              <Avatar login={login ?? '?'} size={22} />
              <span className="sr-only">Switch GitHub account, now</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{login ?? 'Connecting…'}</div>
                <div className="text-2xs text-fg-subtle">
                  {switching ? 'Switching…' : 'via GitHub CLI'}
                </div>
              </div>
              <ChevronsUpDown size={13} className="shrink-0 text-fg-subtle" aria-hidden="true" />
            </button>
          </AccountMenu>
          <Kbd keys="[Shift]+?" />
        </div>
      </div>
    </aside>
  );
}
