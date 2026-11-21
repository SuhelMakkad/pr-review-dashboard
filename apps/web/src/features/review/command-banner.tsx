import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { reviewEventLabels } from '@review-desk/shared/review';
import type { AttemptView } from '@/features/review/draft-attempts';
import type { CommandView } from '@/features/review/draft-commands';
import type { StartView } from '@/features/review/summary-start';
import type { DraftWriter } from '@/features/review/draft-writer';
import { openActivity } from '@/features/activity/use-operations';
import { Button } from '@/ui/button';

/**
 * The draft's submit and discard commands whose outcome is not known, a discard being cleaned up,
 * and any stopped without knowing whether it was received; and its comment and AI writes not
 * confirmed, not saved, or stopped so: with what you can do about each. Nothing here is ever sent
 * again on its own.
 */
export function CommandBanner({ writer }: { writer: DraftWriter }) {
  const commands = writer.commandViews();
  const writes = writer.writeViews();
  const starts = writer.startViews();

  if (commands.length === 0 && writes.length === 0 && starts.length === 0) return null;

  return (
    <div className="space-y-2">
      {commands.length > 0 && (
        <section aria-label="Submit and discard not yet confirmed" className="space-y-2">
          {commands.map((command) => (
            <CommandNotice key={command.id} writer={writer} command={command} />
          ))}
        </section>
      )}
      {writes.length > 0 && (
        <section aria-label="Changes to your draft not yet confirmed" className="space-y-2">
          {writes.map((write) => (
            <WriteNotice key={write.key} writer={writer} write={write} />
          ))}
        </section>
      )}
      {starts.length > 0 && (
        <section aria-label="Summary starts not yet confirmed" className="space-y-2">
          {starts.map((start) => (
            <StartNotice key={start.key} writer={writer} start={start} />
          ))}
        </section>
      )}
    </div>
  );
}

function startHeadline(start: StartView): string {
  if (start.phase === 'not-started')
    return `The summary did not start.${start.reason ? ` ${start.reason}` : ''}`;
  if (start.phase === 'lost')
    return 'Starting the summary was stopped, but it may have started before. It can no longer start now.';
  if (start.canSendAgain)
    return 'Starting the summary could not be confirmed. It has not arrived yet, and is never sent again unless you choose to.';

  return 'Starting the summary could not be confirmed. Check its runs, or stop it to be sure it never starts.';
}

