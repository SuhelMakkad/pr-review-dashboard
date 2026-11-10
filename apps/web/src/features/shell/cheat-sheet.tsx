import { X } from 'lucide-react';
import { useRegisteredShortcuts, type ShortcutGroup } from '@/lib/shortcuts';
import { IconButton } from '@/ui/button';
import { DialogClose, DialogTitle, Modal } from '@/ui/dialog';
import { Kbd } from '@/ui/kbd';

const order: ShortcutGroup[] = ['General', 'Navigate', 'Queue', 'Pull request', 'Appearance'];

/** Lists every shortcut active on the current screen, straight from the registry. */
export function CheatSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shortcuts = useRegisteredShortcuts();
  const seen = new Set<string>();
  const unique = shortcuts.filter((shortcut) => {
    const key = `${shortcut.group}|${shortcut.keys}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      className="top-1/2 max-h-[80vh] w-[720px] -translate-y-1/2 overflow-y-auto p-5"
      aria-describedby={undefined}
    >
      <div className="mb-4 flex items-center justify-between">
        <DialogTitle className="text-base font-semibold">Keyboard shortcuts</DialogTitle>
        <DialogClose asChild>
          <IconButton label="Close" icon={<X size={15} />} size="sm" />
        </DialogClose>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {order.map((group) => {
          const entries = unique.filter((shortcut) => shortcut.group === group);

          if (entries.length === 0) return null;

          return (
            <section key={group}>
              <h3 className="mb-2 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
                {group}
              </h3>
              <ul className="space-y-1.5">
                {entries.map((shortcut) => (
                  <li
                    key={shortcut.keys}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="text-fg-muted">{shortcut.label}</span>
                    <Kbd keys={shortcut.keys} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="mt-5 text-xs text-fg-subtle">
        Shortcuts shown here change with the screen you are on. Everything is also reachable from
        the command palette.
      </p>
    </Modal>
  );
}
