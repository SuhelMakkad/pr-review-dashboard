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
import { parseAccount } from '@review-desk/shared/accounts';
import { useMine, usePulls, useStatus } from '@/lib/queries';
import { Avatar } from '@/ui/avatar';
import { cn } from '@/ui/cn';
import { Kbd } from '@/ui/kbd';
import { IndicatorGroup } from '@/ui/motion';
import { Tooltip } from '@/ui/tooltip';
import { inQueue, queueMeta, queueSlugs } from '@/features/pulls/meta';
import { AccountMenu, useSwitchingAccount } from '@/features/shell/account-menu';
import { NavContent, navClass } from '@/features/shell/nav-item';
import { firstSettingsSlug } from '@/features/settings/sections';

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
  const account = login ? parseAccount(login) : null;
  const switching = useSwitchingAccount();
  const onMine = pathname.startsWith('/mine');
  const onInsights = pathname.startsWith('/insights');
  const onSettings = pathname.startsWith('/settings');

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

      <IndicatorGroup>
        <nav aria-label="Queues" className="flex flex-col gap-px px-2 pt-2">
          <div className="px-2 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
            Reviews
          </div>
          {queueSlugs.map((slug) => {
            const meta = queueMeta[slug];
            const count = items.filter((item) => inQueue(item, slug)).length;
            const active = pathname.startsWith(`/inbox/${slug}`);

            return (
              <Tooltip key={slug} label={meta.label} shortcut={meta.keys} side="right">
                <Link
                  to="/inbox/$queue"
                  params={{ queue: slug }}
                  aria-current={active ? 'page' : undefined}
                  className={navClass(active)}
                >
                  <NavContent
                    active={active}
                    icon={meta.icon}
                    label={meta.label}
                    trailing={
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
                    }
                  />
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
              aria-current={onMine ? 'page' : undefined}
              className={navClass(onMine)}
            >
              <NavContent
                active={onMine}
                icon={GitPullRequestArrow}
                label="My PRs"
                trailing={
                  <span
                    className={cn(
                      'text-xs tabular-nums',
                      needsYou > 0 ? 'font-semibold text-accent' : 'text-fg-subtle',
                    )}
                    title={`${needsYou} need you`}
                  >
                    {needsYou > 0 ? needsYou : (mine.data?.items.length ?? 0)}
                  </span>
                }
              />
            </Link>
          </Tooltip>
        </nav>

        <nav aria-label="Insights" className="mt-4 flex flex-col gap-px px-2">
          <Tooltip
            label="Your review speed, volume and queue over time"
            shortcut="g t"
            side="right"
          >
            <Link
              to="/insights"
              aria-current={onInsights ? 'page' : undefined}
              className={navClass(onInsights)}
            >
              <NavContent active={onInsights} icon={ChartColumn} label="Insights" />
            </Link>
          </Tooltip>
        </nav>

        <div className="mt-auto flex flex-col gap-px px-2 pb-2">
          <Link
            to="/settings/$section"
            params={{ section: firstSettingsSlug }}
            aria-current={onSettings ? 'page' : undefined}
            className={navClass(onSettings)}
          >
            <NavContent active={onSettings} icon={Settings} label="Settings" />
          </Link>
          <button
            type="button"
            onClick={appearance.cycleTheme}
            className="flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm text-fg-muted hover:bg-hover hover:text-fg"
            title="Switch between light, dark and system themes"
          >
            <ThemeIcon size={15} aria-hidden="true" />
            <span className="flex-1 text-left">
              {theme === 'system'
                ? 'System theme'
                : theme === 'dark'
                  ? 'Dark theme'
                  : 'Light theme'}
            </span>
          </button>
          <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
            <AccountMenu>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left hover:bg-hover data-[state=open]:bg-hover"
              >
                <Avatar login={account?.handle ?? '?'} size={22} />
                <span className="sr-only">
                  Switch {account?.forge === 'gitlab' ? 'GitLab' : 'GitHub'} account, now
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {account?.handle ?? 'Connecting…'}
                  </div>
                  <div className="truncate text-2xs text-fg-subtle">
                    {switching
                      ? 'Switching…'
                      : account?.forge === 'gitlab'
                        ? `${account.host} via GitLab CLI`
                        : 'via GitHub CLI'}
                  </div>
                </div>
                <ChevronsUpDown size={13} className="shrink-0 text-fg-subtle" aria-hidden="true" />
              </button>
            </AccountMenu>
            <Kbd keys="[Shift]+?" />
          </div>
        </div>
      </IndicatorGroup>
    </aside>
  );
}
