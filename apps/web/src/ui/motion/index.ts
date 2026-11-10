/**
 * The app's motion layer. Features describe intent with these primitives and never tune motion
 * themselves, so timing stays consistent and changes in one place.
 *
 * Rules (enforced by tests/architecture.test.ts and LazyMotion's strict mode):
 * 1. Only `src/ui/**` imports `motion/react`; features use these primitives and the overlay
 *    primitives, never Motion components directly. A new need gets a new primitive here.
 * 2. Durations, easings and springs live in `tokens.ts`; CSS uses the mirrored `--motion-*` vars.
 * 3. Animate `transform` and `opacity`; the exceptions are the heights of `Reveal`, `ListItem` and
 *    `SmoothHeight`, which only move when their content changes state.
 * 4. Panes and pages animate in only (`Enter`); never put `layout` on every row of a long list.
 * 5. Inside the diff virtualizer, animate opacity only so its row measurements stay true.
 * 6. Reduced motion means instant (see `reduced-motion.ts`).
 * 7. Wrappers never take an element's id, role, ARIA state or ref; keyboard flows never wait on
 *    an animation.
 */
export { ActiveIndicator, IndicatorGroup } from '@/ui/motion/active-indicator';
export { Enter } from '@/ui/motion/enter';
export { FadeSwap } from '@/ui/motion/fade-swap';
export { LayoutItem, LayoutScroll, ListItem, ListPresence, StaggerItem } from '@/ui/motion/list';
export { MotionProvider } from '@/ui/motion/provider';
export { initReducedMotion } from '@/ui/motion/reduced-motion';
export { Reveal } from '@/ui/motion/reveal';
export { SmoothHeight } from '@/ui/motion/smooth-height';
export { useControllableOpen } from '@/ui/motion/use-controllable-open';
export * from '@/ui/motion/presets';
export * from '@/ui/motion/tokens';
