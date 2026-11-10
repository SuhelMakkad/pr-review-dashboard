import { useIsPresent } from 'motion/react';

const leaving = { 'aria-hidden': true, inert: true } as const;

/**
 * Props for an element animating out of an `AnimatePresence`. It stays on screen for its exit but
 * is already gone for everything else: assistive technology no longer reads it and it can no
 * longer be focused or clicked, so a leaving state never competes with the one replacing it.
 * Call it in the component that is the presence's direct child.
 */
export function useLeavingProps() {
  return useIsPresent() ? undefined : leaving;
}
