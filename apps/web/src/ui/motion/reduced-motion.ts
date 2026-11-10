import { MotionGlobalConfig } from 'motion/react';

const query = '(prefers-reduced-motion: reduce)';

/**
 * Makes every Motion animation instant while the OS asks for reduced motion, matching the CSS rule
 * in app.css. Motion's own `reducedMotion="user"` still runs opacity fades; instant keeps the app
 * calm for those users and keeps screenshots and contrast checks deterministic.
 *
 * Call it before the first render so no animation starts first. Returns a cleanup function.
 */
export function initReducedMotion(): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;

  const media = matchMedia(query);
  const apply = () => {
    MotionGlobalConfig.skipAnimations = media.matches;
  };

  apply();
  media.addEventListener('change', apply);

  return () => media.removeEventListener('change', apply);
}
