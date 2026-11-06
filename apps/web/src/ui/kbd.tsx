import { keyCaps } from '../lib/shortcuts';
import { cn } from './cn';

/** Renders a shortcut as key caps: '$mod+k' → ⌘ K, 'g i' → G then I. */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  const presses = keyCaps(keys);

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-fg-subtle', className)}
      aria-hidden="true"
    >
      {presses.map((press, index) => (
        <span key={index} className="inline-flex items-center gap-0.5">
          {index > 0 && <span className="px-0.5 text-2xs">then</span>}
          {press.map((cap) => (
            <kbd
              key={cap}
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line-strong bg-sunken px-1 text-2xs leading-none font-medium text-fg-muted"
            >
              {cap}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
