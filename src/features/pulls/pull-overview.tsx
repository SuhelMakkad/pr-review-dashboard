import { PullView } from './pull-view';
import { useCurrentPull } from './use-current-pull';

export function PullOverview() {
  const { item } = useCurrentPull();

  return item ? <PullView item={item} variant="page" /> : null;
}
