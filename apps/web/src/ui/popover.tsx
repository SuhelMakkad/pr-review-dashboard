import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { Popover as Primitive } from 'radix-ui';
import { AnimatePresence, m } from 'motion/react';
import { cn } from '@/ui/cn';
import { surfaceClass } from '@/ui/menu';
import { pop, presence } from '@/ui/motion/presets';
import { useControllableOpen } from '@/ui/motion/use-controllable-open';

const origin = { transformOrigin: 'var(--radix-popover-content-transform-origin)' };

const Open = createContext(false);

type ContentProps = Omit<ComponentProps<typeof Primitive.Content>, 'asChild' | 'forceMount'>;

export const PopoverTrigger = Primitive.Trigger;

/** A popover, controlled or not. Its content pops from the trigger and back. */
export function Popover({
  open: openProp,
  defaultOpen,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useControllableOpen({ open: openProp, defaultOpen, onOpenChange });

  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Open.Provider value={open}>{children}</Open.Provider>
    </Primitive.Root>
  );
}

/** `className` sets the padding and width on the shared surface. */
export function PopoverContent({ className, style, children, ...props }: ContentProps) {
  const open = useContext(Open);

  return (
    <AnimatePresence>
      {open && (
        <Primitive.Portal key="popover" forceMount>
          <Primitive.Content asChild forceMount {...props}>
            <m.div
              className={cn(surfaceClass, className)}
              style={{ ...origin, ...style }}
              {...presence(pop)}
            >
              {children}
            </m.div>
          </Primitive.Content>
        </Primitive.Portal>
      )}
    </AnimatePresence>
  );
}
