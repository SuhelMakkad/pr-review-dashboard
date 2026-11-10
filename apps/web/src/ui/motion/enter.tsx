import type { ReactNode } from 'react';
import { m } from 'motion/react';
import { presets, type PresetName } from '@/ui/motion/presets';

/**
 * Animates a subtree in when it mounts and never animates it out. Key it by what it shows (a page,
 * a PR) so a change replaces the old view at once and fades the new one in: old and new never
 * overlap, and keyboard navigation never waits on an exit.
 */
export function Enter({
  preset = 'rise',
  className,
  children,
}: {
  preset?: Extract<PresetName, 'fade' | 'rise' | 'pop'>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <m.div className={className} variants={presets[preset]} initial="hidden" animate="visible">
      {children}
    </m.div>
  );
}
