import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { inboxSearchSchema } from './features/inbox/filters';
import { InboxPage } from './features/inbox/InboxPage';
import { InboxReader } from './features/inbox/InboxReader';
import { queueSlugs, type QueueSlug } from './features/pulls/meta';
import { PullLayout } from './features/pulls/PullLayout';
import { PullOverview } from './features/pulls/PullOverview';
import { filesSearchSchema } from './features/review/search';
import { SettingsPage } from './features/settings/SettingsPage';
import { MinePage } from './features/mine/MinePage';
import { MineReader } from './features/mine/MineReader';
import { NotFound } from './features/shell/NotFound';
import { Shell } from './features/shell/Shell';

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

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
  component: lazyRouteComponent(() => import('./features/review/FilesWorkspace'), 'FilesWorkspace'),
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
  settingsRoute,
]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    history: options.history,
    defaultPreload: false,
    scrollRestoration: false,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
