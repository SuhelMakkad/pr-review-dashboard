import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import {
  CircleAlert,
  FileWarning,
  GitCompareArrows,
  History,
  Info,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import type { DiffFile } from '../../../shared/diff';
import type { ReviewThread } from '../../../shared/types';
import { useDiff, usePullDetail } from '../../lib/queries';
import { useShortcuts } from '../../lib/shortcuts';
import { storage } from '../../lib/storage';
import { useAppearance } from '../../lib/theme';
import { Button, IconButton } from '../../ui/Button';
import { cn } from '../../ui/cn';
import { EmptyState } from '../../ui/EmptyState';
import { Kbd } from '../../ui/Kbd';
import { anchoredThreads, DiffPane } from '../diff/DiffPane';
import { FileTree } from '../diff/FileTree';
import { ThreadCard } from '../diff/ThreadCard';
import { useCurrentPull } from '../pulls/useCurrentPull';
import type { FilesSearch } from './search';

const VIEW_KEY = 'review-desk-diff-view';

function layoutStorage() {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

const resolvedTheme = (theme: string) =>
  theme === 'system'
    ? typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : (theme as 'light' | 'dark');

/** The review workspace: file tree, one file's diff with inline threads, and the threads rail. */
export function FilesWorkspace() {
  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize: 2 }}
      highlighterOptions={{}}
    >
      <Workspace />
    </WorkerPoolContextProvider>
  );
}

