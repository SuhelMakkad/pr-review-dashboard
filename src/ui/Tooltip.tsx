import type { ReactNode } from 'react';
import { Tooltip as Primitive } from 'radix-ui';
import { Kbd } from './Kbd';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Primitive.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </Primitive.Provider>
  );
}

export function Tooltip({
  label,
  shortcut,
  children,
  side = 'top',
}: {
  label: ReactNode;
  shortcut?: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          className="z-50 flex items-center gap-2 rounded-sm border border-line bg-elevated px-2 py-1 text-xs text-fg shadow-popover"
        >
          {label}
          {shortcut && <Kbd keys={shortcut} />}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
