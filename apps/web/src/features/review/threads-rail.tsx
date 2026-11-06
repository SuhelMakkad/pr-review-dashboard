import type { DiffFile } from '../../../../../packages/shared/src/diff';
import type { ReviewThread } from '../../../../../packages/shared/src/types';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/kbd';

export function ThreadsRail({
  threads,
  files,
  unread,
  focused,
  onOpen,
}: {
  threads: ReviewThread[];
  files: DiffFile[];
  unread: Set<string>;
  focused?: string;
  onOpen: (thread: ReviewThread) => void;
}) {
  const inDiff = new Set(files.map((file) => file.path));
  const sorted = [...threads].sort(
    (left, right) =>
      Number(left.isResolved) - Number(right.isResolved) || left.path.localeCompare(right.path),
  );
  const open = threads.filter((thread) => !thread.isResolved).length;

  return (
    <aside
      aria-label="Review threads"
      className="flex h-full flex-col border-l border-line bg-sunken"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2 text-xs">
        <span className="font-semibold text-fg-muted">Threads</span>
        <span className="text-fg-subtle">
          {open} open · <Kbd keys="u" />
        </span>
      </div>
      <ol className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {sorted.length === 0 && (
          <li className="px-1 py-6 text-center text-xs text-fg-subtle">No review threads yet.</li>
        )}
        {sorted.map((thread) => {
          const first = thread.comments[0];
          const newCount = thread.comments.filter((comment) =>
            unread.has(`${comment.id}:${comment.updatedAt}`),
          ).length;

          return (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => onOpen(thread)}
                disabled={!inDiff.has(thread.path)}
                title={
                  inDiff.has(thread.path) ? undefined : 'This file is not part of the current diff'
                }
                className={cn(
                  'w-full rounded-sm border px-2.5 py-2 text-left text-xs disabled:opacity-50',
                  thread.id === focused
                    ? 'border-accent bg-selected'
                    : 'border-transparent hover:bg-hover',
                  thread.isResolved && 'text-fg-muted',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle">
                    {thread.path.split('/').pop()}
                    {thread.line ? `:${thread.line}` : ''}
                  </span>
                  {newCount > 0 && (
                    <span className="rounded-xs bg-reply/15 px-1 text-2xs font-semibold text-reply">
                      {newCount} new
                    </span>
                  )}
                  {thread.isResolved && <span className="text-2xs text-ok">Resolved</span>}
                  {thread.isOutdated && !thread.isResolved && (
                    <span className="text-2xs text-fg-subtle">Outdated</span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-fg">
                  <span className="font-medium">{first?.author.login}: </span>
                  {first?.body}
                </p>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
