import { PullView } from '@/features/pulls/pull-view';
import { useCurrentPull } from '@/features/pulls/use-current-pull';

export function PullOverview() {
  const { item } = useCurrentPull();

  return item ? <PullView item={item} variant="page" /> : null;
}
