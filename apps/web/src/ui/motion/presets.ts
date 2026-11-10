import type { Transition, Variants } from 'motion/react';
import { duration, ease, stagger } from '@/ui/motion/tokens';

/**
 * Named variants. Every preset uses the same three labels, so any of them can be spread onto an
 * `m.*` element with `presence()` and parents can orchestrate children by label.
 */
export type Preset = Variants & { hidden: object; visible: object; exit: object };

const arrive = (seconds: number = duration.base): Transition => ({
  duration: seconds,
  ease: ease.standard,
});

const leave = (seconds: number = duration.fast): Transition => ({
  duration: seconds,
  ease: ease.exit,
});

/** Spread onto an `m.*` element: enters from `hidden`, rests at `visible`, leaves via `exit`. */
export function presence(variants: Preset) {
  return { variants, initial: 'hidden', animate: 'visible', exit: 'exit' } as const;
}

export const fade: Preset = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: arrive() },
  exit: { opacity: 0, transition: leave() },
};

/**
 * In-place swaps, where the old and new states share one spot: the old state clears quickly and
 * the new one starts half a beat later, so the two are barely on screen together.
 */
export const crossfade: Preset = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { ...arrive(), delay: duration.fast / 2 } },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.standard } },
};

/** Small surfaces anchored to a trigger: menus, popovers, tooltips, badges. */
export const pop: Preset = {
  hidden: { opacity: 0, scale: 0.97 },
  visible: { opacity: 1, scale: 1, transition: arrive(duration.fast) },
  exit: { opacity: 0, scale: 0.97, transition: leave() },
};

/** Modal dialogs: settle down into place. */
export const dialog: Preset = {
  hidden: { opacity: 0, scale: 0.98, y: -6 },
  visible: { opacity: 1, scale: 1, y: 0, transition: arrive() },
  exit: { opacity: 0, scale: 0.98, y: -4, transition: leave() },
};

/** Pages, panes and newly arrived content: a short rise. */
export const rise: Preset = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: arrive() },
  exit: { opacity: 0, y: 4, transition: leave() },
};

/**
 * Side panels on the right edge. They travel their full width on the same timing as the page's
 * `drawer-push` padding (app.css), so the panel's edge and the page's edge move as one.
 */
export const drawer: Preset = {
  hidden: { x: '100%' },
  visible: { x: 0, transition: arrive(duration.slow) },
  exit: { x: '100%', transition: leave(duration.base) },
};

/**
 * Height reveal for blocks and list items. `overflow` is clipped only while moving, so sticky
 * headers and focus rings inside behave normally at rest.
 */
export const collapse: Preset = {
  hidden: { height: 0, opacity: 0, overflow: 'hidden' },
  visible: {
    height: 'auto',
    opacity: 1,
    transition: { height: arrive(duration.slow), opacity: arrive(duration.base) },
    transitionEnd: { overflow: 'visible' },
  },
  exit: {
    height: 0,
    opacity: 0,
    overflow: 'hidden',
    transition: { height: arrive(duration.base), opacity: leave() },
  },
};

/** A list item that rises in after its predecessors; pass its index as `custom`. */
export const staggered: Preset = {
  hidden: { opacity: 0, y: 4 },
  visible: (index: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { ...arrive(), delay: Math.min(index * stagger.step, stagger.max) },
  }),
  exit: { opacity: 0, transition: leave() },
};

export const presets = { fade, crossfade, pop, dialog, rise, drawer, collapse, staggered } as const;

export type PresetName = keyof typeof presets;

/** The default for any animation that names no transition of its own. */
export const defaultTransition: Transition = arrive();
