import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { AnimatePresence, m } from 'motion/react';
import { cn } from '@/ui/cn';
import { pop, presence } from '@/ui/motion/presets';
import { useControllableOpen } from '@/ui/motion/use-controllable-open';

/** The floating surface shared by menus and popovers. */
export const surfaceClass =
  'z-50 rounded-md border border-line bg-elevated text-sm text-fg shadow-popover';
export const menuItemClass =
  'flex h-8 cursor-default items-center gap-2 rounded-sm px-2 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-selected';
export const menuLabelClass =
  'px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase';

/** Grows from the trigger, wherever Radix placed the menu. */
const origin = { transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)' };

const RootOpen = createContext(false);
const SubOpen = createContext(false);

interface OpenProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

type ContentProps = Omit<ComponentProps<typeof DropdownMenu.Content>, 'asChild' | 'forceMount'>;
type SubContentProps = Omit<
  ComponentProps<typeof DropdownMenu.SubContent>,
  'asChild' | 'forceMount'
>;

export const MenuTrigger = DropdownMenu.Trigger;
export const MenuItem = DropdownMenu.Item;
export const MenuLabel = DropdownMenu.Label;
export const MenuRadioGroup = DropdownMenu.RadioGroup;
export const MenuRadioItem = DropdownMenu.RadioItem;
export const MenuItemIndicator = DropdownMenu.ItemIndicator;
export const MenuSubTrigger = DropdownMenu.SubTrigger;

/** A dropdown menu, controlled or not. Its content pops from the trigger and back. */
export function Menu({
  open: openProp,
  defaultOpen,
  onOpenChange,
  modal,
  children,
}: OpenProps & { modal?: boolean }) {
  const [open, setOpen] = useControllableOpen({ open: openProp, defaultOpen, onOpenChange });

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={modal}>
      <RootOpen.Provider value={open}>{children}</RootOpen.Provider>
    </DropdownMenu.Root>
  );
}

export function MenuContent({ className, style, children, ...props }: ContentProps) {
  const open = useContext(RootOpen);

  return (
    <AnimatePresence>
      {open && (
        <DropdownMenu.Portal key="menu" forceMount>
          <DropdownMenu.Content asChild forceMount {...props}>
            <m.div
              className={cn(surfaceClass, 'p-1', className)}
              style={{ ...origin, ...style }}
              {...presence(pop)}
            >
              {children}
            </m.div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      )}
    </AnimatePresence>
  );
}

export function MenuSub({ open: openProp, defaultOpen, onOpenChange, children }: OpenProps) {
  const [open, setOpen] = useControllableOpen({ open: openProp, defaultOpen, onOpenChange });

  return (
    <DropdownMenu.Sub open={open} onOpenChange={setOpen}>
      <SubOpen.Provider value={open}>{children}</SubOpen.Provider>
    </DropdownMenu.Sub>
  );
}

export function MenuSubContent({ className, style, children, ...props }: SubContentProps) {
  const open = useContext(SubOpen);

  return (
    <AnimatePresence>
      {open && (
        <DropdownMenu.Portal key="submenu" forceMount>
          <DropdownMenu.SubContent asChild forceMount {...props}>
            <m.div
              className={cn(surfaceClass, 'p-1', className)}
              style={{ ...origin, ...style }}
              {...presence(pop)}
            >
              {children}
            </m.div>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      )}
    </AnimatePresence>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}
