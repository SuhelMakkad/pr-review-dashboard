import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { useRegisteredShortcuts, type ShortcutGroup } from '@/lib/shortcuts';
import { IconButton } from '@/ui/button';
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 dark:bg-black/50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-[720px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-elevated p-5 shadow-popover"
          aria-describedby={undefined}
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close" icon={<X size={15} />} size="sm" />
            </Dialog.Close>
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
            Shortcuts shown here change with the screen you are on. Everything is also reachable
            from the command palette.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
