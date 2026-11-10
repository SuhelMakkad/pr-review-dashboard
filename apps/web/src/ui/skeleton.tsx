import type { ReactNode } from 'react';
import { cn } from '@/ui/cn';

/**
 * Placeholders shown while content loads. Every skeleton waits a beat before it appears
 * (`skeleton-reveal`, timed by the motion tokens), so a fast load goes straight to content. The
 * shapes pulse gently; the reduced-motion rule in app.css stills them.
 */

/** One placeholder shape. Size and round it with `className`. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('animate-pulse rounded-xs bg-line/70', className)} />
  );
}

/** A loading region: announced once to assistive technology, with skeleton shapes inside. */
export function SkeletonRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" className={cn('skeleton-reveal', className)}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Placeholder text: lines of decreasing width, like a paragraph. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3', 'w-3/5'];

  return (
    <div aria-hidden="true" className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn('h-3', index === lines - 1 ? 'w-1/2' : widths[index % widths.length])}
        />
      ))}
    </div>
  );
}

/**
 * Placeholder queue rows, at the current row density. It lives inside a listbox, so it is
 * presentational; the listbox itself carries `aria-busy` while it loads.
 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="skeleton-reveal">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex min-h-[var(--row-h)] items-center gap-3 border-b border-line py-1.5 pr-4 pl-3"
        >
          <Skeleton className="size-1.5 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={cn('h-3', index % 2 ? 'w-2/3' : 'w-4/5')} />
            <Skeleton className="density-secondary h-2.5 w-2/5" />
          </div>
          <Skeleton className="h-3 w-7" />
        </div>
      ))}
    </div>
  );
}