function Workspace() {
  const { item } = useCurrentPull();
  const search = useSearch({ from: '/pr/$owner/$repo/$number/files' });
  const navigate = useNavigate({ from: '/pr/$owner/$repo/$number/files' });
  const { theme } = useAppearance();
  const fileFilterRef = useRef<HTMLInputElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const [railOpen, setRailOpen] = useState(() => storage.get('review-desk-rail') !== 'closed');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const layout = useDefaultLayout({ id: 'files-workspace', storage: layoutStorage() });

  const reviewOid = item?.latestReview?.commitOid ?? null;
  const changedSinceReview = Boolean(item?.reasons.some((reason) => reason.kind === 'changed'));
  const mode: 'all' | 'since' = search.mode ?? (changedSinceReview && reviewOid ? 'since' : 'all');
  const view = search.view ?? (storage.get(VIEW_KEY) === 'split' ? 'split' : 'unified');
  const diff = useDiff(item?.id ?? null, mode === 'since' ? 'since-review' : 'full');
  const detail = usePullDetail(item?.id ?? null);
  // Generated files (lockfiles, build output) go last and are never opened first.
  const files = useMemo(
    () =>
      [...(diff.data?.files ?? [])].sort(
        (left, right) => Number(Boolean(left.generated)) - Number(Boolean(right.generated)),
      ),
    [diff.data],
  );
  const current =
    files.find((file) => file.path === search.file) ??
    files.find((file) => !file.generated) ??
    files[0];
  const index = current ? files.indexOf(current) : -1;
  const threads = detail.data?.snapshot.threads ?? [];
  const account = detail.data?.account ?? '';
  const unread = new Set(item?.unreadReplyKeys ?? []);

  const threadsByFile = useMemo(() => {
    const map = new Map<string, ReviewThread[]>();

    for (const thread of threads) map.set(thread.path, [...(map.get(thread.path) ?? []), thread]);

    return map;
  }, [threads]);
  const threadCounts = useMemo(
    () =>
      new Map(
        [...threadsByFile].map(([path, list]) => [
          path,
          list.filter((thread) => !thread.isResolved).length,
        ]),
      ),
    [threadsByFile],
  );

  const setSearch = (next: Partial<FilesSearch>, replace = true) =>
    navigate({ search: (previous: FilesSearch) => ({ ...previous, ...next }), replace });

  const selectFile = (path: string, thread?: string) => setSearch({ file: path, thread });

  const scrollDiff = (delta: number) => {
    const scroller = diffRef.current?.querySelector<HTMLElement>('.diff-scroller');

    scroller?.scrollBy({ top: delta, behavior: 'auto' });
  };

  const unresolved = threads.filter(
    (thread) => !thread.isResolved && files.some((file) => file.path === thread.path),
  );

  const nextUnresolved = (direction: 1 | -1) => {
    if (unresolved.length === 0) return;

    const position = unresolved.findIndex((thread) => thread.id === search.thread);
    const next = unresolved[(position + direction + unresolved.length) % unresolved.length];

    selectFile(next.path, next.id);
  };

  // Bring a focused thread into view once its file has rendered.
  useEffect(() => {
    if (!search.thread) return;

    const timer = setTimeout(() => {
      const host = diffRef.current;
      const target =
        host?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(search.thread!)}"]`) ??
        [...(host?.querySelectorAll<HTMLElement>('*') ?? [])]
          .map((element) =>
            element.shadowRoot?.querySelector<HTMLElement>(
              `[data-thread-id="${CSS.escape(search.thread!)}"]`,
            ),
          )
          .find(Boolean);

      target?.scrollIntoView({ block: 'center' });
    }, 150);

    return () => clearTimeout(timer);
  }, [search.thread, current?.path]);

  useShortcuts([
    {
      keys: 'n',
      label: 'Next file',
      group: 'Pull request',
      run: () => files[index + 1] && selectFile(files[index + 1].path),
    },
    {
      keys: 'p',
      label: 'Previous file',
      group: 'Pull request',
      run: () => files[index - 1] && selectFile(files[index - 1].path),
    },
    { keys: 'j', label: 'Scroll down', group: 'Pull request', run: () => scrollDiff(80) },
    { keys: 'k', label: 'Scroll up', group: 'Pull request', run: () => scrollDiff(-80) },
    {
      keys: 'u',
      label: 'Next unresolved thread',
      group: 'Pull request',
      run: () => nextUnresolved(1),
    },
    {
      keys: 'Shift+u',
      label: 'Previous unresolved thread',
      group: 'Pull request',
      run: () => nextUnresolved(-1),
    },
    {
      keys: 't',
      label: 'Go to file',
      group: 'Pull request',
      run: () => fileFilterRef.current?.focus(),
    },
    {
      keys: 'd',
      label: 'Toggle full diff / since your review',
      group: 'Pull request',
      run: () =>
        reviewOid &&
        setSearch({ mode: mode === 'since' ? 'all' : 'since', file: undefined }, false),
    },
    {
      keys: 'Shift+d',
      label: 'Split or unified view',
      group: 'Pull request',
      run: () => {
        const next = view === 'split' ? 'unified' : 'split';

        storage.set(VIEW_KEY, next);
        setSearch({ view: next });
      },
    },
    {
      keys: 'x',
      label: 'Load a collapsed file',
      group: 'Pull request',
      run: () => current && setExpanded(new Set([...expanded, current.path])),
    },
    {
      keys: '.',
      label: 'Toggle threads panel',
      group: 'Pull request',
      run: () => {
        storage.set('review-desk-rail', railOpen ? 'closed' : 'open');
        setRailOpen(!railOpen);
      },
    },
  ]);

  if (!item) return null;

  const kind = diff.data?.kind;
  const banner =
    mode === 'since' && diff.data
      ? kind === 'identical'
        ? { tone: 'ok', icon: History, text: 'Nothing has changed since your review.' }
        : kind === 'fast-forward'
          ? {
              tone: 'changed',
              icon: GitCompareArrows,
              text: `New commits since your review (${reviewOid?.slice(0, 7)} → ${diff.data.toOid.slice(0, 7)}).${diff.data.note ? ` ${diff.data.note}` : ''}`,
            }
          : {
              tone: kind === 'unavailable' ? 'pending' : 'changed',
              icon: kind === 'unavailable' ? CircleAlert : GitCompareArrows,
              text: diff.data.note ?? '',
            }
      : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
        <div
          role="radiogroup"
          aria-label="Diff range"
          className="inline-flex rounded-sm border border-line bg-sunken p-0.5"
        >
          {(
            [
              ['all', 'All changes'],
              ['since', 'Since your review'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              disabled={value === 'since' && !reviewOid}
              title={
                value === 'since' && !reviewOid ? 'You have not reviewed this PR yet' : undefined
              }
              onClick={() => setSearch({ mode: value, file: undefined }, false)}
              className={cn(
                'h-6 rounded-xs px-2.5 text-xs disabled:opacity-40',
                mode === value
                  ? 'bg-panel font-medium text-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Kbd keys="d" />
        {current && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted"
            title={current.path}
          >
            {index + 1}/{files.length} · {current.path}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = view === 'split' ? 'unified' : 'split';

              storage.set(VIEW_KEY, next);
              setSearch({ view: next });
            }}
            shortcut="Shift+d"
          >
            {view === 'split' ? 'Split' : 'Unified'}
          </Button>
          <IconButton
            size="sm"
            label={railOpen ? 'Hide threads' : 'Show threads'}
            icon={railOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            onClick={() => {
              storage.set('review-desk-rail', railOpen ? 'closed' : 'open');
              setRailOpen(!railOpen);
            }}
          />
        </div>
      </div>

      {banner && banner.text && (
        <p
          className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-2 text-xs"
          style={{ background: `color-mix(in oklch, var(--${banner.tone}) 8%, var(--panel))` }}
          role="status"
        >
          <banner.icon
            size={14}
            style={{ color: `var(--${banner.tone})` }}
            className="mt-px shrink-0"
            aria-hidden="true"
          />
          <span className="text-fg">{banner.text}</span>
        </p>
      )}

      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="tree" defaultSize="20" minSize="12" maxSize="40">
          {diff.data ? (
            <FileTree
              ref={fileFilterRef}
              files={files}
              selected={current?.path}
              threadCounts={threadCounts}
              onSelect={(path) => selectFile(path)}
            />
          ) : (
            <div className="h-full border-r border-line bg-sunken" />
          )}
        </Panel>
        <Separator className="w-px bg-line outline-none hover:bg-accent data-[separator=active]:bg-accent" />
        <Panel id="diff" minSize="40">
          <div ref={diffRef} className="h-full min-w-0 bg-panel">
            {diff.isPending ? (
              <p className="p-6 text-sm text-fg-muted" aria-busy="true">
                Loading diff…
              </p>
            ) : diff.error ? (
              <div className="grid h-full place-items-center">
                <EmptyState
                  icon={<CircleAlert size={28} />}
                  title="Could not load the diff"
                  hint={diff.error.message}
                />
              </div>
            ) : !current ? (
              <div className="grid h-full place-items-center">
                <EmptyState
                  icon={<History size={28} />}
                  title={
                    kind === 'identical' ? 'Nothing new since your review' : 'No changed files'
                  }
                  hint={kind === 'identical' ? 'Press D to see the full diff.' : undefined}
                />
              </div>
            ) : (
              <FileView
                key={`${mode}:${current.path}`}
                file={current}
                expanded={expanded.has(current.path)}
                onExpand={() => setExpanded(new Set([...expanded, current.path]))}
                threads={threadsByFile.get(current.path) ?? []}
                view={view}
                theme={resolvedTheme(theme)}
                leftSideComments={mode === 'all'}
                account={account}
                unread={unread}
                focusedThread={search.thread}
                prUrl={item.url}
              />
            )}
          </div>
        </Panel>
        {railOpen && (
          <>
            <Separator className="w-px bg-line outline-none hover:bg-accent data-[separator=active]:bg-accent" />
            <Panel id="rail" defaultSize="24" minSize="16" maxSize="40">
              <ThreadsRail
                threads={threads}
                files={files}
                unread={unread}
                focused={search.thread}
                onOpen={(thread) => selectFile(thread.path, thread.id)}
              />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}

function FileView({
  file,
  expanded,
  onExpand,
  threads,
  view,
  theme,
  leftSideComments,
  account,
  unread,
  focusedThread,
  prUrl,
}: {
  file: DiffFile;
  expanded: boolean;
  onExpand: () => void;
  threads: ReviewThread[];
  view: 'unified' | 'split';
  theme: 'light' | 'dark';
  leftSideComments: boolean;
  account: string;
  unread: Set<string>;
  focusedThread?: string;
  prUrl: string;
}) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const floating = threads.filter(
    (thread) => !anchoredThreads([thread], { leftSide: leftSideComments }).length,
  );

  if (!file.patch || (file.generated && !expanded)) {
    const reason = file.binary
      ? 'Binary file — not shown.'
      : file.tooLarge
        ? 'This diff is too large to show here.'
        : 'Generated file (lockfile, build output or snapshot) — collapsed.';

    return (
      <div className="grid h-full place-items-center">
        <EmptyState
          icon={<FileWarning size={28} />}
          title={file.path}
          hint={reason}
          action={
            file.generated && file.patch ? (
              <Button size="sm" onClick={onExpand} shortcut="x">
                Load diff
              </Button>
            ) : (
              <a
                href={`${prUrl}/files`}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-accent underline"
              >
                View on GitHub
              </a>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {floating.length > 0 && (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-line bg-sunken px-2 py-1">
          <p className="flex items-center gap-1.5 px-2 pt-1 text-2xs text-fg-subtle">
            <Info size={11} aria-hidden="true" />
            Threads on outdated lines or on the whole file
          </p>
          {floating.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              account={account}
              unread={unread}
              focused={thread.id === focusedThread}
            />
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DiffPane
          file={file}
          threads={threads}
          view={view}
          theme={theme}
          leftSideComments={leftSideComments}
          renderThread={(threadId) => {
            const thread = byId.get(threadId);

            return thread ? (
              <ThreadCard
                thread={thread}
                account={account}
                unread={unread}
                focused={thread.id === focusedThread}
              />
            ) : null;
          }}
        />
      </div>
    </div>
  );
}

function ThreadsRail({
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
