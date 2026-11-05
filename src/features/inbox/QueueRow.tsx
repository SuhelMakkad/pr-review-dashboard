import { forwardRef } from 'react';
import { AlarmClock, CheckCheck, MessageSquare, StickyNote } from 'lucide-react';
import type { PullRequestItem } from '../../../shared/types';
import { shortAge, shortDateTime } from '../../lib/time';
import { Avatar } from '../../ui/Avatar';
import { LinearMark } from '../../ui/brand-icons';
import { cn } from '../../ui/cn';
import { CiIndicator, ReasonChips, reviewSummary } from '../pulls/meta';

/**
 * One PR in a queue. Comfortable density: title on the first line, the reasons it is here and its
 * context on the second. Compact density collapses to the first line plus reason chips.
 */
export const QueueRow = forwardRef<
  HTMLDivElement,
  {
    item: PullRequestItem;
    selected: boolean;
    onSelect: () => void;
    onOpen: () => void;
  }
>(function QueueRow({ item, selected, onSelect, onOpen }, ref) {
  const unread = item.queue === 'attention';

  return (
    <div
      ref={ref}
      id={`row-${item.id}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        'group relative flex min-h-[var(--row-h)] cursor-default items-center gap-3 border-b border-line py-1.5 pr-4 pl-3 select-none',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      {selected && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-selected-line" aria-hidden="true" />
      )}

      <span
        className={cn('size-1.5 shrink-0 rounded-full', unread ? 'bg-accent' : 'bg-transparent')}
        aria-hidden="true"
      />

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm text-fg',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {item.title}
          </span>
          {item.isDraft && (
            <span className="shrink-0 rounded-xs border border-line-strong px-1 text-2xs text-fg-muted">
              Draft
            </span>
          )}
          <span className="density-compact-only shrink-0">
            <ReasonChips reasons={item.reasons} compact />
          </span>
          <CiIndicator state={item.ci} className="shrink-0" />
          <time
            className="w-7 shrink-0 text-right text-xs text-fg-subtle tabular-nums"
            dateTime={item.attentionAt}
            title={new Date(item.attentionAt).toLocaleString()}
          >
            {shortAge(item.attentionAt)}
          </time>
        </div>

        <div className="density-secondary flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          {item.reasons.length > 0 && (
            <span className="shrink-0">
              <ReasonChips reasons={item.reasons} compact />
            </span>
          )}
          <span className="shrink-0">
            {item.repository.split('/')[1]}
            <span className="text-fg-subtle">#{item.number}</span>
          </span>
          {item.tickets[0] && (
            <span
              className="inline-flex shrink-0 items-center gap-1 font-mono text-2xs text-fg-subtle"
              title="Linked ticket"
            >
              <LinearMark size={10} />
              {item.tickets[0]}
            </span>
          )}
          <span className="inline-flex min-w-0 shrink items-center gap-1">
            <Avatar login={item.author.login} size={14} />
            <span className="truncate">{item.author.login}</span>
          </span>
          <span className="shrink-0 tabular-nums">
            <span className="text-add">+{item.additions}</span>{' '}
            <span className="text-del">−{item.deletions}</span>
          </span>
          {item.reasons.length === 0 && (
            <span className="truncate text-fg-subtle">
              {item.snoozedUntil
                ? `Until ${shortDateTime(item.snoozedUntil)}`
                : reviewSummary(item)}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-fg-subtle">
            {item.unresolvedThreads > 0 && (
              <span
                className="inline-flex items-center gap-0.5"
                title={`${item.unresolvedThreads} unresolved threads`}
              >
                <MessageSquare size={12} aria-hidden="true" />
                {item.unresolvedThreads}
              </span>
            )}
            {item.hasNote && <StickyNote size={12} aria-label="Has a private note" />}
            {item.snoozedUntil && <AlarmClock size={12} aria-label="Snoozed" />}
            {item.doneAt && <CheckCheck size={12} aria-label="Marked done" />}
          </span>
        </div>
      </div>
    </div>
  );
});
