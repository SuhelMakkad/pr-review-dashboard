import type React from 'react';
import { cn } from './cn';

function hue(login: string): number {
  let hash = 0;

  for (const character of login) hash = (hash * 31 + character.charCodeAt(0)) % 360;

  return hash;
}

/** Initials avatar with a stable per-person hue. Never loads remote images. */
export function Avatar({
  login,
  size = 20,
  className,
}: {
  login: string;
  size?: number;
  className?: string;
}) {
  const tone = hue(login.toLowerCase());

  return (
    <span
      aria-hidden="true"
      className={cn(
        'avatar inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        className,
      )}
      style={
        {
          width: size,
          height: size,
          fontSize: Math.max(9, Math.round(size * 0.42)),
          '--hue': tone,
        } as React.CSSProperties
      }
    >
      {login.slice(0, size >= 24 ? 2 : 1).toUpperCase()}
    </span>
  );
}
