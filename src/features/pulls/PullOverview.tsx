import { PullView } from './PullView';
import { useCurrentPull } from './useCurrentPull';

export function PullOverview() {
  const { item } = useCurrentPull();

  return item ? <PullView item={item} variant="page" /> : null;
}
