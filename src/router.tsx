import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { inboxSearchSchema } from './features/inbox/filters';
import { InboxPage } from './features/inbox/InboxPage';
import { InboxReader } from './features/inbox/InboxReader';
import { queueSlugs, type QueueSlug } from './features/pulls/meta';
import { PullPage } from './features/pulls/PullPage';
import { SettingsPage } from './features/settings/SettingsPage';
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
  component: PullPage,
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
    throw redirect({
      to: '/pr/$owner/$repo/$number',
      params: { owner: params.owner, repo: params.repo, number: params.number },
    });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute.addChildren([inboxPullRoute]),
  pullRoute,
  githubPullRoute,
  githubPullTabRoute,
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
