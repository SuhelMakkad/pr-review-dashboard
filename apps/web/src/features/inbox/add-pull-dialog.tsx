import { useState } from 'react';
import { Dialog } from 'radix-ui';
import { Plus, X } from 'lucide-react';
import { formatRef, parsePrRef } from '@/lib/pr-ref';
import { Button, IconButton } from '@/ui/button';
import { useAddAndOpen } from '@/features/pulls/use-track';

/** Adds any open PR to your review queue from a GitHub link or `owner/repo#123`. */
export function AddPullDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const { add, pending, error, reset } = useAddAndOpen();
  const ref = parsePrRef(text);

  const change = (next: boolean) => {
    if (!next) {
      setText('');
      setTried(false);
      reset();
    }

    onOpenChange(next);
  };

  const submit = async () => {
    setTried(true);

    if (!ref || pending) return;

    try {
      await add(ref);
      change(false);
    } catch {
      // Shown below the field from the mutation's error.
    }
  };

  const message = error
    ? error.message
    : tried && text.trim() && !ref
      ? 'Enter a GitHub PR link, or owner/repo#123.'
      : null;

  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 dark:bg-black/50" />
        <Dialog.Content className="fixed top-[18vh] left-1/2 z-50 w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-line bg-elevated p-5 shadow-popover">
          <div className="mb-1 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Add a PR to your queue</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close" icon={<X size={15} />} size="sm" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-fg-muted">
            Track any open PR, even when nobody asked for your review. It stays until it is merged,
            closed or removed.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="add-pull-ref" className="mb-1.5 block text-xs font-medium text-fg">
              Pull request
            </label>
            <input
              id="add-pull-ref"
              autoFocus
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setTried(false);
                reset();
              }}
              placeholder="https://github.com/owner/repo/pull/123 or owner/repo#123"
              aria-invalid={Boolean(message)}
              aria-describedby="add-pull-message"
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full rounded-sm border border-line bg-sunken px-2 text-sm outline-none focus:border-accent"
            />
            <p
              id="add-pull-message"
              className={`min-h-5 px-0.5 pt-1.5 text-xs ${message ? 'text-fail' : 'text-fg-muted'}`}
              aria-live="polite"
            >
              {message ?? (ref ? `Adds ${formatRef(ref)} · press ↵` : '')}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button size="sm" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                icon={<Plus size={13} />}
                disabled={pending}
              >
                {pending ? 'Adding…' : 'Add to queue'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
