import { Link, Navigate, useRouterState } from '@tanstack/react-router';
import { relativeRoot } from '@/lib/pr-ref';
import { useStatus } from '@/lib/queries';
import { EmptyState } from '@/ui/empty-state';

/**
 * A GitLab MR address with this app's host in place of GitLab's, such as
 * `/group/sub/project/-/merge_requests/12/diffs`. Nested groups make it any depth, so it cannot be
 * a route of its own; GitHub's `owner/repo/pull/12` is.
 */
const GITLAB_PATH = /^\/((?:[\w.-]+\/)+)([\w.-]+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/;

/** A GitLab served under a path (`https://example.com/gitlab`) keeps that path in its MR links. */
function withoutRoot(namespace: string, webUrl: string | undefined): string {
  const root = relativeRoot(webUrl);

  return root && namespace.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? namespace.slice(root.length + 1)
    : namespace;
}

export function NotFound() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const status = useStatus();
  const webUrl = status.data?.account?.webUrl;
  const gitlab = GITLAB_PATH.exec(decodeURI(pathname));

  // The account's address tells whether the path starts with a relative URL root.
  if (gitlab && status.isPending) return null;

  if (gitlab && Number(gitlab[3]) > 0)
    return (
      <Navigate
        to="/pr/$owner/$repo/$number"
        params={{
          owner: withoutRoot(gitlab[1].slice(0, -1), webUrl),
          repo: gitlab[2],
          number: gitlab[3],
        }}
        replace
      />
    );

  return (
    <div className="grid h-full place-items-center">
      <EmptyState
        title="Nothing at this address"
        hint="That page does not exist in Review Desk."
        action={
          <Link
            to="/inbox/$queue"
            params={{ queue: 'attention' }}
            className="text-accent underline"
          >
            Go to your inbox
          </Link>
        }
      />
    </div>
  );
}
