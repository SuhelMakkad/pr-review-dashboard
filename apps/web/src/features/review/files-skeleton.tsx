import { cn } from '@/ui/cn';
import { Skeleton, SkeletonRegion } from '@/ui/skeleton';

const treeRows = ['w-24', 'w-32', 'w-28', 'w-20', 'w-36', 'w-24', 'w-28', 'w-16'];
const diffLines = ['w-2/5', 'w-3/5', 'w-1/2', 'w-4/5', 'w-1/3', 'w-2/3', 'w-3/5', 'w-1/4'];

/** The changed-files tree in outline: its header, filter box and a column of paths. */
export function FileTreeSkeleton() {
  return (
    <SkeletonRegion
      label="Loading changed files…"
      className="h-full border-r border-line bg-sunken"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-8" />
      </div>
      <Skeleton className="mx-2 mb-3 h-7 rounded-sm" />
      <div className="space-y-2.5 px-3">
        {treeRows.map((width, index) => (
          <Skeleton key={index} className={cn('h-3', width, index % 3 === 0 && 'ml-3')} />
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** A diff in outline: a file header, then code lines, a few tinted as added or removed. */
export function DiffSkeleton() {
  return (
    <SkeletonRegion label="Loading diff…" className="h-full">
      <div className="flex h-10 items-center gap-3 border-b border-line px-4">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      <div className="space-y-2 py-3">
        {[...diffLines, ...diffLines].map((width, index) => (
          <div
            key={index}
            className={cn(
              'flex items-center gap-4 px-4',
              index % 7 === 2 && 'bg-add-bg',
              index % 7 === 5 && 'bg-del-bg',
            )}
          >
            <Skeleton className="h-3 w-6" />
            <Skeleton className={cn('h-3', width)} />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
