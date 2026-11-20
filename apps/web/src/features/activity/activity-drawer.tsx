import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Activity, AlertTriangle, CheckCircle2, Clock3, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  operationInProgress,
  operationLabels,
  type GitHubOperation,
  type OperationControl,
  type OperationReceipt,
} from '@review-desk/shared/operations';
import { forgeTerms } from '@review-desk/shared/accounts';
import { api } from '@/lib/api';
import { numberSign, refOf } from '@/lib/pr-ref';
import { storage } from '@/lib/storage';
import { dateTime, relativePhrase } from '@/lib/time';
import { useStatus } from '@/lib/queries';
import { Button, IconButton } from '@/ui/button';
import { DialogClose, DialogDescription, DialogTitle, Drawer } from '@/ui/dialog';
import { MarkdownView } from '@/ui/markdown';
import { ErrorState } from '@/ui/error-state';
import { Enter, ListItem, ListPresence } from '@/ui/motion';
import { Skeleton, SkeletonRegion, SkeletonText } from '@/ui/skeleton';
import { cn } from '@/ui/cn';
import { openActivity, setActivityOpen, useActivityOpen, useOperations } from './use-operations';

const controlLabels: Record<OperationControl, string> = {
  cancel: 'Cancel before sending',
  retry: 'Retry remaining steps',
  check: 'Check GitHub',
  reopen: 'Return to draft',
  dismiss: 'Dismiss notice',
  restore: 'Restore editable draft',
};

function label(operation: GitHubOperation) {
  if (operation.action.type === 'review')
    return operation.action.review.event === 'APPROVE'
      ? 'Submit approval'
      : operation.action.review.event === 'REQUEST_CHANGES'
        ? 'Request changes'
        : 'Submit review';
  if (operation.action.type === 'resolve')
    return operation.action.resolved ? 'Resolve thread' : 'Unresolve thread';
  if (operation.action.type === 'ai_review' && operation.action.event === 'APPROVE')
    return 'Approve after AI review';

  return operationLabels[operation.action.type];
}

function statusLabel(operation: GitHubOperation) {
  const forge = forgeTerms(operation.account).name;

  if (operation.status === 'needs_attention')
    return operation.error?.code === 'UNCONFIRMED' ? 'Unconfirmed' : 'Needs attention';
  if (operation.status === 'succeeded')
    return operation.result?.pending
      ? 'Added to pending review'
      : operation.action.type === 'discard'
        ? 'Completed'
        : `Confirmed by ${forge}`;

  return {
    queued: 'Queued',
    running: `Sending to ${forge}`,
    waiting: 'Waiting to retry',
    checking: `Checking ${forge}`,
    cancelled: 'Cancelled',
  }[operation.status];
}

export function ActivityButton() {
  const open = useActivityOpen();
  const account = useStatus().data?.account?.login ?? '';
  const operations = useOperations(account);
  const items = operations.data?.pages.flatMap((page) => page.items) ?? [];
  const running = items.filter((item) => operationInProgress(item.status)).length;
  const attention = items.filter(
    (item) => item.status === 'needs_attention' && !item.dismissedAt,
  ).length;

  return (
    <button
      type="button"
      onClick={openActivity}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-xs px-1 hover:bg-hover hover:text-fg',
        attention > 0 && 'text-pending',
      )}
      aria-expanded={open}
    >
      <Activity size={12} aria-hidden="true" />
      Activity
      {running > 0 && <span>{running} running</span>}
      {attention > 0 && (
        <span className="inline-flex items-center gap-1">
          <AlertTriangle size={11} aria-hidden="true" />
          {attention} {attention === 1 ? 'needs' : 'need'} attention
        </span>
      )}
      {operations.isError && <span className="text-pending">Unavailable</span>}
    </button>
  );
}

