import { describe, expect, it } from 'vitest';
import { deriveItem, emptyTriage, sortItems } from '@review-desk/shared/attention';
import { review, snapshot, t, thread } from './fixtures';

describe('review attention', () => {
  it('requests a first review for direct requests and assignments', () => {
    for (const source of ['requested', 'assigned'] as const) {
      const item = deriveItem(
        snapshot({ sources: [source], reviews: [] }),
        emptyTriage(),
        'me',
        [],
      );

      expect(item.queue).toBe('attention');
      expect(item.reasons[0].kind).toBe('first_review');
    }
  });

  it('tracks team requests, without repeatedly flagging a team request already reviewed', () => {
    const pr = snapshot({
      sources: ['requested'],
      reviewRequests: [{ kind: 'team', login: 'acme/reviewers', name: 'Reviewers' }],
    });
    const item = deriveItem(pr, emptyTriage(), 'me', ['acme/reviewers']);

    expect(item.queue).toBe('caught_up');
    expect(item.requestedVia).toEqual(['acme/reviewers']);
    expect(deriveItem({ ...pr, reviews: [] }, emptyTriage(), 'me', ['acme/reviewers']).queue).toBe(
      'attention',
    );
  });

  it('detects re-requests even at the same head SHA', () => {
    const pr = snapshot({
      reviewRequests: [{ kind: 'user', login: 'me', name: 'me' }],
      requestEvents: [
        {
          id: 'request-2',
          createdAt: t(9),
          removed: false,
          reviewer: { kind: 'user', login: 'me', name: 'me' },
        },
      ],
    });
    const item = deriveItem(pr, emptyTriage(), 'me', []);

    expect(item.reasons.map((reason) => reason.kind)).toEqual(['requested_again']);
  });

  it('ignores requests removed before the next sync', () => {
    const pr = snapshot({
      requestEvents: [
        {
          id: 'request-2',
          createdAt: t(9),
          removed: false,
          reviewer: { kind: 'user', login: 'me', name: 'me' },
        },
      ],
    });

    expect(deriveItem(pr, emptyTriage(), 'me', []).reasons).toEqual([]);
  });

  it('uses SHA identity, including force pushes whose timestamps predate the review', () => {
    const pr = snapshot({ headOid: 'rebased-head', headCommittedAt: t(5) });
    const item = deriveItem(pr, emptyTriage(), 'me', []);

    expect(item.reasons[0].kind).toBe('changed');
    expect(
      deriveItem(
        { ...pr, reviews: [review({ commitOid: 'rebased-head' })] },
        emptyTriage(),
        'me',
        [],
      ).queue,
    ).toBe('caught_up');
  });

  it('does not treat a generic PR update or CI change as a new code review', () => {
    expect(
      deriveItem(snapshot({ updatedAt: t(10), ci: 'failure' }), emptyTriage(), 'me', []).reasons,
    ).toEqual([]);
  });

  it('keeps dismissed reviews visible and uses their commit as the review baseline', () => {
    const item = deriveItem(
      snapshot({ reviews: [review({ state: 'DISMISSED' })] }),
      emptyTriage(),
      'me',
      [],
    );

    expect(item.queue).toBe('attention');
    expect(item.reasons.map((reason) => reason.kind)).toEqual(['dismissed']);
    expect(item.latestReview?.state).toBe('DISMISSED');
  });

  it('waits for the author after changes are requested, until code changes', () => {
    const pr = snapshot({ reviews: [review({ state: 'CHANGES_REQUESTED' })] });

    expect(deriveItem(pr, emptyTriage(), 'me', []).queue).toBe('waiting');
    expect(deriveItem({ ...pr, headOid: 'new-head' }, emptyTriage(), 'me', []).queue).toBe(
      'attention',
    );
  });

  it('does not let a comment-only review clear an earlier request for changes', () => {
    const pr = snapshot({
      reviews: [
        review({ state: 'CHANGES_REQUESTED' }),
        review({ id: 'comment-review', state: 'COMMENTED', submittedAt: t(9) }),
      ],
    });

    expect(deriveItem(pr, emptyTriage(), 'me', []).queue).toBe('waiting');
  });

  it('reconstructs replies on resolved threads on first launch', () => {
    const item = deriveItem(
      snapshot({ threads: [thread({ isResolved: true })] }),
      emptyTriage(),
      'ME',
      [],
    );

    expect(item.reasons[0].kind).toBe('reply');
    expect(item.unresolvedThreads).toBe(0);
  });

  it('does not flag unrelated threads or the viewer’s own comments', () => {
    const other = thread({
      comments: thread().comments.filter((comment) => comment.author.login !== 'me'),
    });
    const ownOnly = thread({
      comments: thread().comments.filter((comment) => comment.author.login === 'me'),
    });

    expect(
      deriveItem(snapshot({ threads: [other, ownOnly] }), emptyTriage(), 'me', []).reasons,
    ).toEqual([]);
  });

  it('acknowledges only displayed reply versions, without clearing code or review requests', () => {
    const pr = snapshot({ headOid: 'new-head', threads: [thread()] });
    const item = deriveItem(pr, emptyTriage(), 'me', []);
    const triage = { ...emptyTriage(), seenReplyKeys: item.unreadReplyKeys };

    expect(deriveItem(pr, triage, 'me', []).reasons.map((reason) => reason.kind)).toEqual([
      'changed',
    ]);

    pr.threads[0].comments[1].updatedAt = t(10);

    expect(deriveItem(pr, triage, 'me', []).reasons.map((reason) => reason.kind)).toEqual([
      'changed',
      'reply',
    ]);
  });

  it('clears a reply after the viewer responds in its thread', () => {
    const conversation = thread();

    conversation.comments.push({
      ...conversation.comments[0],
      id: 'own-2',
      createdAt: t(10),
      updatedAt: t(10),
    });

    expect(
      deriveItem(snapshot({ threads: [conversation] }), emptyTriage(), 'me', []).reasons,
    ).toEqual([]);
  });

  it('snoozes existing activity, expires on time, and wakes on new activity', () => {
    const pr = snapshot({ headOid: 'new-head' });
    const current = deriveItem(pr, emptyTriage(), 'me', []);
    const triage = {
      ...emptyTriage(),
      snoozedUntil: t(12),
      snoozedActivityKeys: current.activityKeys,
    };

    expect(deriveItem(pr, triage, 'me', [], Date.parse(t(11))).queue).toBe('snoozed');
    expect(deriveItem(pr, triage, 'me', [], Date.parse(t(13))).queue).toBe('attention');
    expect(
      deriveItem({ ...pr, headOid: 'another-head' }, triage, 'me', [], Date.parse(t(11))).queue,
    ).toBe('attention');
  });

  it('keeps drafts out of the attention queue', () => {
    expect(
      deriveItem(
        snapshot({ isDraft: true, reviews: [], sources: ['requested'] }),
        emptyTriage(),
        'me',
        [],
      ).queue,
    ).not.toBe('attention');
  });

  it('puts follow-ups before first reviews, with oldest activity first', () => {
    const first = deriveItem(
      snapshot({ id: 'first', reviews: [], sources: ['assigned'] }),
      emptyTriage(),
      'me',
      [],
    );
    const older = deriveItem(
      snapshot({ id: 'older', headOid: 'new', headObservedAt: t(9) }),
      emptyTriage(),
      'me',
      [],
    );
    const newer = deriveItem(
      snapshot({ id: 'newer', headOid: 'new', headObservedAt: t(10) }),
      emptyTriage(),
      'me',
      [],
    );

    expect(sortItems([first, newer, older]).map((item) => item.id)).toEqual([
      'older',
      'newer',
      'first',
    ]);
  });
});

