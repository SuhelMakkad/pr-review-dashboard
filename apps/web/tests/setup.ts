import { MotionGlobalConfig } from 'motion/react';

// Animations finish on the next frame, so removals are awaited (waitFor, findBy) but never timed.
MotionGlobalConfig.skipAnimations = true;

// jsdom has no matchMedia. Every query reports "no match", with both listener APIs present.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
