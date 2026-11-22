// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBanner } from '@/features/review/command-banner';
import type { AttemptView } from '@/features/review/draft-attempts';
import type { DraftWriter } from '@/features/review/draft-writer';

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('sonner', () => ({ toast: toasts }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const write: AttemptView = {
  key: 'write-1',
  phase: 'not-saved',
  label: 'Your comment on src/a.ts:12',
  text: 'Check the bound.',
  texts: ['Check the bound.'],
  canSendAgain: true,
  canStop: false,
  canAddAsNew: false,
  route: 'comment',
  inspect: null,
  received: false,
  unrecorded: false,
  createdAt: 0,
};

/** A writer with one write that was not saved, whose `sendWriteAgain` is `send`. */
const writer = (send: () => Promise<void>) =>
  ({
    commandViews: () => [],
    writeViews: () => [write],
    startViews: () => [],
    sendWriteAgain: send,
  }) as unknown as DraftWriter;

describe('the activity banner’s buttons', () => {
  it('show a failure and are enabled again, whether the action rejects or throws at once', async () => {
    const failures = [
      () => Promise.reject(new Error('The server refused it.')),
      () => {
        throw new Error('The draft is gone.');
      },
    ];

    for (const send of failures) {
      render(<CommandBanner writer={writer(send)} />);

      const button = screen.getByRole('button', { name: 'Send again' });

      fireEvent.click(button);

      await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(button).toBeEnabled());

      cleanup();
      toasts.error.mockClear();
    }
  });
});
