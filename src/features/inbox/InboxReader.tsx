import { EmptyState } from '../../ui/EmptyState';
import { PullView } from '../pulls/PullView';
import { useCurrentPull } from '../pulls/useCurrentPull';
import { usePulls } from '../../lib/queries';

export function InboxReader() {
  const pulls = usePulls();
  const { ref, item } = useCurrentPull();

  if (item) return <PullView item={item} variant="pane" />;

  if (!pulls.data) return null;

  return (
    <div className="grid h-full place-items-center">
      <EmptyState
        title="Not tracked"
        hint={`${ref?.owner}/${ref?.repo}#${ref?.number} is not in your review workload for this account.`}
      />
    </div>
  );
}
