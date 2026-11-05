import { useNavigate, useRouter } from '@tanstack/react-router';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { usePulls } from '../../lib/queries';
import { useShortcuts } from '../../lib/shortcuts';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { PullView } from './PullView';
import { useCurrentPull } from './useCurrentPull';

/** Full-width PR page. Becomes the review workspace (diff, threads, assist) in a later milestone. */
export function PullPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const pulls = usePulls();
  const { ref, item } = useCurrentPull();

  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: '/inbox/$queue', params: { queue: 'attention' } });
  };

  useShortcuts([{ keys: 'Escape', label: 'Back', group: 'Navigate', run: back }]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconButton label="Back" icon={<ArrowLeft size={16} />} onClick={back} />
        <span className="truncate text-sm text-fg-muted">
          {ref ? `${ref.owner}/${ref.repo}` : ''}
          <span className="text-fg-subtle"> #{ref?.number}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {item ? (
          <PullView item={item} variant="page" />
        ) : pulls.data ? (
          <div className="grid h-full place-items-center">
            <EmptyState
              title="This PR isn't in your review workload"
              hint="Review Desk tracks PRs requesting your review, assigned to you, or reviewed by you."
              action={
                ref && (
                  <a
                    className="inline-flex items-center gap-1 text-sm text-accent underline"
                    href={`https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open on GitHub <ArrowUpRight size={13} />
                  </a>
                )
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
