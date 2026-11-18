import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { instanceUrl, parseAccount } from '@review-desk/shared/accounts';
import { formatRef, parsePrRef } from '@/lib/pr-ref';
import { useForge, useStatus } from '@/lib/queries';
import { Button, IconButton } from '@/ui/button';
import { DialogClose, DialogDescription, DialogTitle, Modal } from '@/ui/dialog';
import { useAddAndOpen } from '@/features/pulls/use-track';

/**
 * Adds any open PR or MR to your review queue from a GitHub or GitLab link, `owner/repo#123`, or
 * `group/project!123`.
 */
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
  const forge = useForge();
  const actor = useStatus().data?.account;
  const account = parseAccount(actor?.login ?? '');
  const placeholder =
    account.forge === 'gitlab'
      ? `${instanceUrl(actor?.webUrl) ?? `https://${account.host}`}/group/project/-/merge_requests/123 or group/project!123`
      : 'https://github.com/owner/repo/pull/123 or owner/repo#123';

  // Cleared once the dialog has faded out, so its text never changes in view.
  const clear = () => {
    setText('');
    setTried(false);
    reset();
  };

  const submit = async () => {
    setTried(true);

    if (!ref || pending) return;

    try {
      await add(ref);
      onOpenChange(false);
    } catch {
      // Shown below the field from the mutation's error.
    }
  };

  const message = error
    ? error.message
    : tried && text.trim() && !ref
      ? 'Enter a PR or MR link, owner/repo#123, or group/project!123.'
      : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      onExitComplete={clear}
      className="top-[18vh] w-[480px] p-5"
    >
      <div className="mb-1 flex items-center justify-between">
        <DialogTitle className="text-base font-semibold">
          Add a {forge.short} to your queue
        </DialogTitle>
        <DialogClose asChild>
          <IconButton label="Close" icon={<X size={15} />} size="sm" />
        </DialogClose>
      </div>
      <DialogDescription className="mb-4 text-sm text-fg-muted">
        Track any open {forge.short}, even when nobody asked for your review. It stays until it is
        merged, closed or removed.
      </DialogDescription>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="add-pull-ref" className="mb-1.5 block text-xs font-medium text-fg">
          {forge.long[0].toUpperCase() + forge.long.slice(1)}
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
          placeholder={placeholder}
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
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
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
    </Modal>
  );
}
