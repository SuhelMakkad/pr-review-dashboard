import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { PatchDiff, Virtualizer, type DiffLineAnnotation } from '@pierre/diffs/react';
import { withFileHeaders, type DiffFile } from '../../../shared/diff';
import type { ReviewThread } from '../../../shared/types';

export interface ThreadAnchor {
  threadId: string;
}

/** Threads that can sit on a line of this diff (current, line-level, and on a visible side). */
export function anchoredThreads(
  threads: ReviewThread[],
  options: { leftSide: boolean },
): ReviewThread[] {
  return threads.filter(
    (thread) =>
      !thread.isOutdated &&
      thread.line !== null &&
      thread.subjectType !== 'FILE' &&
      (thread.diffSide !== 'LEFT' || options.leftSide),
  );
}

/**
 * The single place the diff renderer is used. Everything else talks to this adapter, so the
 * rendering library can change without touching the review workspace.
 */
export function DiffPane({
  file,
  threads,
  view,
  theme,
  leftSideComments,
  renderThread,
}: {
  file: DiffFile;
  threads: ReviewThread[];
  view: 'unified' | 'split';
  theme: 'light' | 'dark';
  /** Base-side threads only make sense when the left side is the PR base (full diff). */
  leftSideComments: boolean;
  renderThread: (threadId: string) => ReactNode;
}) {
  const patch = useMemo(() => withFileHeaders(file), [file]);
  const annotations = useMemo<DiffLineAnnotation<ThreadAnchor>[]>(
    () =>
      anchoredThreads(threads, { leftSide: leftSideComments }).map((thread) => ({
        side: thread.diffSide === 'LEFT' ? 'deletions' : 'additions',
        lineNumber: thread.line!,
        metadata: { threadId: thread.id },
      })),
    [threads, leftSideComments],
  );

  return (
    <Virtualizer
      className="diff-scroller scroll-thin h-full overflow-auto"
      contentClassName="pb-24"
    >
      <PatchDiff<ThreadAnchor>
        patch={patch}
        lineAnnotations={annotations}
        renderAnnotation={(annotation) => renderThread(annotation.metadata.threadId)}
        className="diff-surface"
        style={
          {
            '--diffs-light-bg': 'var(--panel)',
            '--diffs-dark-bg': 'var(--panel)',
            '--diffs-font-family': 'var(--font-mono)',
            '--diffs-header-font-family': 'var(--font-sans)',
            '--diffs-font-size': '12px',
            '--diffs-line-height': '20px',
          } as CSSProperties
        }
        options={{
          diffStyle: view,
          themeType: theme,
          overflow: 'wrap',
          stickyHeader: true,
          lineDiffType: 'word-alt',
          hunkSeparators: 'line-info',
          diffIndicators: 'bars',
          lineHoverHighlight: 'line',
        }}
      />
    </Virtualizer>
  );
}