function StartNotice({ writer, start }: { writer: DraftWriter; start: StartView }) {
  const [busy, setBusy] = useState(false);
  const act = (run: () => Promise<void>, failure: string) => async () => {
    setBusy(true);

    try {
      await run();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="space-y-2 rounded-sm border border-pending/40 bg-pending/5 p-3 text-xs"
    >
      <p className="flex items-start gap-1.5 text-fg">
        <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-pending" />
        {startHeadline(start)}
      </p>
      <div className="flex flex-wrap gap-2">
        {start.canSendAgain && (
          <Button
            size="sm"
            disabled={busy}
            onClick={act(() => writer.sendStartAgain(start.key), 'Could not send it again.')}
          >
            Send again
          </Button>
        )}
        {start.canStop && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={act(() => writer.stopStart(start.key), 'Could not stop it. Try again.')}
          >
            Stop it
          </Button>
        )}
        {start.phase !== 'unknown' && (
          <Button size="sm" variant="ghost" onClick={() => writer.dismissStart(start.key)}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

function writeHeadline(write: AttemptView): string {
  if (write.phase === 'not-saved')
    return `${write.label} was not saved.${write.reason ? ` ${write.reason}` : ''}`;
  if (write.phase === 'lost')
    return `${write.label} was stopped, but it may have been saved before. It can no longer be saved now.`;
  if (write.canSendAgain)
    return `${write.label} could not be confirmed. It has not arrived yet, and is never sent again unless you choose to.`;

  return `${write.label} could not be confirmed as saved. Check the draft, or stop it to be sure it is never saved.`;
}

function WriteNotice({ writer, write }: { writer: DraftWriter; write: AttemptView }) {
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);
  const act = (run: () => Promise<void>, failure: string) => async () => {
    setBusy(true);

    try {
      await run();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="space-y-2 rounded-sm border border-pending/40 bg-pending/5 p-3 text-xs"
    >
      <p className="flex items-start gap-1.5 text-fg">
        <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-pending" />
        {writeHeadline(write)}
      </p>
      <div className="flex flex-wrap gap-2">
        {write.canSendAgain && (
          <Button
            size="sm"
            disabled={busy}
            onClick={act(() => writer.sendWriteAgain(write.key), 'Could not send it again.')}
          >
            Send again
          </Button>
        )}
        {write.canStop && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={act(() => writer.stopWrite(write.key), 'Could not stop it. Try again.')}
          >
            Stop it
          </Button>
        )}
        {write.text && (
          <Button size="sm" variant="ghost" onClick={() => setShowText((shown) => !shown)}>
            {showText ? 'Hide my text' : 'Keep my text'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => writer.dismissWrite(write.key)}>
          Dismiss
        </Button>
      </div>
      {showText && write.text && <KeptText text={write.text} />}
    </div>
  );
}

/** Text kept here, never saved on its own, with a way to copy it. */
function KeptText({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      <textarea
        readOnly
        aria-label="Your text, kept here and never saved on its own"
        value={text}
        rows={4}
        className="w-full resize-y rounded-sm border border-line bg-sunken px-2 py-1.5 text-xs"
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => toast('Your text copied'),
            () => toast.error('Could not copy your text'),
          )
        }
      >
        Copy
      </Button>
    </div>
  );
}

function headline(command: CommandView): string {
  const what = command.kind === 'submit' ? 'Submitting your review' : 'Discarding your draft';

  if (command.phase === 'admitted' && command.missing)
    return 'Discarding your draft was received, but its record is gone. Stop it to save your edits on the current draft.';
  if (command.phase === 'admitted')
    return command.status === 'needs_attention'
      ? 'Discarding your draft needs your attention in Activity. Your edits wait until it is done.'
      : 'Discarding your draft. Your edits wait until it is done.';
  if (command.phase === 'lost')
    return `${what} was stopped, but it may have been received before. It can no longer be received now.`;
  if (command.legacy) return `${what}, started before this version, could not be confirmed.`;

  return `${what} could not be confirmed. It is never sent again unless you choose to.`;
}

function CommandNotice({ writer, command }: { writer: DraftWriter; command: CommandView }) {
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);
  const text = command.carried
    ? [command.carried.body, `Verdict: ${reviewEventLabels[command.carried.event]}`]
        .filter(Boolean)
        .join('\n\n')
    : null;
  const act = (run: () => Promise<void>, failure: string) => async () => {
    setBusy(true);

    try {
      await run();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="space-y-2 rounded-sm border border-pending/40 bg-pending/5 p-3 text-xs"
    >
      <p className="flex items-start gap-1.5 text-fg">
        {command.phase === 'admitted' ? (
          <Loader2 size={13} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin" />
        ) : (
          <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-pending" />
        )}
        {headline(command)}
      </p>
      <div className="flex flex-wrap gap-2">
        {command.canSendAgain && (
          <Button
            size="sm"
            disabled={busy}
            onClick={act(() => writer.sendAgain(command.id), 'Could not send it again.')}
          >
            Send again
          </Button>
        )}
        {(command.phase === 'unknown' || command.missing) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={act(() => writer.stop(command.id), 'Could not stop it. Try again.')}
          >
            Stop it
          </Button>
        )}
        {command.phase === 'admitted' && (
          <Button size="sm" variant="ghost" onClick={openActivity}>
            View activity
          </Button>
        )}
        {text && (
          <Button size="sm" variant="ghost" onClick={() => setShowText((shown) => !shown)}>
            {showText ? 'Hide my text' : 'Keep my text'}
          </Button>
        )}
        {command.phase === 'lost' && (
          <Button size="sm" variant="ghost" onClick={() => writer.dismiss(command.id)}>
            Dismiss
          </Button>
        )}
      </div>
      {showText && text && <KeptText text={text} />}
    </div>
  );
}