describe('done until new activity', () => {
  const marked = (keys: string[]) => ({
    ...emptyTriage(),
    doneAt: '2026-11-05T09:30:00.000Z',
    doneActivityKeys: keys,
  });

  it('moves a PR out of the attention queue while its activity is unchanged', () => {
    const pr = snapshot({ headOid: 'head-2' });
    const before = deriveItem(pr, emptyTriage(), 'me', []);
    const done = deriveItem(pr, marked(before.activityKeys), 'me', []);

    expect(before.queue).toBe('attention');
    expect(done.queue).toBe('caught_up');
    expect(done.doneAt).toBe('2026-11-05T09:30:00.000Z');
  });

  it('returns the PR to attention when a new activity key appears', () => {
    const pr = snapshot({ headOid: 'head-2' });
    const keys = deriveItem(pr, emptyTriage(), 'me', []).activityKeys;
    const pushedAgain = deriveItem(snapshot({ headOid: 'head-3' }), marked(keys), 'me', []);

    expect(pushedAgain.queue).toBe('attention');
    expect(pushedAgain.doneAt).toBeNull();
  });

  it('lets an active snooze take precedence over done', () => {
    const pr = snapshot({ headOid: 'head-2' });
    const keys = deriveItem(pr, emptyTriage(), 'me', []).activityKeys;
    const triage = {
      ...marked(keys),
      snoozedUntil: '2026-11-06T09:00:00.000Z',
      snoozedActivityKeys: keys,
    };
    const item = deriveItem(pr, triage, 'me', [], Date.parse('2026-11-05T10:00:00Z'));

    expect(item.queue).toBe('snoozed');
    expect(item.doneAt).toBeNull();
  });
});

describe('mentions', () => {
  const mention = (
    overrides: Partial<{ id: string; body: string; at: string; login: string }> = {},
  ) => ({
    id: overrides.id ?? 'c1',
    author: { login: overrides.login ?? 'ana' },
    body: overrides.body ?? 'Thoughts, @me?',
    createdAt: overrides.at ?? t(9),
    updatedAt: overrides.at ?? t(9),
    url: 'https://github.com/c1',
  });

  it('surfaces a conversation mention newer than your last activity', () => {
    const item = deriveItem(
      snapshot({ conversation: [mention()], reviews: [review({ submittedAt: t(8) })] }),
      emptyTriage(),
      'me',
      [],
    );

    expect(item.reasons.map((reason) => reason.kind)).toEqual(['mention']);
    expect(item.unreadReplyKeys).toEqual([`mention:c1:${t(9)}`]);
    expect(item.queue).toBe('attention');
  });

  it('ignores mentions you already responded to, your own text, and look-alike handles', () => {
    const answered = snapshot({
      conversation: [
        mention({ at: t(8) }),
        mention({ id: 'mine', login: 'me', at: t(9), body: 'Done' }),
      ],
    });
    const ownText = snapshot({ conversation: [mention({ login: 'me' })] });
    const lookAlike = snapshot({ conversation: [mention({ body: 'cc @mega and mail@me.com' })] });

    for (const pr of [answered, ownText, lookAlike]) {
      expect(deriveItem(pr, emptyTriage(), 'me', []).reasons).toEqual([]);
    }
  });

  it('acknowledges a mention through the seen keys', () => {
    const triage = { ...emptyTriage(), seenReplyKeys: [`mention:c1:${t(9)}`] };

    expect(deriveItem(snapshot({ conversation: [mention()] }), triage, 'me', []).reasons).toEqual(
      [],
    );
  });
});
