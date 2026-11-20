import { forwardRef, useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { forgeTerms } from '@review-desk/shared/accounts';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const draftKey = (account: string, id: string) => `review-desk-draft:${account}:${id}`;

function readDraft(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Note saves per account and PR, kept outside any one editor: an editor that remounts (a switch
 * away and back) joins the same queue, so saves always reach the server in the order they were made.
 */
interface SaveQueue {
  chain: Promise<unknown>;
  /** Saves queued and not yet settled. */
  pending: number;
  /** The text of the last save queued: the one the server ends with once the queue drains. */
  last: string | null;
  /** The last save queued failed: its text is not saved, and its draft is kept to retry. */
  failed: boolean;
  /** Called once the queue drains, by the editor showing it (if any). */
  drained: (() => void) | null;
}

const saveQueues = new Map<string, SaveQueue>();

function saveQueue(key: string): SaveQueue {
  let queue = saveQueues.get(key);

  if (!queue) {
    queue = { chain: Promise.resolve(), pending: 0, last: null, failed: false, drained: null };
    saveQueues.set(key, queue);
  }

  return queue;
}

function writeDraft(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // The server copy is authoritative; the tab draft is only a safety net.
  }
}

/** Private note that autosaves to the local database; a tab-local draft survives crashes. */
export const Notes = forwardRef<
  HTMLTextAreaElement,
  {
    account: string;
    id: string;
    saved: string;
    onSave: (note: string) => Promise<unknown>;
  }
>(function Notes({ account, id, saved, onSave }, ref) {
  const key = draftKey(account, id);
  const [note, setNote] = useState(() => readDraft(key) ?? saved);
  const [state, setState] = useState<SaveState>(note === saved ? 'saved' : 'dirty');
  const latest = useRef(note);
  /**
   * True once text was typed here (or a tab draft of it survived) and not yet saved. Until then the
   * editor follows the saved note, so a newer note from elsewhere (another window, the account's
   * own fresher copy after a switch) is shown, never saved back over by the older text.
   */
  const edited = useRef(readDraft(key) !== null);
  const queue = saveQueue(key);
  const latestSaved = useRef(saved);

  latest.current = note;
  latestSaved.current = saved;

  /**
   * Clean once nothing is in flight, the last save did not fail, and the text is what was saved:
   * the draft can go.
   */
  const settle = () => {
    if (queue.pending > 0 || queue.failed || latest.current !== latestSaved.current) return;

    edited.current = false;
    writeDraft(key, null);
    setState((current) => (current === 'saving' || current === 'dirty' ? 'saved' : current));
  };

  // The queue tells this editor when it drains: the saved note may have arrived before the reply.
  useEffect(() => {
    queue.drained = settle;

    return () => {
      if (queue.drained === settle) queue.drained = null;
    };
  });

  useEffect(() => {
    if (!edited.current) setNote(saved);
  }, [saved]);

  useEffect(() => {
    // Matching the saved note counts only once no save is in flight: an older one could still
    // land after it and replace the text you went back to.
    if (note === saved && queue.pending === 0) {
      settle();
      return;
    }

    if (!edited.current) return;

    writeDraft(key, note);
    setState('dirty');

    // Already the last save on its way: the queue ends with this text.
    if (queue.pending > 0 && queue.last === note) return;

    const timer = setTimeout(() => {
      setState('saving');
      queue.pending += 1;
      queue.last = note;

      // After the saves before it, from this editor or an earlier one: the last text you typed
      // is the one the server keeps.
      queue.chain = queue.chain
        .catch(() => undefined)
        .then(() => onSave(note))
        .then(
          () => {
            if (queue.last === note) queue.failed = false;
            if (latest.current === note) setState('saved');
          },
          () => {
            if (queue.last === note) queue.failed = true;
            setState('error');
          },
        )
        .finally(() => {
          queue.pending -= 1;

          if (queue.pending > 0) return;

          // Saved, with nothing newer queued: a draft of exactly that text is done, whether or not
          // an editor still shows it, so a later editor never saves it again over a newer note. A
          // draft of newer text, typed since, stays.
          if (!queue.failed && readDraft(key) === queue.last) writeDraft(key, null);

          queue.drained?.();
        });
    }, 800);

    return () => clearTimeout(timer);
  }, [note, saved]);

  return (
    <section aria-labelledby="notes-heading">
      <div className="mb-2 flex items-center justify-between">
        <h3
          id="notes-heading"
          className="text-xs font-semibold tracking-wide text-fg-subtle uppercase"
        >
          Private note
        </h3>
        <span className="inline-flex items-center gap-1 text-2xs text-fg-subtle" aria-live="polite">
          <Lock size={10} aria-hidden="true" />
          {state === 'saving'
            ? 'Saving…'
            : state === 'dirty'
              ? 'Unsaved'
              : state === 'error'
                ? 'Not saved — retrying when you type'
                : 'Only on this device'}
        </span>
      </div>
      <textarea
        ref={ref}
        value={note}
        maxLength={30_000}
        onChange={(event) => {
          edited.current = true;
          setNote(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur();
        }}
        placeholder={`Reminders for your next pass. Never sent to ${forgeTerms(account).name}.`}
        aria-label="Private note"
        rows={3}
        className="w-full resize-y rounded-sm border border-line bg-sunken px-3 py-2 text-sm outline-none placeholder:text-fg-subtle focus:border-accent"
      />
    </section>
  );
});
