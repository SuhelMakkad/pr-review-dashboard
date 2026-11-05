import { useMine } from '../../lib/queries';
import { sameRef } from '../../lib/prRef';
import { PullView } from '../pulls/PullView';
import { useCurrentPull } from '../pulls/useCurrentPull';
import { AuthorBlockers } from './AuthorBlockers';

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
