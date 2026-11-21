import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { toast } from 'sonner';
import {
  CircleAlert,
  GitCompareArrows,
  History,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { commentableLines } from '@review-desk/shared/diff';
import type { DraftComment } from '@review-desk/shared/review';
import type { ReviewThread } from '@review-desk/shared/types';
import type { GitHubAction } from '@review-desk/shared/operations';
import { operationInProgress, operationUnsettled } from '@review-desk/shared/operations';
import { CommandBanner } from '@/features/review/command-banner';
import type { AttemptView } from '@/features/review/draft-attempts';
import { refOf } from '@/lib/pr-ref';
import { inQueue } from '@/features/pulls/meta';
import { openActivity } from '@/features/activity/use-operations';
import { useDiff, usePullDetail, usePulls } from '@/lib/queries';
import { useRemountKey } from '@/lib/remount-key';
import { useShortcuts } from '@/lib/shortcuts';
import { storage } from '@/lib/storage';
import { useAppearance } from '@/lib/theme';
import { Button, IconButton } from '@/ui/button';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';
import { Kbd } from '@/ui/kbd';
import { ActiveIndicator, Enter, IndicatorGroup } from '@/ui/motion';
import { ErrorState } from '@/ui/error-state';
import { DiffSkeleton, FileTreeSkeleton } from '@/features/review/files-skeleton';
import type { Anchor, LineTarget } from '@/features/diff/diff-pane';
import { FileTree } from '@/features/diff/file-tree';
import { ThreadCard } from '@/features/diff/thread-card';
import { useCurrentPull } from '@/features/pulls/use-current-pull';
import { Composer } from '@/features/review/composer';
import { DraftCommentCard } from '@/features/review/draft-comment-card';
import { FileView } from '@/features/review/file-view';
import { FinishSheet } from '@/features/review/finish-sheet';
import { PendingTray } from '@/features/review/pending-tray';
import type { FilesSearch } from '@/features/review/search';
import { ThreadsRail } from '@/features/review/threads-rail';
import { AssistPanel } from '@/features/ai/assist-panel';
import { Suggestions } from '@/features/ai/suggestions';
import { FullReview } from '@/features/ai/full-review';
import { useAi } from '@/features/ai/use-ai';
import {
  canMarkViewed,
  diffView,
  linesShown,
  useReview,
  viewedTarget,
  viewShows,
  type DiffView,
} from '@/features/review/use-review';

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

/** The review workspace: file tree, one file's diff with threads and drafts, threads rail, finish. */
/** Why a line cannot be commented on in a diff whose revision could not be confirmed. */
const UNPINNED_LINES =
  'This version of the diff could not be confirmed. Reload it to comment on lines; whole-file comments still work.';

export function FilesWorkspace() {
  const { item } = useCurrentPull();
  const pulls = usePulls();
  const detail = usePullDetail(item?.id ?? null);
  // The same account the workspace writes as. Comments, replies and the review summary belong to
  // one account and PR, so the workspace remounts when either changes.
  const account = detail.data?.account ?? pulls.data?.account;
  const scope = useRemountKey(account && item ? `${account}:${item.id}` : null);

  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize: 2 }}
      highlighterOptions={{}}
    >
      <Workspace key={scope} />
    </WorkerPoolContextProvider>
  );
}

/** The PR revision a diff was built from, as its manifest names it. */

/**
 * What the composer is for, with the patch it was opened on. A composer adding a kept comment
 * again names it (`recovers`), and one whose comment was refused, and kept, names that too: both
 * belong to this composer alone, gone with it.
 */
type ComposerState =
  | (((LineTarget & { path: string }) | { path: string; line: null }) & {
      view?: DiffView;
      recovers?: string;
      refused?: { key: string; text: string };
      /** This opening's own: its editor, its text and its answers are never another's. */
      opening?: string;
    })
  | null;

