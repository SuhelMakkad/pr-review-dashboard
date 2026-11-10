import { useState, type ReactNode } from 'react';
import { Tooltip as Primitive } from 'radix-ui';
import { AnimatePresence, m } from 'motion/react';
import { Kbd } from '@/ui/kbd';
import { pop, presence } from '@/ui/motion/presets';

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
  const [open, setOpen] = useState(false);

  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <AnimatePresence>
        {open && (
          <Primitive.Portal key="tooltip" forceMount>
            <Primitive.Content asChild forceMount side={side} sideOffset={6}>
              <m.div
                className="z-50 flex items-center gap-2 rounded-sm border border-line bg-elevated px-2 py-1 text-xs text-fg shadow-popover"
                style={{ transformOrigin: 'var(--radix-tooltip-content-transform-origin)' }}
                {...presence(pop)}
              >
                {label}
                {shortcut && <Kbd keys={shortcut} />}
              </m.div>
            </Primitive.Content>
          </Primitive.Portal>
        )}
      </AnimatePresence>
    </Primitive.Root>
  );
}
