import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ArrowUpRight, CircleCheck, CircleDot, RotateCcw } from 'lucide-react';
import type { AuthorItem, Blocker } from '@review-desk/shared/author';
import { githubCommand } from '@/lib/operation-command';
import { openActivity } from '@/features/activity/use-operations';
import { useOperations } from '@/features/activity/use-operations';
import { operationUnsettled } from '@review-desk/shared/operations';
import { refOf } from '@/lib/pr-ref';
import { queryKeys } from '@/lib/query-keys';
import { relativePhrase } from '@/lib/time';
import { Button } from '@/ui/button';
import { blockerTone, groupMeta, waitState } from '@/features/mine/meta';

/** What stands between your PR and merging, each item with the next step to clear it. */
export function AuthorBlockers({ item, account }: { item: AuthorItem; account: string }) {
  const client = useQueryClient();
  const ref = refOf(item);
  const params = { owner: ref.owner, repo: ref.repo, number: String(ref.number) };
  const wait = waitState(item);
  const operations = useOperations(account);
  const queuedRequest = operations.data?.pages
    .flatMap((page) => page.items)
    .some(
      (operation) =>
        operation.prId === item.id &&
        operation.action.type === 'reviewers' &&
        operationUnsettled(operation.status),
    );
  const rerequest = useMutation({
    mutationFn: (logins: string[]) =>
      githubCommand(`/api/pulls/${encodeURIComponent(item.id)}/reviewers`, { account, logins }),
    onSuccess: (_result, logins) => {
      toast(`Review request queued for ${logins.join(', ')}`, {
        action: { label: 'View activity', onClick: openActivity },
      });
      void client.invalidateQueries({ queryKey: ['operations', account] });
      void client.invalidateQueries({ queryKey: queryKeys.mine });
    },
    onError: (error) => toast.error(error.message),
  });

  const action = (blocker: Blocker) => {
    switch (blocker.kind) {
      case 'ci_failing':
      case 'ci_pending':
        return (
          <a
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            href={`${item.url}/checks`}
            target="_blank"
            rel="noreferrer"
          >
            Open checks <ArrowUpRight size={11} />
          </a>
        );
      case 'conflicts':
      case 'behind':
        return (
          <a
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            href={item.url}
            target="_blank"
            rel="noreferrer"
          >
            Update the branch on GitHub <ArrowUpRight size={11} />
          </a>
        );
      case 'unanswered_threads':
        return (
          <Link
            to="/pr/$owner/$repo/$number/files"
            params={params}
            search={{}}
            className="text-xs text-accent hover:underline"
          >
            Reply in the workspace
          </Link>
        );
      case 'changes_requested':
      case 'no_reviewers':
      case 'awaiting_review':
        return blocker.people && blocker.people.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={12} />}
            disabled={rerequest.isPending || queuedRequest}
            onClick={() =>
              rerequest.mutate(blocker.people!.filter((login) => !login.includes('/')))
            }
          >
            {queuedRequest
              ? 'Review request queued'
              : blocker.kind === 'awaiting_review'
                ? 'Nudge with a re-request'
                : `Ask ${blocker.people.slice(0, 2).join(', ')} to review`}
          </Button>
        ) : (
          <a
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            href={item.url}
            target="_blank"
            rel="noreferrer"
          >
            Request reviewers on GitHub <ArrowUpRight size={11} />
          </a>
        );
      default:
        return null;
    }
  };

  return (
    <section
      aria-label="What blocks this PR"
      className="mx-6 mb-4 rounded-md border border-line bg-sunken px-3 py-2.5"
    >
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-semibold text-fg">{groupMeta[item.group].label}</span>
        <span className="text-fg-muted">{groupMeta[item.group].hint}</span>
      </div>
      {item.blockers.length === 0 ? (
        <p className="flex items-center gap-2 text-sm">
          <CircleCheck size={14} className="text-ok" aria-hidden="true" />
          {item.group === 'ready'
            ? `Approved by ${item.approvals.join(', ')} and ready to merge.`
            : 'Nothing is blocking this PR.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {item.blockers.map((blocker) => (
            <li key={blocker.kind} className="flex items-center gap-2 text-sm">
              <CircleDot
                size={13}
                style={{ color: `var(--${blockerTone[blocker.kind]})` }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                {blocker.label}
                {blocker.since && (
                  <span className="text-xs text-fg-subtle">
                    {' '}
                    · since {relativePhrase(blocker.since)}
                  </span>
                )}
                {blocker.actor !== 'you' && (
                  <span className="text-xs text-fg-subtle">
                    {' '}
                    · {blocker.actor === 'ci' ? 'waiting on CI' : 'their move'}
                  </span>
                )}
              </span>
              {action(blocker)}
            </li>
          ))}
        </ul>
      )}
      {wait && wait.tone !== 'ok' && item.group === 'waiting' && (
        <p className="mt-2 text-xs" style={{ color: `var(--${wait.tone})` }}>
          Waiting {wait.hours} hours for review — past the{' '}
          {wait.tone === 'fail' ? 'two-day' : 'one-day'} mark.
        </p>
      )}
    </section>
  );
}