function Workspace() {
  const { item } = useCurrentPull();
  const search = useSearch({ from: '/pr/$owner/$repo/$number/files' });
  const navigate = useNavigate({ from: '/pr/$owner/$repo/$number/files' });
  const goTo = useNavigate();
  const pulls = usePulls();
  const { theme } = useAppearance();
  const fileFilterRef = useRef<HTMLInputElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const [railOpen, setRailOpen] = useState(() => storage.get('review-desk-rail') !== 'closed');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composer, setComposerState] = useState<ComposerState>(null);
  // Each composer opened is a new one: its editor starts from its own text, and an answer to an
  // earlier one never reaches it.
  const setComposer = (next: ComposerState | ((current: ComposerState) => ComposerState)) =>
    setComposerState((current) => {
      const value = typeof next === 'function' ? next(current) : next;

      return value && !value.opening ? { ...value, opening: crypto.randomUUID() } : value;
    });
  const [composerError, setComposerError] = useState<string | null>(null);
  /** Text kept from a composer closed because its diff changed, for the next one. */
  const [keptBody, setKeptBody] = useState<string | null>(null);
  /** Lines selected for a comment, with the file and patch they were selected in. */
  const [selection, setSelection] = useState<
    (LineTarget & { path: string; view?: DiffView }) | null
  >(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [recoveredBody, setRecoveredBody] = useState('');
  /** The composer's text as it is now (it says, from when it opens). */
  const [composerBody, setComposerBody] = useState('');
  /** A draft comment to bring into view once its file has rendered. */
  const [focusDraft, setFocusDraft] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<'threads' | 'assist'>('threads');
  const layout = useDefaultLayout({ id: 'files-workspace', storage: layoutStorage() });

  const reviewOid = item?.latestReview?.commitOid ?? null;
  const changedSinceReview = Boolean(item?.reasons.some((reason) => reason.kind === 'changed'));
  const mode: 'all' | 'since' = search.mode ?? (changedSinceReview && reviewOid ? 'since' : 'all');
  const view = search.view ?? (storage.get(VIEW_KEY) === 'split' ? 'split' : 'unified');
  const diff = useDiff(item?.id ?? null, mode === 'since' ? 'since-review' : 'full');
  const detail = usePullDetail(item?.id ?? null);
  const account = detail.data?.account ?? pulls.data?.account ?? '';
  const review = useReview(item?.id ?? null, account);
  const ai = useAi(item?.id ?? null, account);
  const draft = review.draft.data;
  const locked = Boolean(draft?.activeOperationId);

  useEffect(() => {
    const recover = () => {
      if (!account || !item?.id) return;
      const key = `review-desk-recovered:${account}:${item.id}`;
      const raw = storage.get(key);
      if (!raw) return;

      try {
        const action = JSON.parse(raw) as GitHubAction;
        if (action.type === 'reply') {
          setReplying(action.threadId);
          setRecoveredBody(action.body);
        }
        if (action.type === 'comment') {
          const comment = action.comment;
          setComposer(
            comment.line === null
              ? { path: comment.path, line: null }
              : {
                  path: comment.path,
                  line: comment.line,
                  side: comment.side ?? 'RIGHT',
                  startLine: comment.startLine ?? null,
                },
          );
          setRecoveredBody(comment.body);
        }

        storage.set(key, '');
      } catch {
        storage.set(key, '');
      }
    };

    recover();
    window.addEventListener('review-desk-recovered', recover);

    return () => window.removeEventListener('review-desk-recovered', recover);
  }, [account, item?.id]);

  // Generated files (lockfiles, build output) go last and are never opened first.
  const files = useMemo(
    () =>
      [...(diff.data?.files ?? [])]
        .map((file) => {
          // A mark still being sent shows only on the diff it names (older ones name none).
          const pending = review.operations
            .filter(
              (operation) =>
                operation.action.type === 'viewed' &&
                operation.action.path === file.path &&
                operationInProgress(operation.status) &&
                (!operation.action.target ||
                  !diff.data ||
                  viewShows(diff.data, file.path, operation.action.target)),
            )
            .at(-1);

          return pending?.action.type === 'viewed'
            ? {
                ...file,
                viewed: pending.action.viewed ? ('VIEWED' as const) : ('UNVIEWED' as const),
              }
            : file;
        })
        .sort((left, right) => Number(Boolean(left.generated)) - Number(Boolean(right.generated))),
    [diff.data, review.operations],
  );
  const current =
    files.find((file) => file.path === search.file) ??
    files.find((file) => !file.generated) ??
    files[0];
  const index = current ? files.indexOf(current) : -1;
  const threads = detail.data?.snapshot.threads ?? [];
  const unread = new Set(item?.unreadReplyKeys ?? []);
  const drafts = draft?.comments ?? [];

  // A kept refusal this composer shows with its very text: hidden from the banner meanwhile, and
  // shown there again once the composer closes or its text changes.
  const refused = composer?.refused;

  useEffect(() => {
    if (!refused || composerBody.trim() !== refused.text) return;

    return review.writer.showing(refused.key, refused.text);
  }, [refused, composerBody, review.writer]);

  // A draft card's edit refused, and kept: hidden while the card shows it as is (stable, so the
  // card's own effect does not run again on every render).
  const hideKept = useCallback(
    (key: string, text: string) => review.writer.showing(key, text),
    [review.writer],
  );

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

  // Lines selected in one comparison are other lines in the next, which renders without them.
  useEffect(() => setSelection(null), [mode]);

  const selectFile = (path: string, thread?: string) => {
    setComposer(null);
    setSelection(null);
    setSearch({ file: path, thread });
  };

  const scrollDiff = (delta: number) => {
    diffRef.current
      ?.querySelector<HTMLElement>('.diff-scroller')
      ?.scrollBy({ top: delta, behavior: 'auto' });
  };

  const unresolved = threads.filter(
    (thread) => !thread.isResolved && files.some((file) => file.path === thread.path),
  );
  const focusedThread = threads.find((thread) => thread.id === search.thread);

  const nextUnresolved = (direction: 1 | -1) => {
    if (unresolved.length === 0) return;

    const position = unresolved.findIndex((thread) => thread.id === search.thread);
    const next = unresolved[(position + direction + unresolved.length) % unresolved.length];

    selectFile(next.path, next.id);
  };

  const toggleViewed = (path: string, advance: boolean) => {
    const file = files.find((candidate) => candidate.path === path);

    if (!file) return;

    if (!canMarkViewed(diff.data, path)) {
      toast.error('This version of the file could not be confirmed. Reload the diff to mark it.');

      return;
    }

    const viewed = file.viewed !== 'VIEWED';

    review.setViewed.mutate(
      { path, viewed, target: diff.data ? viewedTarget(diff.data, path) : undefined },
      { onError: (error) => toast.error(`Could not update viewed state: ${error.message}`) },
    );

    if (advance && viewed) {
      const after = [...files.slice(index + 1), ...files.slice(0, index)].find(
        (candidate) => candidate.viewed !== 'VIEWED' && candidate.path !== path,
      );

      if (after) selectFile(after.path);
    }
  };

  const startComment = () => {
    if (!current) return;
    if (locked) {
      openActivity();
      return;
    }

    if (selection && diff.data?.unpinned) {
      toast.error(UNPINNED_LINES);

      return;
    }

    // Lines selected in another patch than the one shown now are other lines: select them again.
    if (selection && !linesShown(selection, current.path, diff.data)) {
      setSelection(null);
      toast.error('The diff changed after you selected those lines. Select them again.');

      return;
    }

    setRecoveredBody(keptBody ?? '');
    setKeptBody(null);
    setComposerError(null);
    setComposer(selection ?? { path: current.path, line: null, view: diffView(diff.data) });
  };

  // Bring a draft comment asked for into view once its file has rendered.
  useEffect(() => {
    if (!focusDraft) return;

    let tries = 0;
    const timer = setInterval(() => {
      const card = diffRef.current?.querySelector<HTMLElement>(
        `[data-draft-id="${CSS.escape(focusDraft)}"]`,
      );

      // Shown, or not after a few seconds (gone from the draft): either way, done.
      if (card || ++tries >= 30) {
        card?.scrollIntoView({ block: 'center' });
        clearInterval(timer);
        setFocusDraft(null);
      }
    }, 100);

    return () => clearInterval(timer);
  }, [focusDraft, current?.path]);

  // Bring a focused thread into view once its file has rendered.
  useEffect(() => {
    if (!search.thread) return;

    const timer = setTimeout(() => {
      diffRef.current
        ?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(search.thread!)}"]`)
        ?.scrollIntoView({ block: 'center' });
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
      keys: 'c',
      label: 'Comment on selected lines (or the file)',
      group: 'Pull request',
      run: startComment,
    },
    {
      keys: 'v',
      label: 'Mark file viewed and go to the next',
      group: 'Pull request',
      run: () => current && toggleViewed(current.path, true),
    },
    {
      keys: 'r',
      label: 'Reply to the focused thread',
      group: 'Pull request',
      run: () => {
        if (locked) {
          openActivity();
          return;
        }
        if (focusedThread) {
          setRecoveredBody('');
          setReplying(focusedThread.id);
        }
      },
    },
    {
      keys: 'Shift+r',
      label: 'Resolve or unresolve the focused thread',
      group: 'Pull request',
      run: () =>
        focusedThread &&
        (review.operations.some(
          (operation) =>
            operation.action.type === 'resolve' &&
            operation.action.threadId === focusedThread.id &&
            operationUnsettled(operation.status),
        )
          ? openActivity()
          : review.resolve.mutate(
              { threadId: focusedThread.id, resolved: !focusedThread.isResolved },
              { onError: (error) => toast.error(error.message) },
            )),
    },
    {
      keys: '$mod+Shift+Enter',
      label: 'Finish review',
      group: 'Pull request',
      allowInInput: true,
      run: () => setFinishOpen(true),
    },
    {
      keys: 't',
      label: 'Go to file',
      group: 'Pull request',
      run: () => fileFilterRef.current?.focus(),
    },
    {
      keys: 'b',
      label: 'Run the AI brief',
      group: 'Pull request',
      run: () => {
        setRailOpen(true);
        setRailTab('assist');

        if (!ai.isRunning('brief')) {
          ai.start.mutate({ task: 'brief', force: Boolean(ai.latest('brief')) });
        }
      },
    },
    {
      keys: 'Shift+b',
      label: 'Suggest review comments with AI',
      group: 'Pull request',
      run: () => {
        setRailOpen(true);
        setRailTab('assist');

        if (!ai.isRunning('draft_comments')) ai.start.mutate({ task: 'draft_comments' });
      },
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

  const renderThread = (thread: ReviewThread) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      account={account}
      unread={unread}
      focused={thread.id === search.thread}
      actions={{
        replying: replying === thread.id,
        setReplying: (value) => {
          setRecoveredBody('');
          setReplying(value ? thread.id : null);
        },
        reply: (body) => review.reply.mutateAsync({ threadId: thread.id, body }),
        resolve: (resolved) => review.resolve.mutateAsync({ threadId: thread.id, resolved }),
        busy: review.reply.isPending || review.resolve.isPending || locked,
        locked,
        resolution: review.operations.find(
          (operation) =>
            operation.action.type === 'resolve' &&
            operation.action.threadId === thread.id &&
            operationUnsettled(operation.status),
        ),
      }}
      recoveredBody={replying === thread.id ? recoveredBody : undefined}
      queuedReplies={review.operations.filter(
        (operation) =>
          operation.action.type === 'reply' &&
          operation.action.threadId === thread.id &&
          (operationUnsettled(operation.status) ||
            (operation.result?.pending &&
              !thread.comments.some((comment) => comment.url === operation.result?.url))),
      )}
    />
  );

  const renderDraft = (comment: DraftComment) => (
    <DraftCommentCard
      key={comment.id}
      comment={comment}
      busy={review.editComment.isPending || locked}
      onEdit={(body) =>
        review.editComment.mutateAsync({
          id: comment.id,
          body,
          where: {
            path: comment.path,
            line: comment.line,
            side: comment.side,
            startLine: comment.startLine,
            // Its lines belong to the comparison shown only when they were made on its head, and
            // have not moved since: else none is named, and a new comment of it is on its file.
            ...(() => {
              const shown = diffView(diff.data);

              // The head names its right side alone: a left side compares with a start this
              // comment does not record, so it never names one.
              return shown &&
                comment.side === 'RIGHT' &&
                comment.status !== 'stale' &&
                comment.anchorOid === shown.headOid
                ? { view: shown }
                : {};
            })(),
          },
        })
      }
      hideKept={hideKept}
      onDelete={() =>
        review.deleteComment.mutate(comment.id, { onError: (error) => toast.error(error.message) })
      }
    />
  );

  // A line picked in one revision of the diff means another line in the next: when the diff
  // changed while you wrote, the composer closes, keeps your text for the next one, and asks
  // you to pick the line again.
  const lineMoved = (open: NonNullable<ComposerState>, body: string) => {
    // A comment reopened from Activity names no patch; the server checks its head.
    if (open.line === null || !open.view) return false;
    if (linesShown(open, open.path, diff.data)) return false;

    setKeptBody(body);
    setComposer(null);
    setComposerError(null);
    toast.error(
      'The diff changed while you were writing. Select the line again; your text is kept.',
    );

    return true;
  };

  /**
   * A refusal the writer kept, named by it, for the very composer it was sent from: hidden from
   * the banner while that one shows it as is. Gone with it, never another composer's.
   */
  const keepRefused = (opened: NonNullable<ComposerState>, error: unknown, text: string) => {
    const kept = (error as { details?: { kept?: unknown } }).details?.kept;

    setComposer((current) =>
      current && current.opening === opened.opening
        ? { ...current, refused: typeof kept === 'string' ? { key: kept, text } : undefined }
        : current,
    );
  };

  /** Closes the composer, if it is still the opening `opened`: never one opened since. */
  const closeOpening = (opened: NonNullable<ComposerState>) => {
    if (composer?.opening !== opened.opening) return;

    closeComposer();
  };

  /**
   * Opens a composer with a kept comment's text, to add it as a new comment: on the lines it was
   * for when the diff shown is the very comparison they were picked in, else on its file, for you
   * to pick the lines again.
   */
  const addAsNew = (entry: AttemptView) => {
    const where = entry.where;
    const text = entry.texts.at(-1) ?? '';

    if (!where || !files.some((file) => file.path === where.path)) {
      toast.error('Its file is not in this diff. Copy your text instead.');

      return;
    }

    const picked = { path: where.path, view: where.view as DiffView | undefined };
    // The lines on their side in the patch shown, which must be the very comparison they were
    // picked in: else they are other lines, or none.
    const patchLines = commentableLines(files.find((file) => file.path === where.path)?.patch);
    const sideLines = where.side === 'LEFT' ? patchLines.left : patchLines.right;
    const restorable =
      where.line !== null &&
      linesShown(picked, where.path, diff.data) &&
      sideLines.has(where.line) &&
      (where.startLine === null || sideLines.has(where.startLine));

    selectFile(where.path);
    setRecoveredBody(text);
    setComposerError(null);

    // A collapsed file (generated) shows no lines: opened, so the composer on them is shown too.
    if (restorable) setExpanded((open) => new Set([...open, where.path]));

    setComposer(
      restorable && where.line !== null
        ? {
            path: where.path,
            line: where.line,
            side: where.side,
            startLine: where.startLine,
            view: picked.view,
            recovers: entry.key,
          }
        : { path: where.path, line: null, view: diffView(diff.data), recovers: entry.key },
    );

    if (where.line !== null && !restorable)
      toast(
        'The lines it was on are not shown now. Comment on the file, or select the lines again.',
      );
  };

  const closeComposer = () => {
    setComposer(null);
    setComposerError(null);
    setComposerBody('');
  };

  const composerFor = (target: NonNullable<ComposerState>) => (
    <Composer
      key={target.opening}
      label={target.line === null ? `Comment on ${target.path}` : `Comment on line ${target.line}`}
      initial={recoveredBody}
      busy={review.addComment.isPending || review.commentNow.isPending || locked}
      error={composerError}
      onChange={setComposerBody}
      onCancel={closeComposer}
      primary={{
        label: 'Add to review',
        keys: '$mod+Enter',
        variant: 'primary',
        run: async (body) => {
          if (lineMoved(target, body)) return;

          const side = target.line === null ? 'RIGHT' : target.side;
          const startLine = target.line === null ? null : target.startLine;

          try {
            await review.addComment.mutateAsync({
              path: target.path,
              line: target.line,
              side,
              startLine,
              body,
              // The lines are the diff's the composer was opened on; refused for another revision.
              ...(target.line !== null && target.view
                ? { revision: { headOid: target.view.headOid, baseOid: target.view.baseOid } }
                : {}),
              where: { path: target.path, line: target.line, side, startLine, view: target.view },
              ...(target.recovers ? { recovers: target.recovers } : {}),
            });
            closeOpening(target);
          } catch (error) {
            setComposerError((error as Error).message);
            keepRefused(target, error, body);
          }
        },
      }}
      alternate={{
        label: `Comment now as @${account}`,
        keys: '$mod+Alt+Enter',
        variant: 'secondary',
        run: async (body) => {
          if (lineMoved(target, body)) return;

          try {
            await review.commentNow.mutateAsync({
              // A line belongs to the diff the composer was opened on; a whole file has no lines
              // to move, so it goes on the head shown now.
              expectedHeadOid:
                (target.line !== null ? target.view?.headOid : undefined) ??
                diff.data?.toOid ??
                detail.data?.snapshot.headOid ??
                '',
              path: target.path,
              line: target.line,
              side: target.line === null ? 'RIGHT' : target.side,
              startLine: target.line === null ? null : target.startLine,
              body,
            });
            setComposer(null);
            setComposerError(null);
            toast('Comment queued', { action: { label: 'View activity', onClick: openActivity } });
          } catch (error) {
            setComposerError((error as Error).message);
          }
        },
      }}
    />
  );

  const renderAnchor = (anchor: Anchor) => {
    if (anchor.kind === 'thread') {
      const thread = threads.find((candidate) => candidate.id === anchor.id);

      return thread ? renderThread(thread) : null;
    }

    if (anchor.kind === 'draft') {
      const comment = drafts.find((candidate) => candidate.id === anchor.id);

      return comment ? renderDraft(comment) : null;
    }

    return composer && composer.line !== null ? (
      <div className="my-2 mr-4 ml-2">{composerFor(composer)}</div>
    ) : null;
  };

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
  const viewedCount = files.filter((file) => file.viewed === 'VIEWED').length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
        <IndicatorGroup>
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
                  'relative h-6 rounded-xs px-2.5 text-xs transition-colors disabled:opacity-40',
                  mode === value ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {mode === value && <ActiveIndicator variant="pill" />}
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>
        </IndicatorGroup>
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
          {current && (
            <Button
              size="sm"
              variant={current.viewed === 'VIEWED' ? 'secondary' : 'ghost'}
              onClick={() => toggleViewed(current.path, false)}
              aria-pressed={current.viewed === 'VIEWED'}
              disabled={!canMarkViewed(diff.data, current.path)}
            >
              {current.viewed === 'VIEWED' ? 'Viewed' : 'Mark viewed'}
            </Button>
          )}
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
          {/* The tree fades in once the diff arrives, replacing its outline. */}
          {diff.data ? (
            <Enter key="tree" preset="fade" className="h-full">
              <FileTree
                ref={fileFilterRef}
                files={files}
                selected={current?.path}
                threadCounts={threadCounts}
                onSelect={(path) => selectFile(path)}
                onToggleViewed={(path) => toggleViewed(path, false)}
              />
            </Enter>
          ) : diff.error ? (
            <div className="h-full border-r border-line bg-sunken" />
          ) : (
            <FileTreeSkeleton />
          )}
        </Panel>
        <Separator className="w-px bg-line outline-none hover:bg-accent data-[separator=active]:bg-accent" />
        <Panel id="diff" minSize="40">
          <div ref={diffRef} className="h-full min-w-0 bg-panel">
            {/* Each state eases in; moving between files stays instant. */}
            {diff.isPending ? (
              <DiffSkeleton />
            ) : diff.error ? (
              <Enter key="error" preset="fade" className="grid h-full place-items-center">
                <ErrorState
                  title="Could not load the diff"
                  error={diff.error}
                  onRetry={() => void diff.refetch()}
                />
              </Enter>
            ) : !current ? (
              <Enter key="empty" preset="fade" className="grid h-full place-items-center">
                <EmptyState
                  icon={<History size={28} />}
                  title={
                    kind === 'identical' ? 'Nothing new since your review' : 'No changed files'
                  }
                  hint={kind === 'identical' ? 'Press D to see the full diff.' : undefined}
                />
              </Enter>
            ) : (
              <Enter key="ready" preset="fade" className="h-full">
                <FileView
                  key={`${mode}:${current.path}`}
                  file={current}
                  expanded={expanded.has(current.path)}
                  onExpand={() => setExpanded(new Set([...expanded, current.path]))}
                  threads={threadsByFile.get(current.path) ?? []}
                  drafts={drafts.filter((comment) => comment.path === current.path)}
                  composer={
                    composer && composer.path === current.path && composer.line !== null
                      ? composer
                      : null
                  }
                  fileComposer={
                    composer && composer.path === current.path && composer.line === null
                      ? composerFor(composer)
                      : null
                  }
                  view={view}
                  theme={resolvedTheme(theme)}
                  leftSideComments={mode === 'all'}
                  prUrl={item.url}
                  queuedComments={review.operations.filter(
                    (operation) =>
                      operation.action.type === 'comment' &&
                      operation.action.comment.path === current.path &&
                      operationUnsettled(operation.status),
                  )}
                  renderAnchor={renderAnchor}
                  renderThread={renderThread}
                  renderDraft={renderDraft}
                  onCommentLine={(target) => {
                    if (locked) {
                      openActivity();
                      return;
                    }

                    if (diff.data?.unpinned) {
                      toast.error(UNPINNED_LINES);
                      return;
                    }

                    setRecoveredBody(keptBody ?? '');
                    setKeptBody(null);
                    setComposerError(null);
                    setComposer({ ...target, path: current.path, view: diffView(diff.data) });
                  }}
                  onCommentFile={() => {
                    if (locked) {
                      openActivity();
                      return;
                    }
                    setRecoveredBody(keptBody ?? '');
                    setKeptBody(null);
                    setComposer({ path: current.path, line: null, view: diffView(diff.data) });
                  }}
                  onSelectLines={(target) =>
                    setSelection(
                      target ? { ...target, path: current.path, view: diffView(diff.data) } : null,
                    )
                  }
                />
              </Enter>
            )}
          </div>
        </Panel>
        {railOpen && (
          <>
            <Separator className="w-px bg-line outline-none hover:bg-accent data-[separator=active]:bg-accent" />
            <Panel id="rail" defaultSize="24" minSize="16" maxSize="40">
              <div className="flex h-full flex-col border-l border-line bg-sunken">
                <IndicatorGroup>
                  <div
                    role="tablist"
                    aria-label="Side panel"
                    className="flex shrink-0 gap-1 border-b border-line px-2 pt-2"
                  >
                    {(
                      [
                        ['threads', `Threads${unresolved.length ? ` · ${unresolved.length}` : ''}`],
                        ['assist', '✦ Assist'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={railTab === value}
                        onClick={() => setRailTab(value)}
                        className={cn(
                          'relative -mb-px px-2 pb-2 text-xs transition-colors',
                          railTab === value ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
                        )}
                      >
                        {railTab === value && <ActiveIndicator variant="underline" />}
                        {label}
                      </button>
                    ))}
                  </div>
                </IndicatorGroup>
                <div className="min-h-0 flex-1">
                  {railTab === 'threads' ? (
                    <ThreadsRail
                      threads={threads}
                      files={files}
                      unread={unread}
                      focused={search.thread}
                      onOpen={(thread) => selectFile(thread.path, thread.id)}
                    />
                  ) : (
                    <div className="scroll-thin h-full space-y-3 overflow-y-auto p-3">
                      <FullReview
                        prId={item.id}
                        account={account}
                        repository={item.repository}
                        number={item.number}
                        headOid={detail.data?.snapshot.headOid ?? ''}
                        ci={detail.data?.snapshot.ci ?? 'none'}
                      />
                      <AssistPanel
                        prId={item.id}
                        account={account}
                        bindShortcuts={false}
                        compact
                        tasks={[
                          'brief',
                          ...(reviewOid && changedSinceReview ? (['since_review'] as const) : []),
                        ]}
                        threadLabel={(threadId) => {
                          const thread = threads.find((candidate) => candidate.id === threadId);

                          return thread
                            ? `${thread.path.split('/').pop()}${thread.line ? `:${thread.line}` : ''}`
                            : threadId;
                        }}
                        onOpenFile={(path) =>
                          files.some((file) => file.path === path) && selectFile(path)
                        }
                        onOpenThread={(threadId) => {
                          const thread = threads.find((candidate) => candidate.id === threadId);

                          if (thread) selectFile(thread.path, thread.id);
                        }}
                      />
                      <Suggestions
                        prId={item.id}
                        account={account}
                        onOpenLine={(path) =>
                          files.some((file) => file.path === path) && selectFile(path)
                        }
                      />
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </>
        )}
      </Group>

      <div className="px-4 empty:hidden">
        <CommandBanner
          writer={review.writer}
          actions={{
            addAsNew,
            hasComment: (id) => drafts.some((comment) => comment.id === id),
            checkComment: (entry) => {
              if (!entry.where || !files.some((file) => file.path === entry.where!.path)) {
                toast.error('Its file is not in this diff.');

                return;
              }

              selectFile(entry.where.path);

              // An edit names its comment: brought into view, if it is still in the draft.
              if (entry.commentId) setFocusDraft(entry.commentId);
            },
            openFinish: () => setFinishOpen(true),
          }}
        />
      </div>

      <PendingTray
        draft={draft}
        viewed={viewedCount}
        total={files.length}
        onFinish={() => setFinishOpen(true)}
        onDiscard={() => {
          if (window.confirm('Discard your pending review and all its comments?')) {
            // What it carries is read at the click, as the confirmation shows it.
            review.discard.mutate(review.writer.carry(draft), {
              onError: (error) => toast.error(error.message),
            });
          }
        }}
      />

      {draft && detail.data && (
        <FinishSheet
          // Its summary autosaves and flushes on unmount, always to the account it was opened for.
          key={`${account}:${item.id}`}
          open={finishOpen}
          onOpenChange={setFinishOpen}
          draft={draft}
          account={account}
          ci={item.ci}
          viewedHeadOid={diff.data?.toOid ?? detail.data.snapshot.headOid}
          submit={(input) => review.submit.mutateAsync(input)}
          busy={review.submit.isPending}
          onReviewNewCommits={() => {
            setFinishOpen(false);
            setSearch({ mode: 'since', file: undefined }, false);
          }}
          onSubmitted={() => {
            setFinishOpen(false);
            toast('Review queued', {
              description: 'You can keep reviewing. Progress and recovery are saved in Activity.',
              action: { label: 'View activity', onClick: openActivity },
            });
            if (search.inbox) {
              const queue = search.inbox;
              const next = pulls.data?.items.find(
                (candidate) =>
                  candidate.id !== item.id &&
                  inQueue(candidate, queue) &&
                  !review.allOperations.some(
                    (operation) =>
                      operation.prId === candidate.id &&
                      operation.action.type === 'review' &&
                      operationUnsettled(operation.status),
                  ),
              );

              if (next) {
                const target = refOf(next);
                void goTo({
                  to: '/inbox/$queue/$owner/$repo/$number',
                  params: {
                    queue,
                    owner: target.owner,
                    repo: target.repo,
                    number: String(target.number),
                  },
                });
              } else void goTo({ to: '/inbox/$queue', params: { queue } });
            }
          }}
        />
      )}
    </div>
  );
}
