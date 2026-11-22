import { toast } from 'sonner';

/**
 * Starts a navigation nothing waits for: a search change, a shortcut or a palette action. Its
 * failure (one that rejects before the route's own error view can show it) is shown, never left
 * unhandled.
 */
export function follow(navigation: Promise<unknown>): void {
  navigation.catch(() => {
    toast.error('Could not open that page. Try again.');
  });
}
