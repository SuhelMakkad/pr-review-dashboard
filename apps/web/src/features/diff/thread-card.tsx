import { useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Reply,
  RotateCcw,
} from 'lucide-react';
import type { ReviewThread } from '../../../../../packages/shared/src/types';
import { dateTime, relativePhrase } from '../../lib/time';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { MarkdownView } from '../../ui/markdown';
import { tone } from '../pulls/meta';
import { Button } from '../../ui/button';
import { Composer } from '../review/composer';

export interface ThreadActions {
  replying: boolean;
  setReplying: (replying: boolean) => void;
  reply: (body: string) => Promise<{ pending: boolean }>;
  resolve: (resolved: boolean) => Promise<unknown>;
  busy: boolean;
}

/** An inline review thread rendered under its line in the diff. Resolved threads start folded. */
export function ThreadCard({
  thread,
  account,
  unread,
  focused,
  actions,
}: {
  thread: ReviewThread;
  account: string;
  unread: Set<string>;
  focused?: boolean;
  actions?: ThreadActions;
}) {
  const [open, setOpen] = useState(!thread.isResolved || focused);
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
        {open ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
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
      {open && (
        <div className="divide-y divide-line">
          {thread.comments.map((comment) => {
            const isUnread = unread.has(`${comment.id}:${comment.updatedAt}`);

            return (
              <div key={comment.id} className={cn('px-3 py-2', isUnread && 'bg-reply/8')}>
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <Avatar login={comment.author.login} size={16} />
                  <span className="font-medium">{comment.author.login}</span>
                  {comment.author.login.toLowerCase() === account.toLowerCase() && (
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
          {actions &&
            (actions.replying ? (
              <div className="p-2">
                <Composer
                  label="Reply to thread"
                  placeholder="Reply…"
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
                        const result = await actions.reply(body);

                        setError(null);
                        actions.setReplying(false);
                        toast(
                          result.pending
                            ? 'Reply added to your pending review on GitHub'
                            : 'Reply posted',
                        );
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
                    disabled={actions.busy}
                    onClick={() =>
                      void actions
                        .resolve(!thread.isResolved)
                        .catch((failure: Error) => toast.error(failure.message))
                    }
                    shortcut={focused ? 'Shift+r' : undefined}
                  >
                    {thread.isResolved ? 'Unresolve' : 'Resolve'}
                  </Button>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
