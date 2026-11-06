import { AlertTriangle, Send, Trash2 } from 'lucide-react';
import { reviewEventLabels, type ReviewDraft } from '../../../shared/review';
import { Button } from '../../ui/button';
import { Kbd } from '../../ui/kbd';

/** Always-visible summary of the review in progress, with the way to finish it. */
export function PendingTray({
  draft,
  viewed,
  total,
  onFinish,
  onDiscard,
}: {
  draft: ReviewDraft | undefined;
  viewed: number;
  total: number;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  const comments = draft?.comments ?? [];
  const stale = comments.filter((comment) => comment.status === 'stale').length;
  const hasDraft = comments.length > 0 || Boolean(draft?.body.trim());

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-t border-line bg-sunken px-4 text-xs">
      <span className="font-medium text-fg">
        {comments.length === 0
          ? 'No pending comments'
          : `${comments.length} pending ${comments.length === 1 ? 'comment' : 'comments'}`}
      </span>
      {draft && draft.event !== 'COMMENT' && (
        <span className="text-fg-muted">· {reviewEventLabels[draft.event]}</span>
      )}
      {stale > 0 && (
        <span className="inline-flex items-center gap-1 text-pending">
          <AlertTriangle size={12} aria-hidden="true" /> {stale} need attention
        </span>
      )}
      <span className="text-fg-subtle tabular-nums">
        {viewed}/{total} files viewed · <Kbd keys="v" />
      </span>
      <span className="text-fg-subtle">
        Select lines and press <Kbd keys="c" /> to comment
      </span>
      <div className="ml-auto flex items-center gap-2">
        {hasDraft && (
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={onDiscard}>
            Discard
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          icon={<Send size={12} />}
          onClick={onFinish}
          shortcut="$mod+Shift+Enter"
        >
          Finish review
        </Button>
      </div>
    </div>
  );
}
