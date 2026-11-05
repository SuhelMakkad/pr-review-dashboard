import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import type { ReviewThread } from '../../../shared/types';
import { dateTime, relativePhrase } from '../../lib/time';
import { Avatar } from '../../ui/Avatar';
import { cn } from '../../ui/cn';
import { MarkdownView } from '../../ui/Markdown';
import { tone } from '../pulls/meta';

/** An inline review thread rendered under its line in the diff. Resolved threads start folded. */
export function ThreadCard({
  thread,
  account,
  unread,
  focused,
}: {
  thread: ReviewThread;
  account: string;
  unread: Set<string>;
  focused?: boolean;
}) {
  const [open, setOpen] = useState(!thread.isResolved || focused);
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
        </div>
      )}
    </div>
  );
}
