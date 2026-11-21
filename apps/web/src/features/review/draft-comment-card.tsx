import { useEffect, useState } from 'react';
import { AlertTriangle, Pencil, Trash2 } from 'lucide-react';
import type { DraftComment } from '@review-desk/shared/review';
import { IconButton } from '@/ui/button';
import { cn } from '@/ui/cn';
import { MarkdownView } from '@/ui/markdown';
import { FadeSwap, Reveal } from '@/ui/motion';
import { Composer } from '@/features/review/composer';

/** A comment waiting in your review. Dashed so it never looks like something already posted. */
export function DraftCommentCard({
  comment,
  onEdit,
  onDelete,
  hideKept,
  busy,
}: {
  comment: DraftComment;
  onEdit: (body: string) => Promise<unknown>;
  onDelete: () => void;
  /** Hides a kept refusal from the banner while this card shows its very text: until called. */
  hideKept?: (key: string, text: string) => () => void;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(comment.body);
  /** A refusal of this edit, kept by the writer, with the text it was refused with. */
  const [refused, setRefused] = useState<{ key: string; text: string } | null>(null);
  const stale = comment.status === 'stale';

  // The refused text shown here as is: the banner need not show it too, meanwhile.
  useEffect(() => {
    if (!editing || !refused || !hideKept || body.trim() !== refused.text) return;

    return hideKept(refused.key, refused.text);
  }, [editing, refused, hideKept, body]);

  // Editing mounts the composer at once (it takes focus) while the card fades out above it. This
  // lives in the diff virtualizer, so nothing here animates height.
  if (editing) {
    return (
      <FadeSwap swapKey="edit" mode="popLayout">
        <Composer
          className="my-2 mr-4 ml-2"
          label="Edit pending comment"
          initial={comment.body}
          busy={busy}
          error={error}
          onChange={setBody}
          onCancel={() => {
            setEditing(false);
            setRefused(null);
          }}
          primary={{
            label: 'Save',
            keys: '$mod+Enter',
            variant: 'primary',
            run: async (text) => {
              try {
                await onEdit(text);
                setEditing(false);
                setRefused(null);
              } catch (failure) {
                const kept = (failure as { details?: { kept?: unknown } }).details?.kept;

                setError((failure as Error).message);
                setBody(text);
                setRefused(typeof kept === 'string' ? { key: kept, text } : null);
              }
            },
          }}
        />
      </FadeSwap>
    );
  }

  return (
    <FadeSwap swapKey="view" mode="popLayout">
      <div
        data-draft-id={comment.id}
        className={cn(
          'my-2 mr-4 ml-2 rounded-md border border-dashed bg-panel px-3 py-2 font-sans',
          stale ? 'border-pending' : 'border-accent/60',
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-xs">
          <span className={cn('font-medium', stale ? 'text-pending' : 'text-accent')}>
            {stale ? 'Needs attention' : 'Pending'}
          </span>
          <span className="text-fg-subtle">
            {stale
              ? 'this line changed since you wrote the comment'
              : comment.origin === 'ai'
                ? 'AI suggestion you accepted · in your review'
                : 'in your review, not posted yet'}
          </span>
          <span className="ml-auto flex items-center gap-0.5">
            <IconButton
              size="sm"
              label="Edit comment"
              icon={<Pencil size={12} />}
              onClick={() => setEditing(true)}
              disabled={busy || comment.status === 'pushed'}
            />
            <IconButton
              size="sm"
              label="Delete comment"
              icon={<Trash2 size={12} />}
              onClick={onDelete}
              disabled={busy || comment.status === 'pushed'}
            />
          </span>
        </div>
        <Reveal show={stale} preset="fade">
          <p className="mb-1 flex items-center gap-1.5 text-xs text-pending">
            <AlertTriangle size={12} aria-hidden="true" /> Edit or delete it before submitting.
          </p>
        </Reveal>
        <MarkdownView>{comment.body}</MarkdownView>
      </div>
    </FadeSwap>
  );
}
