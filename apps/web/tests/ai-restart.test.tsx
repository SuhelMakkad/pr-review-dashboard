// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiReviewStatus } from '@review-desk/shared/ai';
import { AiReviewBadge } from '@/features/ai/ai-review-badge';
import { restartCopy, restartPhrase } from '@/features/ai/restart';

afterEach(cleanup);

const now = Date.parse('2026-11-16T14:00:00Z');
const review = (changes: Partial<AiReviewStatus>): AiReviewStatus => ({
  prId: 'PR_1',
  runId: 'run-1',
  status: 'cancelled',
  stale: false,
  trigger: 'auto',
  restartAt: null,
  ...changes,
});

describe('restarting an automatic review after new commits', () => {
  it('says when the fresh review starts', () => {
    const restartAt = new Date(now + 4 * 60_000).toISOString();
    const time = new Date(restartAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

    expect(restartPhrase(restartAt, now)).toBe(`around ${time}`);
    expect(restartPhrase(new Date(now - 1_000).toISOString(), now)).toBe('shortly');
    expect(restartCopy(restartAt, now)).toMatch(
      /^New commits arrived while the automatic review was running, so it stopped\. .*no new commits for 5 minutes\.$/,
    );
  });

  it('shows a stopped review as restarting in lists', () => {
    render(<AiReviewBadge review={review({ restartAt: new Date(now).toISOString() })} />);

    expect(screen.getByText('AI review restarting')).toHaveAttribute(
      'title',
      expect.stringMatching(/^New commits arrived/),
    );
  });

  it('shows a stopped review without a restart as nothing', () => {
    render(<AiReviewBadge review={review({})} />);

    expect(screen.queryByText(/^AI review/)).not.toBeInTheDocument();
  });

  it('keeps showing a review in progress as reviewing', () => {
    render(
      <AiReviewBadge
        review={review({ status: 'running', restartAt: new Date(now).toISOString() })}
      />,
    );

    expect(screen.getByText('AI reviewing')).toBeInTheDocument();
  });
});
