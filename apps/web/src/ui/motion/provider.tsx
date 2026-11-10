import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import { defaultTransition } from '@/ui/motion/presets';

/**
 * Loads one explicit Motion feature set for the whole app. `domMax` adds layout animations, which
 * the sliding indicators need. `strict` makes a full `motion.*` component throw in development,
 * so every animated element uses the lighter `m.*` and shares this feature set.
 *
 * The features load with the app rather than in a later chunk: elements render their `initial`
 * state at once, so content that enters (`Enter`) would stay invisible until a lazy chunk arrived,
 * or for good if it failed to load.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig transition={defaultTransition}>{children}</MotionConfig>
    </LazyMotion>
  );
}
