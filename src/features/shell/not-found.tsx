import { Link } from '@tanstack/react-router';
import { EmptyState } from '../../ui/empty-state';

export function NotFound() {
  return (
    <div className="grid h-full place-items-center">
      <EmptyState
        title="Nothing at this address"
        hint="That page does not exist in Review Desk."
        action={
          <Link
            to="/inbox/$queue"
            params={{ queue: 'attention' }}
            className="text-accent underline"
          >
            Go to your inbox
          </Link>
        }
      />
    </div>
  );
}
