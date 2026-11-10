import { useId, type ReactNode } from 'react';
import { LayoutGroup, m, useIsPresent } from 'motion/react';
import { cn } from '@/ui/cn';
import { spring } from '@/ui/motion/tokens';

/** The app's selection marks. Pick by role, not by look, so every control of a kind matches. */
const variants = {
  /** Navigation entries: a tinted fill behind the whole item. */
  fill: 'inset-0 rounded-sm bg-selected',
  /** Segmented controls: a raised pill behind the chosen option. */
  pill: 'inset-0 rounded-xs bg-panel shadow-sm',
  /** Tabs: an accent underline. */
  underline: 'inset-x-0 bottom-0 h-0.5 bg-accent',
  /** List rows: a bar on the leading edge. */
  bar: 'inset-y-0 left-0 w-0.5 bg-selected-line',
} as const;

/**
 * Scopes one set of mutually exclusive items (nav links, tabs, a segmented control). Each group
 * gets its own id, so two groups on a page never trade indicators.
 */
export function IndicatorGroup({ children }: { children: ReactNode }) {
  return <LayoutGroup id={useId()}>{children}</LayoutGroup>;
}

/**
 * Marks the active item. Render it inside the active item only, which must be `relative`; when
 * another item in the same `IndicatorGroup` becomes active, the indicator glides there. Give the
 * item's content `relative z-10` so it stays above the indicator as it passes.
 */
export function ActiveIndicator({
  variant,
  className,
}: {
  variant: keyof typeof variants;
  className?: string;
}) {
  // An item that is animating out (a triaged row, a closing palette) no longer owns the selection.
  // Dropping its indicator also lets the exit finish: Motion holds an exiting shared-layout element
  // until its layout stack hands off, which would keep the leaving item mounted.
  const present = useIsPresent();

  if (!present) return null;

  return (
    <m.span
      aria-hidden="true"
      layoutId="active-indicator"
      transition={spring.indicator}
      className={cn('pointer-events-none absolute', variants[variant], className)}
    />
  );
}
