import { useEffect, useRef, useState } from 'react';
import { Eye, Pencil } from 'lucide-react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { MarkdownView } from '@/ui/markdown';

export interface ComposerAction {
  label: string;
  keys: string;
  /** Public actions are labelled with who they post as. */
  variant: 'primary' | 'secondary';
  run: (body: string) => Promise<unknown> | void;
}

/**
 * Markdown comment box. ⌘↵ runs the primary action, ⌥⌘↵ the alternate, Esc cancels, ⌘⇧P previews.
 * The text survives a failed send so nothing typed is ever lost.
 */
export function Composer({
  label,
  initial = '',
  placeholder,
  primary,
  alternate,
  onCancel,
  busy,
  error,
  className,
}: {
  label: string;
  initial?: string;
  placeholder?: string;
  primary: ComposerAction;
  alternate?: ComposerAction;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  className?: string;
}) {
  const [body, setBody] = useState(initial);
  const [preview, setPreview] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const empty = body.trim().length === 0;

  useEffect(() => {
    textarea.current?.focus();
    textarea.current?.setSelectionRange(body.length, body.length);
  }, []);

  const send = async (action: ComposerAction) => {
    if (empty || busy) return;

    await action.run(body.trim());
  };

  return (
    <div
      className={cn('rounded-md border border-accent/60 bg-panel font-sans shadow-sm', className)}
      onClick={(event) => event.stopPropagation()}
    >
      {preview ? (
        <div className="min-h-[84px] px-3 py-2">
          {empty ? (
            <p className="text-sm text-fg-subtle">Nothing to preview.</p>
          ) : (
            <MarkdownView>{body}</MarkdownView>
          )}
        </div>
      ) : (
        <textarea
          ref={textarea}
          value={body}
          aria-label={label}
          placeholder={placeholder ?? 'Leave a comment (Markdown supported)'}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            const mod = event.metaKey || event.ctrlKey;

            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            } else if (mod && event.key === 'Enter') {
              event.preventDefault();
              void send(event.altKey && alternate ? alternate : primary);
            } else if (mod && event.shiftKey && event.key.toLowerCase() === 'p') {
              event.preventDefault();
              setPreview(true);
            }
          }}
          rows={4}
          className="block min-h-[84px] w-full resize-y rounded-t-md bg-transparent px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
      )}
      {error && (
        <p role="alert" className="border-t border-line px-3 py-1.5 text-xs text-fail">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={preview ? <Pencil size={12} /> : <Eye size={12} />}
          onClick={() => setPreview(!preview)}
        >
          {preview ? 'Write' : 'Preview'}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} shortcut="Escape">
            Cancel
          </Button>
          {alternate && (
            <Button
              size="sm"
              variant={alternate.variant}
              disabled={empty || busy}
              onClick={() => void send(alternate)}
              shortcut={alternate.keys}
            >
              {alternate.label}
            </Button>
          )}
          <Button
            size="sm"
            variant={primary.variant}
            disabled={empty || busy}
            onClick={() => void send(primary)}
            shortcut={primary.keys}
          >
            {busy ? 'Saving…' : primary.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
