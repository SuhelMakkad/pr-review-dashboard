import { describe, expect, it } from 'vitest';
import { deriveAuthorItem, sortAuthorItems } from '../shared/author';
import { extractActivity } from '../server/insights/extract';
import { review, snapshot, t, thread } from './fixtures';

const mine = (overrides: Parameters<typeof snapshot>[0] = {}) =>
  snapshot({ author: { login: 'me' }, reviews: [], mergeStateStatus: 'BLOCKED', ...overrides });

describe('author view', () => {
  it('asks you to request reviewers when nobody is reviewing', () => {
    const item = deriveAuthorItem(mine(), 'me');

    expect(item.group).toBe('needs_you');
    expect(item.blockers.map((blocker) => blocker.kind)).toEqual(['no_reviewers']);
  });

  it('waits on requested reviewers and reports since when', () => {
    const reviewer = { kind: 'user' as const, login: 'ana', name: 'ana' };
    const item = deriveAuthorItem(
      mine({
        reviewRequests: [reviewer],
        requestEvents: [{ id: 'r', createdAt: t(7), removed: false, reviewer }],
      }),
      'me',
    );

    expect(item.group).toBe('waiting');
    expect(item.blockers[0]).toMatchObject({
      kind: 'awaiting_review',
      actor: 'reviewers',
      since: t(7),
    });
    expect(item.waitingSince).toBe(t(7));
  });

  it('puts failing checks, conflicts and requested changes on you', () => {
    const item = deriveAuthorItem(
      mine({
        ci: 'failure',
        mergeable: 'CONFLICTING',
        verdicts: [{ login: 'ana', state: 'CHANGES_REQUESTED', submittedAt: t(8), commitOid: 'x' }],
      }),
      'me',
    );

    expect(item.group).toBe('needs_you');
    expect(item.blockers.map((blocker) => blocker.kind)).toEqual([
      'ci_failing',
      'conflicts',
      'changes_requested',
    ]);
    expect(item.changesRequestedBy).toEqual(['ana']);
  });

  it('treats a re-requested reviewer as the one to act, not you', () => {
    const ana = { kind: 'user' as const, login: 'ana', name: 'ana' };
    const item = deriveAuthorItem(
      mine({
        reviewRequests: [ana],
        verdicts: [{ login: 'ana', state: 'CHANGES_REQUESTED', submittedAt: t(8), commitOid: 'x' }],
      }),
      'me',
    );

    expect(item.changesRequestedBy).toEqual([]);
    expect(item.group).toBe('waiting');
  });

  it('flags threads whose last word is someone else’s', () => {
    const waiting = thread({
      comments: [
        { ...thread().comments[0], author: { login: 'ana' } },
        { ...thread().comments[1], author: { login: 'me' } },
      ],
    });
    const unanswered = thread({
      id: 'thread-2',
      comments: [{ ...thread().comments[0], author: { login: 'ana' } }],
    });
    const item = deriveAuthorItem(
      mine({
        threads: [waiting, unanswered],
        verdicts: [{ login: 'ana', state: 'COMMENTED', submittedAt: t(8), commitOid: 'x' }],
      }),
      'me',
    );

    // A comment-only review leaves nobody requested, so the nudge applies too.
    expect(item.blockers.map((blocker) => blocker.kind)).toEqual([
      'unanswered_threads',
      'no_reviewers',
    ]);
    expect(item.unresolvedThreads).toBe(2);
  });

  it('is ready to merge when approved and clean', () => {
    const item = deriveAuthorItem(
      mine({
        mergeStateStatus: 'CLEAN',
        verdicts: [{ login: 'ana', state: 'APPROVED', submittedAt: t(8), commitOid: 'x' }],
      }),
      'me',
    );

    expect(item.group).toBe('ready');
    expect(item.approvals).toEqual(['ana']);
  });

  it('explains branch protection when nothing else blocks the merge', () => {
    const item = deriveAuthorItem(
      mine({
        verdicts: [{ login: 'ana', state: 'APPROVED', submittedAt: t(8), commitOid: 'x' }],
        reviewDecision: 'REVIEW_REQUIRED',
      }),
      'me',
    );

    expect(item.blockers).toEqual([
      expect.objectContaining({ kind: 'blocked', actor: 'reviewers' }),
    ]);
    expect(item.group).toBe('waiting');
  });

  it('sorts needs-you, waiting, ready, then drafts', () => {
    const items = [
      deriveAuthorItem(mine({ id: 'draft', isDraft: true }), 'me'),
      deriveAuthorItem(
        mine({
          id: 'ready',
          mergeStateStatus: 'CLEAN',
          verdicts: [{ login: 'a', state: 'APPROVED', submittedAt: t(8), commitOid: 'x' }],
        }),
        'me',
      ),
      deriveAuthorItem(mine({ id: 'you', ci: 'failure' }), 'me'),
    ];

    expect(sortAuthorItems(items).map((item) => item.id)).toEqual(['you', 'ready', 'draft']);
  });
});

describe('activity extraction', () => {
  it('captures requests, your reviews and comments with stable keys', () => {
    const pr = snapshot({
      requestEvents: [
        {
          id: 'e1',
          createdAt: t(7),
          removed: false,
          reviewer: { kind: 'team', login: 'acme/core', name: 'Core' },
        },
        {
          id: 'e2',
          createdAt: t(7),
          removed: false,
          reviewer: { kind: 'user', login: 'someone', name: 'someone' },
        },
      ],
      reviews: [review({ id: 'rv' })],
      threads: [thread()],
    });
    const events = extractActivity(pr, 'me', ['acme/core']);

    expect(events.map((event) => `${event.kind}:${event.key}`)).toEqual([
      'request_received:request:e1',
      'review_submitted:review:rv',
      'comment_posted:comment:own',
    ]);
    expect(extractActivity(pr, 'me', ['acme/core'])).toEqual(events);
  });

  it('records merges and reviews received on your own PRs', () => {
    const pr = snapshot({
      author: { login: 'me' },
      reviews: [],
      state: 'MERGED',
      verdicts: [{ login: 'ana', state: 'APPROVED', submittedAt: t(9), commitOid: 'x' }],
    });

    expect(extractActivity(pr, 'me', []).map((event) => event.kind)).toEqual([
      'authored_opened',
      'authored_review_received',
      'pr_merged',
    ]);
  });
});

describe('author view nudges', () => {
  it('suggests re-requesting people who commented without approving', () => {
    const pr = snapshot({
      author: { login: 'me' },
      reviews: [],
      conversation: [
        {
          id: 'c',
          author: { login: 'alex' },
          body: 'Looks close',
          createdAt: t(8),
          updatedAt: t(8),
          url: 'u',
        },
        {
          id: 'b',
          author: { login: 'ci-helper[bot]' },
          body: 'Coverage 91%',
          createdAt: t(8),
          updatedAt: t(8),
          url: 'u',
        },
      ],
    });
    const item = deriveAuthorItem(pr, 'me');

    expect(item.blockers[0]).toMatchObject({ kind: 'no_reviewers', people: ['alex'] });
    expect(item.blockers[0].label).toMatch(/ask alex again/);
  });
});
