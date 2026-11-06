import { useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { AlarmClock } from 'lucide-react';
import type { PullRequestItem } from '../../../../../packages/shared/src/types';
import { parseSnooze, shortDateTime, snoozePresets } from '../../lib/time';
import { Button } from '../../ui/button';
import { Kbd } from '../../ui/kbd';

export function SnoozeMenu({
  item,
  open,
  onOpenChange,
  onSnooze,
  onWake,
}: {
  item: PullRequestItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (until: Date) => void;
  onWake: () => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const presets = snoozePresets();
  const parsed = text ? parseSnooze(text) : null;

  const choose = (until: Date) => {
    onOpenChange(false);
    setText('');
    onSnooze(until);
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button size="sm" icon={<AlarmClock size={13} />} shortcut="s">
          {item.snoozedUntil ? 'Snoozed' : 'Snooze'}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-md border border-line bg-elevated p-1 text-sm text-fg shadow-popover"
          onKeyDown={(event) => {
            if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return;

            const preset = presets[Number(event.key) - 1];

            if (preset) {
              event.preventDefault();
              choose(preset.until);
            } else if (/^[a-z]$/i.test(event.key)) {
              // Typing a phrase starts in the text box; the key lands there.
              inputRef.current?.focus();
            }
          }}
        >
          <div className="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
            Snooze until
          </div>
          {presets.map((preset, index) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => choose(preset.until)}
              className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left hover:bg-selected focus-visible:bg-selected focus-visible:outline-none"
            >
              <span className="flex-1">{preset.label}</span>
              <span className="text-xs text-fg-subtle">
                {shortDateTime(preset.until.toISOString())}
              </span>
              <Kbd keys={String(index + 1)} />
            </button>
          ))}
          <form
            className="mt-1 border-t border-line p-1.5"
            onSubmit={(event) => {
              event.preventDefault();

              if (parsed) choose(parsed);
            }}
          >
            <input
              ref={inputRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Or type: 3h, tomorrow 2pm, fri…"
              aria-label="Snooze until"
              className="h-8 w-full rounded-sm border border-line bg-sunken px-2 text-sm outline-none focus:border-accent"
            />
            {text && (
              <p className="px-1 pt-1.5 text-xs text-fg-muted" aria-live="polite">
                {parsed ? (
                  <>
                    Snooze until{' '}
                    <strong className="text-fg">{shortDateTime(parsed.toISOString())}</strong> ·
                    press ↵
                  </>
                ) : (
                  'Not sure when that is. Try "2h", "tomorrow 9am" or "mon".'
                )}
              </p>
            )}
          </form>
          {item.snoozedUntil && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onWake();
              }}
              className="flex h-8 w-full items-center rounded-sm px-2 text-left text-accent hover:bg-selected"
            >
              Wake now
            </button>
          )}
          <p className="px-2 pt-1 pb-1.5 text-2xs text-fg-subtle">New activity wakes it early.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
