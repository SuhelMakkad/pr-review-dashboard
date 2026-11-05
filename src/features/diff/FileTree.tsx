import { forwardRef, useEffect, useRef, useState } from 'react';
import { CircleCheck, Search, X } from 'lucide-react';
import type { DiffFile } from '../../../shared/diff';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/Kbd';

const statusMeta: Record<DiffFile['status'], { letter: string; tone: string; label: string }> = {
  added: { letter: 'A', tone: 'add', label: 'Added' },
  modified: { letter: 'M', tone: 'pending', label: 'Modified' },
  changed: { letter: 'M', tone: 'pending', label: 'Changed' },
  removed: { letter: 'D', tone: 'del', label: 'Deleted' },
  renamed: { letter: 'R', tone: 'first', label: 'Renamed' },
  copied: { letter: 'C', tone: 'first', label: 'Copied' },
  unchanged: { letter: '·', tone: 'neutral', label: 'Unchanged' },
};

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export const FileTree = forwardRef<
  HTMLInputElement,
  {
    files: DiffFile[];
    selected: string | undefined;
    threadCounts: Map<string, number>;
    onSelect: (path: string) => void;
  }
>(function FileTree({ files, selected, threadCounts, onSelect }, ref) {
  const [filter, setFilter] = useState('');
  const selectedRef = useRef<HTMLButtonElement>(null);
  const visible = filter
    ? files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
    : files;
  const viewed = files.filter((file) => file.viewed === 'VIEWED').length;

  // Block body on purpose: scrollIntoView may return a Promise, which React would treat as a cleanup.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  let previousDirectory: string | null = null;

  return (
    <nav aria-label="Changed files" className="flex h-full flex-col border-r border-line bg-sunken">
      <div className="flex items-center justify-between px-3 pt-3 pb-2 text-xs">
        <span className="font-semibold text-fg-muted">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        <span className="text-fg-subtle tabular-nums" title="Files you marked as viewed on GitHub">
          {viewed}/{files.length} viewed
        </span>
      </div>
      <label className="mx-2 mb-2 flex h-7 items-center gap-1.5 rounded-sm border border-line bg-panel px-2 focus-within:border-accent">
        <Search size={12} className="text-fg-subtle" aria-hidden="true" />
        <input
          ref={ref}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setFilter('');
              event.currentTarget.blur();
            }

            if (event.key === 'Enter' && visible[0]) {
              onSelect(visible[0].path);
              event.currentTarget.blur();
            }
          }}
          placeholder="Go to file"
          aria-label="Go to file"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-fg-subtle"
        />
        {filter ? (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => setFilter('')}
            className="text-fg-subtle"
          >
            <X size={11} />
          </button>
        ) : (
          <Kbd keys="t" />
        )}
      </label>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-3">
        {visible.map((file) => {
          const directory = dirname(file.path);
          const header = directory !== previousDirectory && directory ? directory : null;
          const status = statusMeta[file.status];
          const threads = threadCounts.get(file.path) ?? 0;
          const isSelected = file.path === selected;

          previousDirectory = directory;

          return (
            <div key={file.path}>
              {header && (
                <div
                  className="truncate px-3 pt-2 pb-0.5 font-mono text-2xs text-fg-subtle"
                  title={header}
                >
                  {header}/
                </div>
              )}
              <button
                ref={isSelected ? selectedRef : undefined}
                type="button"
                onClick={() => onSelect(file.path)}
                aria-current={isSelected ? 'true' : undefined}
                title={file.path}
                className={cn(
                  'flex h-7 w-full items-center gap-2 pr-2 pl-3 text-left text-xs',
                  isSelected ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                  file.generated && 'italic',
                )}
              >
                <span
                  className="w-3 shrink-0 text-center font-mono text-2xs font-bold"
                  style={{ color: `var(--${status.tone})` }}
                  aria-label={status.label}
                >
                  {status.letter}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{basename(file.path)}</span>
                {threads > 0 && (
                  <span className="rounded-xs bg-reply/15 px-1 text-2xs text-reply">{threads}</span>
                )}
                {file.viewed === 'VIEWED' ? (
                  <CircleCheck size={12} className="shrink-0 text-ok" aria-label="Viewed" />
                ) : (
                  <span className="shrink-0 text-2xs text-fg-subtle tabular-nums">
                    +{file.additions} −{file.deletions}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
});
