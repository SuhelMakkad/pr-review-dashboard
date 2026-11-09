import { EmptyState } from '@/ui/empty-state';
import { PullView } from '@/features/pulls/pull-view';
import { useCurrentPull } from '@/features/pulls/use-current-pull';
import { NotTrackedActions } from '@/features/pulls/use-track';
import { formatRef } from '@/lib/pr-ref';
import { usePulls } from '@/lib/queries';

export function InboxReader() {
  const pulls = usePulls();
  const { ref, item } = useCurrentPull();

  if (item) return <PullView item={item} variant="pane" />;

  if (!pulls.data || !ref) return null;

  return (
    <div className="grid h-full place-items-center">
      <EmptyState
        title="Not tracked"
        hint={`${formatRef(ref)} is not in your review workload for this account. Add it to your queue to review it here.`}
        action={<NotTrackedActions pullRef={ref} />}
      />
    </div>
  );
}
