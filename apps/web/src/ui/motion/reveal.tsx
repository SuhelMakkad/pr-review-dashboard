import type { ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { cn } from '@/ui/cn';
import { useLeavingProps } from '@/ui/motion/leaving';
import { collapse, fade, pop, presence } from '@/ui/motion/presets';

const tags = { div: m.div, span: m.span };
const presets = { collapse, pop, fade };

interface Shape {
  preset: keyof typeof presets;
  as: keyof typeof tags;
  className?: string;
  children: ReactNode;
}

function Revealed({ preset, as, className, children }: Shape) {
  const Component = tags[as];

  return (
    <Component
      className={cn(as === 'span' && 'inline-flex', className)}
      {...presence(presets[preset])}
      {...useLeavingProps()}
    >
      {children}
    </Component>
  );
}

/**
 * Shows or hides one piece of UI. Blocks `collapse` (height and opacity); small inline pieces such
 * as badges and buttons `pop`; anything inside the diff virtualizer uses `fade`, which never
 * changes height mid-animation. Content present at first paint appears without animating. A `span`
 * is `inline-flex`, since transforms do not apply to inline boxes. Hidden content is unreachable
 * from the moment it starts to leave.
 */
export function Reveal({
  show,
  preset = 'collapse',
  as = 'div',
  className,
  children,
}: Partial<Shape> & { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <Revealed key="reveal" preset={preset} as={as} className={className}>
          {children}
        </Revealed>
      )}
    </AnimatePresence>
  );
}
