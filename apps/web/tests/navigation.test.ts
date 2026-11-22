import { describe, expect, it, vi } from 'vitest';
import { follow } from '@/lib/navigation';

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('sonner', () => ({ toast: toasts }));

describe('a navigation nothing waits for', () => {
  it('shows its failure, and leaves no rejection unhandled', async () => {
    const unhandled = vi.fn();

    process.on('unhandledRejection', unhandled);

    try {
      follow(Promise.reject(new Error('The route could not be built.')));
      follow(Promise.resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(toasts.error).toHaveBeenCalledTimes(1);
      expect(toasts.error).toHaveBeenCalledWith('Could not open that page. Try again.');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
