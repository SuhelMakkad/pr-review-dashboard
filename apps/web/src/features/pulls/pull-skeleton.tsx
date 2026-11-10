import { cn } from '@/ui/cn';
import { Skeleton, SkeletonRegion, SkeletonText } from '@/ui/skeleton';

/** The PR details layout in outline: header, actions, then the first sections. */
export function PullSkeleton({ variant }: { variant: 'pane' | 'page' }) {
  return (
    <SkeletonRegion
      label="Loading pull request…"
      className={cn('h-full', variant === 'page' && 'mx-auto max-w-4xl')}
    >
      <div className="space-y-2.5 px-6 pt-5 pb-4">
        <Skeleton className="h-3 w-36" />
        <Skeleton className={cn('w-3/4', variant === 'page' ? 'h-6' : 'h-5')} />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="flex gap-2 px-6 pb-4">
        <Skeleton className="h-7 w-32 rounded-sm" />
        <Skeleton className="h-7 w-20 rounded-sm" />
        <Skeleton className="h-7 w-20 rounded-sm" />
        <Skeleton className="h-7 w-16 rounded-sm" />
      </div>
      {[3, 2].map((lines, index) => (
        <div key={index} className="space-y-3 border-t border-line px-6 py-5">
          <Skeleton className="h-3 w-24" />
          <SkeletonText lines={lines} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
