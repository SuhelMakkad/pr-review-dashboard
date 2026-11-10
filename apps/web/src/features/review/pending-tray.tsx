import { AlertTriangle, Send, Trash2 } from 'lucide-react';
import { reviewEventLabels, type ReviewDraft } from '@review-desk/shared/review';
import { Button } from '@/ui/button';
import { Kbd } from '@/ui/kbd';
import { Reveal } from '@/ui/motion';
import { openActivity } from '@/features/activity/use-operations';

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
  const locked = Boolean(draft?.activeOperationId);

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-t border-line bg-sunken px-4 text-xs">
      <span className="font-medium text-fg">
        {comments.length === 0
          ? 'No pending comments'
          : `${comments.length} pending ${comments.length === 1 ? 'comment' : 'comments'}`}
      </span>
      <Reveal show={Boolean(draft && draft.event !== 'COMMENT')} preset="pop" as="span">
        <span className="text-fg-muted">· {draft && reviewEventLabels[draft.event]}</span>
      </Reveal>
      <Reveal show={stale > 0} preset="pop" as="span">
        <span className="inline-flex items-center gap-1 text-pending">
          <AlertTriangle size={12} aria-hidden="true" /> {stale} need attention
        </span>
      </Reveal>
      <span className="text-fg-subtle tabular-nums">
        {viewed}/{total} files viewed · <Kbd keys="v" />
      </span>
      <span className="text-fg-subtle">
        Select lines and press <Kbd keys="c" /> to comment
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Reveal show={hasDraft && !locked} preset="pop" as="span">
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={onDiscard}>
            Discard
          </Button>
        </Reveal>
        <Button
          size="sm"
          variant="primary"
          icon={<Send size={12} />}
          onClick={locked ? openActivity : onFinish}
          shortcut="$mod+Shift+Enter"
        >
          {locked ? 'Review queued · View activity' : 'Finish review'}
        </Button>
      </div>
    </div>
  );
}
