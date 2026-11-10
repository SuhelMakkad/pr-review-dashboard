import { CircleAlert } from 'lucide-react';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/empty-state';

/**
 * What a region shows when its data could not load: what failed, why, and a way to try again.
 * Announced as an alert, since it replaces content the person was waiting for.
 */
export function ErrorState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error?: Error | null;
  onRetry?: () => void;
}) {
  return (
    <div role="alert">
      <EmptyState
        icon={<CircleAlert size={28} />}
        title={title}
        hint={error?.message}
        action={
          onRetry && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    </div>
  );
}
