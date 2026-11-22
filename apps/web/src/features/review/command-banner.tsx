import { useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { reviewEventLabels } from '@review-desk/shared/review';
import { ATTEMPT_MESSAGES, type AttemptView } from '@/features/review/draft-attempts';
import type { CommandView } from '@/features/review/draft-commands';
import type { StartView } from '@/features/review/summary-start';
import type { DraftWriter } from '@/features/review/draft-writer';
import { openActivity } from '@/features/activity/use-operations';
import { Button } from '@/ui/button';

/** What the page around the banner can do for its entries. */
export interface BannerActions {
  /** Opens a composer with a kept comment's text, to add it as a new comment. */
  addAsNew?: (write: AttemptView) => void;
  /** Whether the draft still has the comment an edit was for: it is edited there, then. */
  hasComment?: (id: string) => boolean;
  /** Shows the comment a write was for. */
  checkComment?: (write: AttemptView) => void;
  /** Opens the summary and verdict, with the generated summaries (the finish sheet). */
  openFinish?: () => void;
}

/**
 * The draft's changes, summary starts, and submit and discard commands whose outcome is not
 * known, still being learnt, or settled without them saved: with what you can do about each.
 * Nothing here is ever sent again on its own.
 */
export function CommandBanner({
  writer,
  actions = {},
}: {
  writer: DraftWriter;
  actions?: BannerActions;
}) {
  const commands = writer.commandViews();
  const writes = writer.writeViews();
  const starts = writer.startViews();
  const settled =
    commands.filter((command) => command.phase === 'lost').length +
    writes.filter((write) => write.phase === 'not-saved' || write.phase === 'lost').length +
    starts.filter((start) => start.phase === 'not-started' || start.phase === 'lost').length;

  if (commands.length === 0 && writes.length === 0 && starts.length === 0) return null;

  return (
    <div className="space-y-2">
      {settled > 1 && (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => writer.dismissSettled()}>
            Dismiss all settled
          </Button>
        </div>
      )}
      {writes.length > 0 && (
        <Section title={`Draft changes (${writes.length})`}>
          {writes.map((write) => (
            <WriteNotice key={write.key} writer={writer} write={write} actions={actions} />
          ))}
        </Section>
      )}
      {starts.length > 0 && (
        <Section title={`Summary starts (${starts.length})`}>
          {starts.map((start) => (
            <StartNotice key={start.key} writer={writer} start={start} actions={actions} />
          ))}
        </Section>
      )}
      {commands.length > 0 && (
        <Section title={`Submit and discard (${commands.length})`}>
          {commands.map((command) => (
            <CommandNotice key={command.id} writer={writer} command={command} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

/** Runs a banner action, saying why it failed. */
function useAct() {
  const [busy, setBusy] = useState(false);
  // A click handler that settles its own work, a throw included: a failure is shown, and the
  // buttons are enabled again.
  const act = (run: () => Promise<void>, failure: string) => () => {
    void (async () => {
      setBusy(true);

      try {
        await run();
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : failure);
      } finally {
        setBusy(false);
      }
    })();
  };

  return { busy, act };
}

function Notice({
  pending,
  headline,
  children,
}: {
  pending?: boolean;
  headline: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className="space-y-2 rounded-sm border border-pending/40 bg-pending/5 p-3 text-xs"
    >
      <p className="flex items-start gap-1.5 text-fg">
        {pending ? (
          <Loader2 size={13} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin" />
        ) : (
          <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-pending" />
        )}
        {headline}
      </p>
      {children}
    </div>
  );
}

function writeHeadline(write: AttemptView): string {
  const note = write.unrecorded ? ` ${ATTEMPT_MESSAGES.unrecorded}` : '';

  if (write.phase === 'received')
    return `${write.label} was received, and may still be saved: checking.`;
  if (write.phase === 'not-saved')
    return `${write.label} was not saved.${write.reason ? ` ${write.reason}` : ''}${note}`;
  if (write.phase === 'lost')
    return `${write.label} was stopped, but it may have been saved before. It can no longer be saved now.`;
  if (write.received)
    return `${write.label} was received earlier; whether it was saved can no longer be told.`;
  if (write.canSendAgain)
    return `${write.label} could not be confirmed. It has not arrived yet, and is never sent again unless you choose to.`;

  return `${write.label} could not be confirmed as saved. Check the draft, or stop it: if it has not been received yet, it never will be.`;
}

function WriteNotice({
  writer,
  write,
  actions,
}: {
  writer: DraftWriter;
  write: AttemptView;
  actions: BannerActions;
}) {
  const { busy, act } = useAct();
  const [showText, setShowText] = useState(false);
  // An edit whose comment is still in the draft is edited there: no new comment of it.
  const addAsNew =
    write.canAddAsNew &&
    actions.addAsNew !== undefined &&
    !(write.commentId && actions.hasComment?.(write.commentId));

  return (
    <Notice pending={write.phase === 'received'} headline={writeHeadline(write)}>
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
        {addAsNew && (
          <Button size="sm" onClick={() => actions.addAsNew!(write)}>
            Add as a new comment
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
        {write.inspect === 'comment' && actions.checkComment && (
          <Button size="sm" variant="ghost" onClick={() => actions.checkComment!(write)}>
            Check the comment
          </Button>
        )}
        {write.inspect === 'summary' && actions.openFinish && (
          <Button size="sm" variant="ghost" onClick={actions.openFinish}>
            Check the summary and verdict
          </Button>
        )}
        {write.texts.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowText((shown) => !shown)}>
            {showText ? 'Hide my text' : 'Keep my text'}
          </Button>
        )}
        {write.phase !== 'received' && (
          <Button size="sm" variant="ghost" onClick={() => writer.dismissWrite(write.key)}>
            Dismiss
          </Button>
        )}
      </div>
      {showText && write.texts.map((text, index) => <KeptText key={index} text={text} />)}
    </Notice>
  );
}

function startHeadline(start: StartView): string {
  if (start.phase === 'not-started')
    return `The summary did not start.${start.reason ? ` ${start.reason}` : ''}`;
  if (start.phase === 'lost')
    return 'Starting the summary was stopped, but it may have started before. It can no longer start now.';
  if (start.canSendAgain)
    return 'Starting the summary could not be confirmed. It has not arrived yet, and is never sent again unless you choose to.';

  return 'Starting the summary could not be confirmed. Check its summaries, or stop it: if it has not been received yet, it never will be.';
}

function StartNotice({
  writer,
  start,
  actions,
}: {
  writer: DraftWriter;
  start: StartView;
  actions: BannerActions;
}) {
  const { busy, act } = useAct();

  return (
    <Notice headline={startHeadline(start)}>
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
        {start.phase !== 'not-started' && actions.openFinish && (
          <Button size="sm" variant="ghost" onClick={actions.openFinish}>
            View summaries
          </Button>
        )}
        {start.phase !== 'unknown' && (
          <Button size="sm" variant="ghost" onClick={() => writer.dismissStart(start.key)}>
            Dismiss
          </Button>
        )}
      </div>
    </Notice>
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
  const { busy, act } = useAct();
  const [showText, setShowText] = useState(false);
  const text = command.carried
    ? [command.carried.body, `Verdict: ${reviewEventLabels[command.carried.event]}`]
        .filter(Boolean)
        .join('\n\n')
    : null;

  return (
    <Notice pending={command.phase === 'admitted'} headline={headline(command)}>
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
        {(command.phase === 'admitted' || command.phase === 'lost') && (
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
    </Notice>
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
