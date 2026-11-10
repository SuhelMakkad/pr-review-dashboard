import type { ComponentProps, ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { AnimatePresence, m } from 'motion/react';
import { cn } from '@/ui/cn';
import { dialog, drawer, fade, presence } from '@/ui/motion/presets';

type ContentProps = Omit<ComponentProps<typeof Dialog.Content>, 'asChild' | 'forceMount'>;

interface OverlayProps extends ContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs once the closing animation has finished; reset content here, not on close. */
  onExitComplete?: () => void;
  children: ReactNode;
}

export const DialogTitle = Dialog.Title;
export const DialogDescription = Dialog.Description;
export const DialogClose = Dialog.Close;

/**
 * A modal dialog that fades its backdrop and settles its panel into place. Radix still owns focus,
 * dismissal and ARIA; the panel stays mounted until its exit finishes. `className` positions and
 * sizes the panel.
 */
export function Modal({
  open,
  onOpenChange,
  onExitComplete,
  className,
  children,
  ...contentProps
}: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence onExitComplete={onExitComplete}>
        {open && (
          <Dialog.Portal key="modal" forceMount>
            <Dialog.Overlay asChild forceMount>
              <m.div
                className="fixed inset-0 z-40 bg-black/25 dark:bg-black/50"
                {...presence(fade)}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount {...contentProps}>
              <m.div
                className={cn(
                  'fixed left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-line bg-elevated shadow-popover',
                  className,
                )}
                {...presence(dialog)}
              >
                {children}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/**
 * A panel that slides in from the right edge. Non-modal by default, so the page beside it stays
 * usable. `className` sizes and places it. To make room for it rather than cover the page, give
 * the page `drawer-push` and `data-drawer-open` (see app.css).
 */
export function Drawer({
  open,
  onOpenChange,
  onExitComplete,
  modal = false,
  className,
  children,
  ...contentProps
}: OverlayProps & { modal?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <AnimatePresence onExitComplete={onExitComplete}>
        {open && (
          <Dialog.Portal key="drawer" forceMount>
            <Dialog.Content asChild forceMount {...contentProps}>
              <m.div
                className={cn(
                  'fixed right-0 border-l border-line bg-elevated shadow-popover',
                  className,
                )}
                {...presence(drawer)}
              >
                {children}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
