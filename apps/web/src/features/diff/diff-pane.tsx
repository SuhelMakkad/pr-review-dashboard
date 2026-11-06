import { useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  PatchDiff,
  Virtualizer,
  type DiffLineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs/react';
import { withFileHeaders, type DiffFile } from '@review-desk/shared/diff';
import type { DraftComment, Side } from '@review-desk/shared/review';
import type { ReviewThread } from '@review-desk/shared/types';

export type Anchor =
  { kind: 'thread'; id: string } | { kind: 'draft'; id: string } | { kind: 'composer' };

export interface LineTarget {
  line: number;
  side: Side;
  startLine: number | null;
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

/** Converts the renderer's selection into GitHub's comment coordinates. */
export function toLineTarget(range: SelectedLineRange): LineTarget {
  const side: Side = (range.endSide ?? range.side) === 'deletions' ? 'LEFT' : 'RIGHT';
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);

  return { line: end, side, startLine: start === end ? null : start };
}

const sideOf = (side: Side) => (side === 'LEFT' ? 'deletions' : 'additions');

/**
 * The single place the diff renderer is used. Everything else talks to this adapter, so the
 * rendering library can change without touching the review workspace.
 */
export function DiffPane({
  file,
  threads,
  drafts,
  composer,
  view,
  theme,
  leftSideComments,
  renderAnchor,
  onCommentLine,
  onSelectLines,
}: {
  file: DiffFile;
  threads: ReviewThread[];
  drafts: DraftComment[];
  composer: LineTarget | null;
  view: 'unified' | 'split';
  theme: 'light' | 'dark';
  /** Base-side threads only make sense when the left side is the PR base (full diff). */
  leftSideComments: boolean;
  renderAnchor: (anchor: Anchor) => ReactNode;
  onCommentLine: (target: LineTarget) => void;
  onSelectLines: (target: LineTarget | null) => void;
}) {
  const patch = useMemo(() => withFileHeaders(file), [file]);
  const annotations = useMemo<DiffLineAnnotation<Anchor>[]>(() => {
    const list: DiffLineAnnotation<Anchor>[] = anchoredThreads(threads, {
      leftSide: leftSideComments,
    }).map((thread) => ({
      side: thread.diffSide === 'LEFT' ? 'deletions' : 'additions',
      lineNumber: thread.line!,
      metadata: { kind: 'thread', id: thread.id },
    }));

    for (const draft of drafts) {
      if (draft.line === null) continue;

      list.push({
        side: sideOf(draft.side),
        lineNumber: draft.line,
        metadata: { kind: 'draft', id: draft.id },
      });
    }

    if (composer)
      list.push({
        side: sideOf(composer.side),
        lineNumber: composer.line,
        metadata: { kind: 'composer' },
      });

    return list;
  }, [threads, drafts, composer, leftSideComments]);

  return (
    <Virtualizer
      className="diff-scroller scroll-thin h-full overflow-auto"
      contentClassName="pb-24"
    >
      <PatchDiff<Anchor>
        patch={patch}
        lineAnnotations={annotations}
        renderAnnotation={(annotation) => renderAnchor(annotation.metadata)}
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
          enableGutterUtility: true,
          onGutterUtilityClick: (range) => onCommentLine(toLineTarget(range)),
          enableLineSelection: true,
          onLineSelected: (range) => onSelectLines(range ? toLineTarget(range) : null),
        }}
      />
    </Virtualizer>
  );
}
