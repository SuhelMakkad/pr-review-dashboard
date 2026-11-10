import type { ReactNode, Ref } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { useLeavingProps } from '@/ui/motion/leaving';
import { crossfade, fade, presence, type Preset } from '@/ui/motion/presets';
import { SmoothHeight } from '@/ui/motion/smooth-height';

/** One state of a `FadeSwap`; hidden from assistive technology as soon as it starts to leave. */
function SwapState({
  ref,
  preset,
  className,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  preset: Preset;
  className?: string;
  children: ReactNode;
}) {
  return (
    <m.div ref={ref} className={className} {...presence(preset)} {...useLeavingProps()}>
      {children}
    </m.div>
  );
}

/**
 * Crossfades between states of one region. `swapKey` names the state being shown; `className`
 * styles each state's wrapper.
 *
 * - `wait` (default): the old state fades out before the new one fades in, so the two never stack.
 *   For status changes (loading → result) in a region whose size does not matter.
 * - `popLayout`: the new state mounts at once and the old one fades out of the flow above it. Use
 *   it whenever the new state takes focus (an editor opening), so keystrokes never wait on an exit.
 *   Give the parent `relative` so the leaving state stays in place.
 * - `smoothHeight`: as `popLayout`, while the region eases from the old state's height to the new
 *   one's instead of jumping. For cards and panels that change shape (a placeholder becoming a
 *   result). Not inside the diff virtualizer.
 *
 * Either way only the arriving state is reachable by keyboard and assistive technology.
 */
export function FadeSwap({
  swapKey,
  mode = 'wait',
  smoothHeight = false,
  className,
  children,
}: {
  swapKey: string;
  mode?: 'wait' | 'popLayout';
  smoothHeight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const inPlace = smoothHeight || mode === 'popLayout';
  const swap = (
    // States sharing one spot crossfade tightly; sequential ones simply fade out, then in.
    <AnimatePresence mode={inPlace ? 'popLayout' : 'wait'} initial={false}>
      <SwapState key={swapKey} preset={inPlace ? crossfade : fade} className={className}>
        {children}
      </SwapState>
    </AnimatePresence>
  );

  return smoothHeight ? <SmoothHeight trigger={swapKey}>{swap}</SmoothHeight> : swap;
}
