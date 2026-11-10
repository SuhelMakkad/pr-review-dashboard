import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { inboxSearchSchema } from '@/features/inbox/filters';
import { InboxPage } from '@/features/inbox/inbox-page';
import { InboxReader } from '@/features/inbox/inbox-reader';
import { queueSlugs, type QueueSlug } from '@/features/pulls/meta';
import { PullLayout } from '@/features/pulls/pull-layout';
import { PullOverview } from '@/features/pulls/pull-overview';
import { filesSearchSchema } from '@/features/review/search';
import { SettingsPage } from '@/features/settings/settings-page';
import { MinePage } from '@/features/mine/mine-page';
import { MineReader } from '@/features/mine/mine-reader';
import { AppError, RouteError } from '@/features/shell/error-page';
import { NotFound } from '@/features/shell/not-found';
import { Shell } from '@/features/shell/shell';

// A crash in a page shows `RouteError` in place of that page (every route gets the default);
// a crash in the frame itself falls back to the full-window `AppError`.
const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
  errorComponent: AppError,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/inbox/$queue', params: { queue: 'attention' } });
  },
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'inbox/$queue',
  validateSearch: inboxSearchSchema,
  beforeLoad: ({ params }) => {
    if (!queueSlugs.includes(params.queue as QueueSlug)) {
      throw redirect({ to: '/inbox/$queue', params: { queue: 'attention' } });
    }
  },
  component: InboxPage,
});

const inboxPullRoute = createRoute({
  getParentRoute: () => inboxRoute,
  path: '$owner/$repo/$number',
  component: InboxReader,
});

const pullRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'pr/$owner/$repo/$number',
  component: PullLayout,
});

const pullOverviewRoute = createRoute({
  getParentRoute: () => pullRoute,
  path: '/',
  component: PullOverview,
});

const pullFilesRoute = createRoute({
  getParentRoute: () => pullRoute,
  path: 'files',
  validateSearch: filesSearchSchema,
  // The diff renderer and syntax highlighter load only when a diff is opened.
  component: lazyRouteComponent(
    () => import('@/features/review/files-workspace'),
    'FilesWorkspace',
  ),
});

/** Swap github.com for this app's host in any PR URL and it opens here. */
const githubPullRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$owner/$repo/pull/$number',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/pr/$owner/$repo/$number', params });
  },
});

const githubPullTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$owner/$repo/pull/$number/$tab',
  beforeLoad: ({ params }) => {
    const target = { owner: params.owner, repo: params.repo, number: params.number };

    if (params.tab === 'files')
      throw redirect({ to: '/pr/$owner/$repo/$number/files', params: target });

    throw redirect({ to: '/pr/$owner/$repo/$number', params: target });
  },
});

const mineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'mine',
  component: MinePage,
});

const minePullRoute = createRoute({
  getParentRoute: () => mineRoute,
  path: '$owner/$repo/$number',
  component: MineReader,
});

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'insights',
  component: lazyRouteComponent(() => import('@/features/insights/insights-page'), 'InsightsPage'),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute.addChildren([inboxPullRoute]),
  pullRoute.addChildren([pullOverviewRoute, pullFilesRoute]),
  githubPullRoute,
  githubPullTabRoute,
  mineRoute.addChildren([minePullRoute]),
  insightsRoute,
  settingsRoute,
]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    history: options.history,
    defaultPreload: false,
    defaultErrorComponent: RouteError,
    scrollRestoration: false,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
