import { forwardRef, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { forgeTerms } from '@review-desk/shared/accounts';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const DEBOUNCE_MS = 800;

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

/**
 * One PR's note, per account, kept outside any editor: the text you typed and have not had
 * confirmed, and the saves on their way. Editors only show it, so one that closes (a switch away)
 * and one that opens later share the same edit, the same order of saves and the same outcome.
 */
class NoteEdit {
  /** Typed and not yet confirmed saved, mirrored in the tab draft; null once saved. */
  edit: string | null;
  /** The last save that settled failed: the edit is kept, and is retried. */
  failed = false;
  /** Saves sent and not yet settled. */
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly key: string) {
    this.edit = readDraft(key);
  }

  get state(): SaveState {
    if (this.edit === null) return 'saved';
    if (this.timer) return 'dirty';
    if (this.pending > 0) return 'saving';

    return this.failed ? 'error' : 'dirty';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private acknowledge() {
    this.edit = null;
    this.failed = false;
    writeDraft(this.key, null);
  }

  /** You typed `text` in an editor showing `saved`. */
  type(text: string, saved: string, onSave: (note: string) => Promise<unknown>) {
    this.edit = text;
    writeDraft(this.key, text);
    this.schedule(saved, onSave);
  }

  /**
   * Sends the edit after a pause, unless it is the saved note with nothing on its way and nothing
   * failed: then there is nothing to send. With a save on its way, or one that failed, it is sent
   * even then, since the server may not end with it otherwise.
   */
  schedule(saved: string, onSave: (note: string) => Promise<unknown>) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    if (this.edit === null) return this.notify();

    if (this.edit === saved && this.pending === 0 && !this.failed) {
      this.acknowledge();
      return this.notify();
    }

    this.timer = setTimeout(() => this.send(onSave), DEBOUNCE_MS);
    this.notify();
  }

  /** Retries an edit nothing is sending: one that failed, or a tab draft restored after a reload. */
  retry(saved: string, onSave: (note: string) => Promise<unknown>) {
    if (this.edit === null || this.timer || this.pending > 0) return;

    this.schedule(saved, onSave);
  }

  private send(onSave: (note: string) => Promise<unknown>) {
    const text = this.edit;

    this.timer = null;
    if (text === null) return this.notify();

    this.pending += 1;
    this.notify();

    // After every save before it, from this editor or an earlier one: the server ends with the
    // last text you typed.
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => onSave(text))
      .then(
        () => this.settle(text, true),
        () => this.settle(text, false),
      );
  }

  private settle(text: string, ok: boolean) {
    this.pending -= 1;
    this.failed = !ok;

    // Confirmed only by its own save, with nothing newer typed or on its way since, whether or not
    // an editor still shows it: a later editor then never sends it again over a newer note.
    const confirmed = ok && this.pending === 0 && !this.timer && this.edit === text;

    if (!confirmed) return this.notify();

    this.acknowledge();
    // Shown after the saved note catches up: the save's reply updates it in the same tick, and the
    // cache tells its readers on the next one. Editors would otherwise flash the older note.
    setTimeout(() => this.notify(), 0);
  }
}

const noteEdits = new Map<string, NoteEdit>();

function noteEdit(key: string): NoteEdit {
  let edit = noteEdits.get(key);

  if (!edit) {
    edit = new NoteEdit(key);
    noteEdits.set(key, edit);
  }

  return edit;
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
  const note = noteEdit(key);
  const [, render] = useState(0);

  useEffect(() => note.subscribe(() => render((version) => version + 1)), [note]);

  // An edit nothing is sending (one that failed, or a tab draft restored after a reload) is sent
  // again when the editor opens and whenever the saved note changes.
  useEffect(() => {
    note.retry(saved, onSave);
  }, [note, saved]);

  const shown = note.edit ?? saved;
  const state = note.state;

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
        value={shown}
        maxLength={30_000}
        onChange={(event) => note.type(event.target.value, saved, onSave)}
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
