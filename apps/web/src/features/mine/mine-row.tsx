import { forwardRef } from 'react';
import type { AuthorItem } from '@review-desk/shared/author';
import { shortAge } from '@/lib/time';
import { LinearMark } from '@/ui/brand-icons';
import { numberSign } from '@/lib/pr-ref';
import { cn } from '@/ui/cn';
import { ActiveIndicator } from '@/ui/motion';
import { CiIndicator, tone } from '@/features/pulls/meta';
import { blockerTone, waitState } from '@/features/mine/meta';

export const MineRow = forwardRef<
  HTMLDivElement,
  { item: AuthorItem; selected: boolean; onSelect: () => void; onOpen: () => void }
>(function MineRow({ item, selected, onSelect, onOpen }, ref) {
  const wait = waitState(item);
  const yours = item.blockers.filter((blocker) => blocker.actor === 'you');
  const shown = (yours.length ? yours : item.blockers).slice(0, 3);

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
        'relative flex min-h-[var(--row-h)] cursor-default items-center gap-3 border-b border-line py-1.5 pr-4 pl-4 select-none',
        'transition-colors',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      {selected && <ActiveIndicator variant="bar" />}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm text-fg',
              item.group === 'needs_you' ? 'font-semibold' : 'font-medium',
            )}
          >
            {item.title}
          </span>
          <CiIndicator state={item.ci} className="shrink-0" />
          <time
            className="w-7 shrink-0 text-right text-xs text-fg-subtle tabular-nums"
            dateTime={item.updatedAt}
          >
            {shortAge(item.updatedAt)}
          </time>
        </div>
        <div className="density-secondary flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          {shown.map((blocker) => (
            <span
              key={blocker.kind}
              className="tone inline-flex h-5 shrink-0 items-center rounded-xs px-1.5 text-2xs font-medium"
              style={tone(blockerTone[blocker.kind])}
            >
              {blocker.label.length > 38 ? `${blocker.label.slice(0, 36)}…` : blocker.label}
            </span>
          ))}
          {item.group === 'ready' && (
            <span
              className="tone inline-flex h-5 items-center rounded-xs px-1.5 text-2xs font-medium"
              style={tone('ok')}
            >
              Ready to merge
            </span>
          )}
          <span className="shrink-0">
            {item.repository.split('/').at(-1)}
            <span className="text-fg-subtle">
              {numberSign(item.url)}
              {item.number}
            </span>
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
          {wait && item.group === 'waiting' && (
            <span
              className="ml-auto shrink-0 tabular-nums"
              style={{ color: `var(--${wait.tone === 'ok' ? 'fg-subtle' : wait.tone})` }}
            >
              waiting {wait.hours}h
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
