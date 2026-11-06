import { useMine } from '../../lib/queries';
import { sameRef } from '../../lib/pr-ref';
import { PullView } from '../pulls/pull-view';
import { useCurrentPull } from '../pulls/use-current-pull';
import { AuthorBlockers } from './author-blockers';

export function MineReader() {
  const mine = useMine();
  const { ref, item } = useCurrentPull();
  const own = ref ? mine.data?.items.find((candidate) => sameRef(candidate, ref)) : undefined;

  if (!item || !own) return null;

  return (
    <PullView
      item={item}
      variant="pane"
      lead={<AuthorBlockers item={own} account={mine.data?.account ?? ''} />}
    />
  );
}
