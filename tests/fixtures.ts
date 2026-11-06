import type { PullRequestSnapshot, Review, ReviewThread } from '@review-desk/shared/types';

export const t = (hour: number) => `2026-11-05T${String(hour).padStart(2, '0')}:00:00.000Z`;

export function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    state: 'APPROVED',
    submittedAt: t(8),
    updatedAt: t(8),
    commitOid: 'head-1',
    body: 'Looks good',
    url: 'https://github.com/acme/repo/pull/1#review-1',
    ...overrides,
  };
}

export function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'thread-1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 4,
    comments: [
      {
        id: 'own',
        author: { login: 'me' },
        body: 'Please fix',
        createdAt: t(8),
        updatedAt: t(8),
        url: 'https://github.com/own',
        replyToId: null,
      },
      {
        id: 'reply',
        author: { login: 'author' },
        body: 'Fixed!',
        createdAt: t(9),
        updatedAt: t(9),
        url: 'https://github.com/reply',
        replyToId: 'own',
      },
    ],
    ...overrides,
  };
}

export function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    id: 'pr-1',
    number: 1,
    title: 'Fix the review queue',
    url: 'https://github.com/acme/repo/pull/1',
    repository: 'acme/repo',
    author: { login: 'author' },
    body: 'A useful **description**.',
    isDraft: false,
    state: 'OPEN',
    createdAt: t(6),
    updatedAt: t(9),
    headOid: 'head-1',
    headCommittedAt: t(7),
    headObservedAt: t(9),
    baseRefName: 'main',
    headRefName: 'fix/review',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    sources: ['reviewed'],
    reviewRequests: [],
    requestEvents: [],
    reviews: [review()],
    threads: [],
    files: [{ path: 'src/app.ts', additions: 10, deletions: 2 }],
    checks: [{ name: 'Unit tests', state: 'success', url: null }],
    ci: 'success',
    fetchedAt: t(10),
    version: 2,
    baseOid: 'base-1',
    mergeStateStatus: 'CLEAN',
    conversation: [],
    forcePushes: [],
    verdicts: [],
    pendingReview: null,
    ...overrides,
  };
}