function OperationCard({ operation }: { operation: GitHubOperation }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const control = useMutation({
    mutationFn: (command: OperationControl) =>
      api<OperationReceipt>(`/api/operations/${encodeURIComponent(operation.id)}/${command}`, {
        method: 'POST',
        body: {
          account: operation.account,
          // Only once you were asked: stopping what may be on the forge needs your yes.
          confirm:
            command === 'restore' ||
            ((command === 'reopen' || command === 'cancel') &&
              Boolean(operation.confirmStop || operation.error?.code === 'UNCONFIRMED')),
        },
      }),
    onSuccess: (_receipt, command) => {
      void client.invalidateQueries({ queryKey: ['operations', operation.account] });
      void client.invalidateQueries({ queryKey: ['draft', operation.prId] });

      if (command === 'reopen') {
        storage.set(
          `review-desk-recovered:${operation.account}:${operation.prId}`,
          JSON.stringify(operation.action),
        );
        window.dispatchEvent(new Event('review-desk-recovered'));
        const { owner, repo } = refOf(operation);

        setActivityOpen(false);
        void navigate({
          to: '/pr/$owner/$repo/$number/files',
          params: { owner, repo, number: String(operation.number) },
          search: {
            ...(operation.action.type === 'reply' ? { thread: operation.action.threadId } : {}),
          },
        });
      }
    },
  });
  const attention = operation.status === 'needs_attention';
  const Icon = attention
    ? AlertTriangle
    : operation.status === 'succeeded'
      ? CheckCircle2
      : operationInProgress(operation.status)
        ? Clock3
        : Activity;
  const body =
    operation.action.type === 'review'
      ? operation.action.review.body
      : operation.action.type === 'reply'
        ? operation.action.body
        : operation.action.type === 'comment'
          ? operation.action.comment.body
          : operation.action.type === 'ai_review'
            ? operation.action.body
            : '';

  return (
    <article
      className="space-y-2 border-b border-line px-4 py-3"
      aria-label={`${label(operation)} on ${operation.repository} ${numberSign(operation.prUrl)}${operation.number}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium">{label(operation)}</h3>
        <time
          className="shrink-0 text-2xs text-fg-subtle"
          dateTime={operation.createdAt}
          title={dateTime(operation.createdAt)}
        >
          {relativePhrase(operation.createdAt)}
        </time>
      </div>
      <p className="text-xs text-fg-muted">
        <Link
          to="/pr/$owner/$repo/$number/files"
          params={{
            owner: refOf(operation).owner,
            repo: refOf(operation).repo,
            number: String(operation.number),
          }}
          search={
            operation.action.type === 'reply' || operation.action.type === 'resolve'
              ? { thread: operation.action.threadId }
              : {}
          }
          onClick={() => setActivityOpen(false)}
          className="hover:text-accent hover:underline"
        >
          {operation.repository} {numberSign(operation.prUrl)}
          {operation.number}
        </Link>{' '}
        · @{operation.account}
      </p>
      <p
        role="status"
        className={cn(
          'flex items-center gap-1.5 text-xs',
          attention
            ? 'text-pending'
            : operation.status === 'succeeded'
              ? 'text-ok'
              : 'text-fg-muted',
        )}
      >
        <Icon size={13} aria-hidden="true" />
        {statusLabel(operation)}
      </p>
      <p className="text-xs">{operation.progress}</p>
      {operation.error && <p className="text-xs text-pending">{operation.error.message}</p>}
      {operation.retryAt && (
        <p className="text-xs text-fg-muted">Next attempt: {dateTime(operation.retryAt)}.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {operation.controls.map((command) => (
          <Button
            key={command}
            size="sm"
            variant={command === 'dismiss' ? 'ghost' : 'secondary'}
            disabled={control.isPending}
            onClick={() => {
              if (
                command === 'restore' &&
                !window.confirm(
                  'Remove this pending review from GitHub and restore an editable local draft? Its current content will be saved in Activity first.',
                )
              )
                return;
              if (
                command === 'reopen' &&
                (operation.confirmStop || operation.error?.code === 'UNCONFIRMED') &&
                !window.confirm(
                  'Have you checked GitHub and confirmed this action did not post? Sending it again could create a duplicate.',
                )
              )
                return;
              if (
                command === 'cancel' &&
                (operation.confirmStop || operation.error?.code === 'UNCONFIRMED') &&
                !window.confirm(
                  'This may already be on GitHub. Stop tracking it here? Check the PR before posting it another way.',
                )
              )
                return;

              control.mutate(command);
            }}
          >
            {command === 'reopen' && operation.error?.code === 'HEAD_MOVED'
              ? 'Review new commits'
              : command === 'cancel' && operation.action.type === 'ai_review'
                ? "Don't post"
                : command === 'check'
                  ? `Check ${forgeTerms(operation.account).name}`
                  : controlLabels[command]}
          </Button>
        ))}
        <a
          href={operation.result?.url ?? operation.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 px-1 py-1 text-xs text-accent hover:underline"
        >
          Open {forgeTerms(operation.account).name} <ExternalLink size={11} aria-hidden="true" />
        </a>
      </div>
      {control.error && (
        <p role="alert" className="text-xs text-fail">
          {control.error.message}
        </p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer py-1 text-fg-muted">Saved content and details</summary>
        <div className="mt-2 space-y-3 break-words rounded-md border border-line bg-sunken p-3">
          <p>{operation.title}</p>
          <p className="text-fg-muted">
            Queued {dateTime(operation.createdAt)}
            {operation.finishedAt ? ` · Finished ${dateTime(operation.finishedAt)}` : ''}
          </p>
          {operation.action.type === 'review' && (
            <p>
              Reviewed commit: <code>{operation.action.review.expectedHeadOid.slice(0, 7)}</code>
            </p>
          )}
          {operation.action.type === 'ai_review' && (
            <p>
              Posted automatically from an AI review of{' '}
              <code>{operation.action.expectedHeadOid.slice(0, 7)}</code>.
            </p>
          )}
          {body && <MarkdownView>{body}</MarkdownView>}
          {operation.action.type === 'review' &&
            operation.action.draft.comments.map((comment) => (
              <div key={comment.id}>
                <code>
                  {comment.path}
                  {comment.line ? `:${comment.line}` : ''}
                </code>
                <MarkdownView>{comment.body}</MarkdownView>
              </div>
            ))}
          {operation.action.type === 'viewed' && (
            <p>
              {operation.action.path} · {operation.action.viewed ? 'Viewed' : 'Unviewed'}
            </p>
          )}
          {operation.action.type === 'reviewers' && (
            <p>Reviewers: {operation.action.logins.join(', ')}</p>
          )}
          {operation.savedPendingReview && (
            <section
              className="space-y-2 border-t border-line pt-2"
              aria-label="Saved GitHub pending review"
            >
              <h4 className="font-medium">GitHub pending content saved before recovery</h4>
              {operation.savedPendingReview.body && (
                <MarkdownView>{operation.savedPendingReview.body}</MarkdownView>
              )}
              {operation.savedPendingReview.comments.map((comment) => (
                <div key={comment.id}>
                  <code>
                    {comment.path}
                    {comment.line ? `:${comment.line}` : ''}
                  </code>
                  <MarkdownView>{comment.body}</MarkdownView>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void navigator.clipboard.writeText(comment.body).then(
                        () => toast('Saved comment copied'),
                        () => toast.error('Could not copy comment'),
                      )
                    }
                  >
                    Copy comment
                  </Button>
                </div>
              ))}
            </section>
          )}
          {body && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard.writeText(body).then(
                  () => toast('Saved text copied'),
                  () => toast.error('Could not copy saved text'),
                )
              }
            >
              Copy saved text
            </Button>
          )}
        </div>
      </details>
    </article>
  );
}

export function ActivityDrawer() {
  const open = useActivityOpen();
  const account = useStatus().data?.account?.login ?? '';
  const operations = useOperations(account);
  const notices = useRef<Record<string, string> | null>(null);
  const noticeAccount = useRef('');
  const items = operations.data?.pages.flatMap((page) => page.items) ?? [];

  useEffect(() => {
    if (!account || !operations.data) return;

    if (noticeAccount.current !== account) {
      noticeAccount.current = account;
      try {
        notices.current = JSON.parse(storage.get(`operation-notices:${account}`) ?? '{}');
      } catch {
        notices.current = {};
      }
    }

    const seen = notices.current ?? {};

    for (const operation of items) {
      const signature = `${operation.status}:${operation.error?.code ?? ''}`;
      if (seen[operation.id] === signature) continue;

      if (operation.status === 'needs_attention' && !operation.dismissedAt) {
        toast.error(`${label(operation)} needs attention`, {
          description: `${operation.repository} #${operation.number}`,
          action: { label: 'View activity', onClick: openActivity },
        });
      } else if (
        operation.status === 'succeeded' &&
        seen[operation.id] &&
        operation.action.type !== 'viewed'
      ) {
        toast(
          operation.result?.pending
            ? 'Added to your pending review on GitHub'
            : `${label(operation)} completed`,
          {
            description: `${operation.repository} #${operation.number}`,
            action: { label: 'View activity', onClick: openActivity },
          },
        );
      }

      seen[operation.id] = signature;
    }

    notices.current = seen;
    storage.set(`operation-notices:${account}`, JSON.stringify(seen));
  }, [account, operations.data]);

  const groups = [
    {
      title: 'Needs attention',
      items: items.filter((item) => item.status === 'needs_attention' && !item.dismissedAt),
    },
    { title: 'In progress', items: items.filter((item) => operationInProgress(item.status)) },
    {
      title: 'Recent',
      items: items
        .filter((item) => ['succeeded', 'cancelled'].includes(item.status) || item.dismissedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    },
  ];

  return (
    <Drawer
      open={open}
      onOpenChange={setActivityOpen}
      aria-describedby="activity-description"
      onInteractOutside={(event) => event.preventDefault()}
      className="top-0 bottom-7 z-40 flex w-(--drawer-w) max-w-full flex-col"
    >
      <header className="flex items-start justify-between border-b border-line px-4 py-4">
        <div>
          <DialogTitle className="text-base font-semibold">Activity</DialogTitle>
          <DialogDescription id="activity-description" className="mt-1 text-xs text-fg-muted">
            {forgeTerms(account).name} actions · saved on this device
          </DialogDescription>
        </div>
        <DialogClose asChild>
          <IconButton size="sm" label="Close activity" icon={<X size={15} />} />
        </DialogClose>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" aria-busy={operations.isPending}>
        {/* Loading and failure ease in; the loaded groups then animate their own changes. */}
        {operations.isPending && (
          <Enter key="loading" preset="fade">
            <SkeletonRegion label="Loading activity…">
              <div className="px-4 pt-4 pb-2">
                <Skeleton className="h-2.5 w-24" />
              </div>
              {[0, 1, 2].map((index) => (
                <div key={index} className="space-y-2 border-b border-line px-4 py-3">
                  <Skeleton className="h-3.5 w-1/2" />
                  <SkeletonText lines={2} />
                </div>
              ))}
            </SkeletonRegion>
          </Enter>
        )}
        {operations.error && (
          <Enter key="error" preset="fade" className="grid place-items-center pt-6">
            <ErrorState
              title="Could not load activity"
              error={operations.error}
              onRetry={() => void operations.refetch()}
            />
          </Enter>
        )}
        {/* An action moving from In progress to Recent leaves one group and arrives in the next. */}
        <ListPresence>
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <ListItem key={group.title}>
                <section aria-label={group.title}>
                  <h2 className="px-4 pt-4 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
                    {group.title} · {group.items.length}
                  </h2>
                  <ListPresence>
                    {group.items.map((operation) => (
                      <ListItem key={operation.id}>
                        <OperationCard operation={operation} />
                      </ListItem>
                    ))}
                  </ListPresence>
                </section>
              </ListItem>
            ))}
        </ListPresence>
        {!operations.isPending && !operations.error && items.length === 0 && (
          <Enter key="empty" preset="fade">
            <p className="p-4 text-sm text-fg-muted">
              Your {forgeTerms(account).name} actions and their results will appear here.
            </p>
          </Enter>
        )}
        {operations.hasNextPage && (
          <div className="p-4">
            <Button
              size="sm"
              disabled={operations.isFetchingNextPage}
              onClick={() => void operations.fetchNextPage()}
            >
              {operations.isFetchingNextPage ? 'Loading…' : 'Load older actions'}
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
