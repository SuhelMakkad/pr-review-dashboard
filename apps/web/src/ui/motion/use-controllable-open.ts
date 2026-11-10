import { useCallback, useState } from 'react';

/**
 * Open state for an overlay that may be controlled by its caller or left to itself. Overlay
 * wrappers need the value either way: exit animations require knowing when it turns false.
 */
export function useControllableOpen({
  open,
  defaultOpen = false,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const controlled = open !== undefined;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolled(next);

      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  return [controlled ? open : uncontrolled, setOpen] as const;
}
