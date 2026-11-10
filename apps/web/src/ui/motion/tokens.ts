/**
 * Motion tokens: the only place timing is defined. `app.css` mirrors these as `--motion-*` custom
 * properties (kept equal by tests/motion.test.tsx), so CSS transitions and Motion animations share
 * one rhythm. Exits are shorter than entrances: arriving content earns attention, leaving content
 * should get out of the way.
 */
export const duration = {
  fast: 0.12,
  base: 0.18,
  slow: 0.24,
} as const;

export const ease = {
  /** Decelerates into place; used for anything arriving or settling. */
  standard: [0.16, 1, 0.3, 1],
  /** Accelerates away; used for anything leaving. */
  exit: [0.4, 0, 1, 1],
} as const;

export const spring = {
  /** Critically damped, so indicators glide between items without overshooting. */
  indicator: { type: 'spring', bounce: 0, duration: 0.25 },
} as const;

/**
 * How long a load must take before its skeleton shows. Faster loads go straight to content, so a
 * quick response never flashes a placeholder.
 */
export const skeletonDelay = 0.15;

/** Per-item delay for staggered lists, and the cap that keeps long lists from trickling in. */
export const stagger = {
  step: 0.03,
  max: 0.24,
} as const;
