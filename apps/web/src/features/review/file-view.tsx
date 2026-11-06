import type { ReactNode } from 'react';
import { FileWarning, Info, MessageSquarePlus } from 'lucide-react';
import type { DiffFile } from '../../../../../packages/shared/src/diff';
import type { DraftComment } from '../../../../../packages/shared/src/review';
import type { ReviewThread } from '../../../../../packages/shared/src/types';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state';
import { anchoredThreads, DiffPane, type Anchor, type LineTarget } from '../diff/diff-pane';

/** One file: collapsed placeholder, file-level threads and comments, then the diff itself. */
export function FileView({
  file,
  expanded,
  onExpand,
  threads,
  drafts,
  composer,
  fileComposer,
  view,
  theme,
  leftSideComments,
  prUrl,
  renderAnchor,
  renderThread,
  renderDraft,
  onCommentLine,
  onCommentFile,
  onSelectLines,
}: {
  file: DiffFile;
  expanded: boolean;
  onExpand: () => void;
  threads: ReviewThread[];
  drafts: DraftComment[];
  composer: LineTarget | null;
  fileComposer: ReactNode | null;
  view: 'unified' | 'split';
  theme: 'light' | 'dark';
  leftSideComments: boolean;
  prUrl: string;
  renderAnchor: (anchor: Anchor) => ReactNode;
  renderThread: (thread: ReviewThread) => ReactNode;
  renderDraft: (draft: DraftComment) => ReactNode;
  onCommentLine: (target: LineTarget) => void;
  onCommentFile: () => void;
  onSelectLines: (target: LineTarget | null) => void;
}) {
  const floating = threads.filter(
    (thread) => !anchoredThreads([thread], { leftSide: leftSideComments }).length,
  );
  const fileDrafts = drafts.filter((draft) => draft.line === null);
  const header = (
    <>
      {(floating.length > 0 || fileDrafts.length > 0 || fileComposer) && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line bg-sunken px-2 py-1">
          {floating.length > 0 && (
            <p className="flex items-center gap-1.5 px-2 pt-1 text-2xs text-fg-subtle">
              <Info size={11} aria-hidden="true" />
              Threads on outdated lines or on the whole file
            </p>
          )}
          {floating.map(renderThread)}
          {fileDrafts.map(renderDraft)}
          {fileComposer && <div className="p-2">{fileComposer}</div>}
        </div>
      )}
    </>
  );

  if (!file.patch || (file.generated && !expanded)) {
    const reason = file.binary
      ? 'Binary file — not shown.'
      : file.tooLarge
        ? 'This diff is too large to show here.'
        : 'Generated file (lockfile, build output or snapshot) — collapsed.';

    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="grid min-h-0 flex-1 place-items-center">
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
                <div className="flex items-center gap-3">
                  <Button size="sm" icon={<MessageSquarePlus size={12} />} onClick={onCommentFile}>
                    Comment on file
                  </Button>
                  <a
                    href={`${prUrl}/files`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-accent underline"
                  >
                    View on GitHub
                  </a>
                </div>
              )
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1">
        <DiffPane
          file={file}
          threads={threads}
          drafts={drafts}
          composer={composer}
          view={view}
          theme={theme}
          leftSideComments={leftSideComments}
          renderAnchor={renderAnchor}
          onCommentLine={onCommentLine}
          onSelectLines={onSelectLines}
        />
      </div>
    </div>
  );
}
