import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCheck, ChevronRight, MessageSquare, Reply, RotateCcw } from 'lucide-react';
import type { ReviewThread } from '@review-desk/shared/types';
import { isSameUser } from '@review-desk/shared/accounts';
import type { GitHubOperation, OperationReceipt } from '@review-desk/shared/operations';
import { operationUnsettled } from '@review-desk/shared/operations';
import { openActivity } from '@/features/activity/use-operations';
import { dateTime, relativePhrase } from '@/lib/time';
import { Avatar } from '@/ui/avatar';
import { cn } from '@/ui/cn';
import { MarkdownView } from '@/ui/markdown';
import { FadeSwap, Reveal } from '@/ui/motion';
import { tone } from '@/features/pulls/meta';
import { Button } from '@/ui/button';
import { Composer } from '@/features/review/composer';

export interface ThreadActions {
  replying: boolean;
  setReplying: (replying: boolean) => void;
  reply: (body: string) => Promise<OperationReceipt>;
  resolve: (resolved: boolean) => Promise<unknown>;
  busy: boolean;
  locked?: boolean;
  resolution?: GitHubOperation;
}

/** An inline review thread rendered under its line in the diff. Resolved threads start folded. */
export function ThreadCard({
  thread,
  account,
  unread,
  focused,
  actions,
  queuedReplies = [],
  recoveredBody,
}: {
  thread: ReviewThread;
  account: string;
  unread: Set<string>;
  focused?: boolean;
  actions?: ThreadActions;
  queuedReplies?: GitHubOperation[];
  recoveredBody?: string;
}) {
  const [open, setOpen] = useState(!thread.isResolved || Boolean(focused));
  const [error, setError] = useState<string | null>(null);
  const newCount = thread.comments.filter((comment) =>
    unread.has(`${comment.id}:${comment.updatedAt}`),
  ).length;
  const first = thread.comments[0];

  return (
    <div
      data-thread-id={thread.id}
      className={cn(
        'my-2 mr-4 ml-2 overflow-hidden rounded-md border bg-panel font-sans text-fg shadow-sm',
        focused ? 'border-accent ring-2 ring-accent/30' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-sunken px-3 py-1.5 text-left text-xs"
        aria-expanded={open}
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn('transition-transform', open && 'rotate-90')}
        />
        <MessageSquare size={12} className="text-fg-subtle" aria-hidden="true" />
        <span className="font-medium">{first?.author.login}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{open ? '' : first?.body}</span>
        {newCount > 0 && (
          <span className="tone rounded-xs px-1 text-2xs font-semibold" style={tone('reply')}>
            {newCount} new
          </span>
        )}
        <span
          className="tone rounded-xs px-1.5 text-2xs font-medium"
          style={tone(thread.isResolved ? 'ok' : 'neutral')}
        >
          {thread.isResolved
            ? 'Resolved'
            : `${thread.comments.length} ${thread.comments.length === 1 ? 'comment' : 'comments'}`}
        </span>
      </button>
      {/* Lives in the diff virtualizer, so it fades rather than changing height mid-animation. */}
      <Reveal show={open} preset="fade">
        <div className="relative divide-y divide-line">
          {thread.comments.map((comment) => {
            const isUnread = unread.has(`${comment.id}:${comment.updatedAt}`);

            return (
              <div key={comment.id} className={cn('px-3 py-2', isUnread && 'bg-reply/8')}>
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <Avatar login={comment.author.login} size={16} />
                  <span className="font-medium">{comment.author.login}</span>
                  {isSameUser(comment.author.login, account) && (
                    <span className="text-fg-subtle">you</span>
                  )}
                  <a
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-fg-subtle hover:text-fg"
                    title={dateTime(comment.createdAt)}
                  >
                    {relativePhrase(comment.createdAt)}
                  </a>
                </div>
                <MarkdownView>{comment.body}</MarkdownView>
              </div>
            );
          })}
          {queuedReplies
            .filter(
              (operation) => operationUnsettled(operation.status) || operation.result?.pending,
            )
            .map((operation) => (
              <div
                key={operation.id}
                className="space-y-1 border-l-2 border-dashed border-accent/50 px-3 py-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-fg-muted">
                    {operation.status === 'needs_attention'
                      ? 'Reply needs attention'
                      : operation.result?.pending
                        ? 'Added to your pending review on GitHub'
                        : 'Reply queued · not confirmed yet'}
                  </span>
                  <button
                    type="button"
                    onClick={openActivity}
                    className="text-accent hover:underline"
                  >
                    View activity
                  </button>
                </div>
                {operation.action.type === 'reply' && (
                  <MarkdownView>{operation.action.body}</MarkdownView>
                )}
              </div>
            ))}
          {actions && (
            // The reply box mounts at once (it takes focus) while the buttons fade out above it.
            <FadeSwap swapKey={actions.replying ? 'reply' : 'actions'} mode="popLayout">
              {actions.replying ? (
                <div className="p-2">
                  <Composer
                    label="Reply to thread"
                    placeholder="Reply…"
                    initial={recoveredBody}
                    busy={actions.busy}
                    error={error}
                    onCancel={() => {
                      setError(null);
                      actions.setReplying(false);
                    }}
                    primary={{
                      label: `Reply as @${account}`,
                      keys: '$mod+Enter',
                      variant: 'primary',
                      run: async (body) => {
                        try {
                          await actions.reply(body);

                          setError(null);
                          actions.setReplying(false);
                          toast('Reply queued', {
                            action: { label: 'View activity', onClick: openActivity },
                          });
                        } catch (failure) {
                          setError((failure as Error).message);
                        }
                      },
                    }}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-1 bg-sunken/60 px-2 py-1">
                  {thread.viewerCanReply !== false && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Reply size={12} />}
                      onClick={() => actions.setReplying(true)}
                      disabled={actions.locked}
                      shortcut={focused ? 'r' : undefined}
                    >
                      Reply
                    </Button>
                  )}
                  {thread.viewerCanResolve !== false && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={thread.isResolved ? <RotateCcw size={12} /> : <CheckCheck size={12} />}
                      disabled={actions.busy || Boolean(actions.resolution)}
                      onClick={() =>
                        void actions
                          .resolve(!thread.isResolved)
                          .catch((failure: Error) => toast.error(failure.message))
                      }
                      shortcut={focused ? 'Shift+r' : undefined}
                    >
                      {actions.resolution
                        ? actions.resolution.status === 'needs_attention'
                          ? 'Resolution needs attention'
                          : 'Resolution queued'
                        : thread.isResolved
                          ? 'Unresolve'
                          : 'Resolve'}
                    </Button>
                  )}
                  {actions.resolution && (
                    <Button size="sm" variant="ghost" onClick={openActivity}>
                      View activity
                    </Button>
                  )}
                </div>
              )}
            </FadeSwap>
          )}
        </div>
      </Reveal>
    </div>
  );
}
