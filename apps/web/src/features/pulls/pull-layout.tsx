import { Link, Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { filesUrl, isGitLabUrl, numberSign } from '@/lib/pr-ref';
import { usePulls, useMine } from '@/lib/queries';
import { useShortcuts } from '@/lib/shortcuts';
import { follow } from '@/lib/navigation';
import { IconButton } from '@/ui/button';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';
import { Kbd } from '@/ui/kbd';
import { ActiveIndicator, Enter, IndicatorGroup } from '@/ui/motion';
import { PullSkeleton } from '@/features/pulls/pull-skeleton';
import { useCurrentPull } from '@/features/pulls/use-current-pull';
import { NotTrackedActions } from '@/features/pulls/use-track';

const tabClass = (active: boolean) =>
  cn(
    'relative inline-flex h-12 items-center gap-1.5 px-3 text-sm transition-colors',
    active ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
  );

/** The active tab's underline; it glides to whichever tab becomes active. */
const TabUnderline = () => <ActiveIndicator variant="underline" />;

/** Frame for a single PR: header, Overview / Files tabs, and the not-tracked state. */
export function PullLayout() {
  const router = useRouter();
  const navigate = useNavigate();
  const pulls = usePulls();
  const mine = useMine();
  const { ref, item } = useCurrentPull();
  const onFiles = useRouterState({ select: (state) => state.location.pathname.endsWith('/files') });
  const params = ref ? { owner: ref.owner, repo: ref.repo, number: String(ref.number) } : null;

  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else follow(navigate({ to: '/inbox/$queue', params: { queue: 'attention' } }));
  };

  useShortcuts([
    { keys: 'Escape', label: 'Back', group: 'Navigate', run: back },
    {
      keys: '1',
      label: 'Overview',
      group: 'Pull request',
      run: () => {
        if (params) follow(navigate({ to: '/pr/$owner/$repo/$number', params }));
      },
    },
    {
      keys: '2',
      label: 'Files',
      group: 'Pull request',
      run: () => {
        if (params) follow(navigate({ to: '/pr/$owner/$repo/$number/files', params, search: {} }));
      },
    },
  ]);

  const loaded = Boolean(pulls.data && mine.data);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-3 pl-2">
        <IconButton label="Back" icon={<ArrowLeft size={16} />} onClick={back} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs text-fg-subtle">
            {ref ? `${ref.owner}/${ref.repo}` : ''} {numberSign(item?.url)}
            {ref?.number}
          </span>
          <span className="truncate text-sm font-medium">{item?.title}</span>
        </div>
        {params && item && (
          <IndicatorGroup>
            <nav aria-label="Pull request sections" className="flex shrink-0 items-center">
              <Link to="/pr/$owner/$repo/$number" params={params} className={tabClass(!onFiles)}>
                {!onFiles && <TabUnderline />}
                Overview <Kbd keys="1" />
              </Link>
              <Link
                to="/pr/$owner/$repo/$number/files"
                params={params}
                search={{}}
                className={tabClass(onFiles)}
              >
                {onFiles && <TabUnderline />}
                Files
                <span className="text-xs text-fg-subtle tabular-nums">{item.changedFiles}</span>
                <Kbd keys="2" />
              </Link>
            </nav>
          </IndicatorGroup>
        )}
        {item && (
          <a
            href={onFiles ? filesUrl(item.url) : item.url}
            target="_blank"
            rel="noreferrer"
            className="ml-2 inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-xs text-fg-muted hover:bg-hover hover:text-fg"
          >
            {isGitLabUrl(item.url) ? 'GitLab' : 'GitHub'}{' '}
            <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        )}
      </header>
      <div className="min-h-0 flex-1">
        {item ? (
          <Enter key={onFiles ? 'files' : 'overview'} preset="fade" className="h-full">
            <Outlet />
          </Enter>
        ) : loaded ? (
          <div className="grid h-full place-items-center">
            <EmptyState
              title="This PR isn't in your review workload"
              hint="Review Desk tracks PRs requesting your review, assigned to you, reviewed by you, or authored by you. You can add any other open PR yourself."
              action={ref && <NotTrackedActions pullRef={ref} />}
            />
          </div>
        ) : (
          <PullSkeleton variant="page" />
        )}
      </div>
    </div>
  );
}
