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

  latest.current = note;

  useEffect(() => {
    if (note === saved) {
      writeDraft(key, null);
      setState((current) => (current === 'saving' || current === 'dirty' ? 'saved' : current));
      return;
    }

    writeDraft(key, note);
    setState('dirty');

    const timer = setTimeout(() => {
      setState('saving');
      onSave(note).then(
        () => latest.current === note && setState('saved'),
        () => setState('error'),
      );
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
        onChange={(event) => setNote(event.target.value)}
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
