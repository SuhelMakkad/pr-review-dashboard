import { useState } from 'react';
import { AlertTriangle, Pencil, Trash2 } from 'lucide-react';
import type { DraftComment } from '@review-desk/shared/review';
import { IconButton } from '@/ui/button';
import { cn } from '@/ui/cn';
import { MarkdownView } from '@/ui/markdown';
import { Composer } from '@/features/review/composer';

/** A comment waiting in your review. Dashed so it never looks like something already posted. */
export function DraftCommentCard({
  comment,
  onEdit,
  onDelete,
  busy,
}: {
  comment: DraftComment;
  onEdit: (body: string) => Promise<unknown>;
  onDelete: () => void;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = comment.status === 'stale';

  if (editing) {
    return (
      <Composer
        className="my-2 mr-4 ml-2"
        label="Edit pending comment"
        initial={comment.body}
        busy={busy}
        error={error}
        onCancel={() => setEditing(false)}
        primary={{
          label: 'Save',
          keys: '$mod+Enter',
          variant: 'primary',
          run: async (body) => {
            try {
              await onEdit(body);
              setEditing(false);
            } catch (failure) {
              setError((failure as Error).message);
            }
          },
        }}
      />
    );
  }

  return (
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
      {stale && (
        <p className="mb-1 flex items-center gap-1.5 text-xs text-pending">
          <AlertTriangle size={12} aria-hidden="true" /> Edit or delete it before submitting.
        </p>
      )}
      <MarkdownView>{comment.body}</MarkdownView>
    </div>
  );
}
