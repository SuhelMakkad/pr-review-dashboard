import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { animate } from 'motion/react';
import { cn } from '@/ui/cn';
import { duration, ease } from '@/ui/motion/tokens';

type Running = ReturnType<typeof animate>;

/**
 * Eases a region's height from its old size to its new one whenever `trigger` changes (a card
 * swapping states, a list expanding). Any other size change, such as text reflowing while a panel
 * is dragged, applies at once, so the region never lags behind its content.
 *
 * Do not use it around something that resizes while you type, or inside the diff virtualizer.
 */
export function SmoothHeight({
  trigger,
  className,
  children,
}: {
  trigger: unknown;
  className?: string;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const resting = useRef<number | null>(null);
  const running = useRef<Running | null>(null);

  // Remember the height at rest, without animating, so a trigger change knows where it started.
  useLayoutEffect(() => {
    const content = inner.current;

    if (!content) return;

    resting.current = content.offsetHeight;

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!running.current) resting.current = content.offsetHeight;
    });

    observer.observe(content);

    return () => observer.disconnect();
  }, []);

  // Runs after the new state is in the DOM but before the browser paints it.
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;

    if (!box || !content) return;

    const from = running.current ? box.offsetHeight : resting.current;
    const to = content.offsetHeight;

    if (from === null || from === to) return;

    running.current?.stop();
    box.style.overflow = 'hidden';

    const controls = animate(
      box,
      { height: [from, to] },
      { duration: duration.base, ease: ease.standard },
    );

    running.current = controls;

    void controls.then(() => {
      if (running.current !== controls) return;

      running.current = null;
      box.style.height = '';
      box.style.overflow = '';
      resting.current = content.offsetHeight;
    });
  }, [trigger]);

  useLayoutEffect(() => () => running.current?.stop(), []);

  return (
    <div ref={outer} className={cn('relative', className)}>
      <div ref={inner}>{children}</div>
    </div>
  );
}
