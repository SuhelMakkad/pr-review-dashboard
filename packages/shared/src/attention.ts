import { extractTickets } from '@/tickets.js';
import type {
  AttentionReason,
  LocalTriageState,
  PullRequestItem,
  PullRequestSnapshot,
  Review,
  Source,
} from '@/types.js';

export const emptyTriage = (): LocalTriageState => ({
  note: '',
  seenReplyKeys: [],
  snoozedUntil: null,
  snoozedActivityKeys: [],
  doneAt: null,
  doneActivityKeys: [],
});

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Matches "@login" as a whole handle (not inside emails or longer handles). */
export function mentionPattern(login: string): RegExp {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(^|[^\\w@./-])@${escaped}(?![\\w-])`, 'i');
}
const later = (left: string, right: string) => Date.parse(left) > Date.parse(right);

/**
 * True when the only reason to review this PR is that you added it yourself: no request, team
 * request or assignment. Used to skip the "asked for your review" notification.
 */
export function addedByHand(item: { sources: Source[]; requestedVia: string[] }): boolean {
  return (
    item.sources.includes('manual') &&
    item.requestedVia.length === 0 &&
    !item.sources.includes('requested') &&
    !item.sources.includes('assigned')
  );
}

export function deriveItem(
  pr: PullRequestSnapshot,
  triage: LocalTriageState,
  login: string,
  teams: string[],
  now = Date.now(),
): PullRequestItem {
  const reviews = [...pr.reviews].sort(
    (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt),
  );
  const latestReview: Review | null = reviews[0] ?? null;
  const effectiveReview = reviews.find((review) =>
    ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state),
  );
  const isTarget = (reviewer: { kind: string; login: string }) =>
    reviewer.kind === 'user'
      ? sameLogin(reviewer.login, login)
      : teams.some((team) => sameLogin(team, reviewer.login));

  const activeRequests = pr.reviewRequests.filter(isTarget);
  const reasons: AttentionReason[] = [];
  const seen = new Set(triage.seenReplyKeys);
  const unreadReplyKeys: string[] = [];

  if (
    !latestReview &&
    (activeRequests.length > 0 ||
      pr.sources.includes('requested') ||
      pr.sources.includes('assigned') ||
      pr.sources.includes('manual'))
  ) {
    const request = pr.requestEvents
      .filter((event) => !event.removed && event.reviewer && isTarget(event.reviewer))
      .at(-1);

    reasons.push({
      kind: 'first_review',
      label: 'First review',
      at: request?.createdAt ?? pr.createdAt,
      key: `first:${request?.id ?? pr.id}`,
    });
  }

  if (latestReview) {
    if (latestReview.commitOid && latestReview.commitOid !== pr.headOid) {
      reasons.push({
        kind: 'changed',
        label: 'Changed since review',
        at: pr.headObservedAt,
        key: `head:${pr.headOid}`,
      });
    }

    const freshRequests = pr.requestEvents.filter(
      (event) =>
        !event.removed &&
        event.reviewer &&
        isTarget(event.reviewer) &&
        later(event.createdAt, latestReview.submittedAt),
    );
    const newestRequest = freshRequests.at(-1);
    const activeDirectRequest = activeRequests.some((request) => request.kind === 'user');

    if ((newestRequest && activeRequests.length > 0) || activeDirectRequest) {
      reasons.push({
        kind: 'requested_again',
        label: 'Review requested again',
        at: newestRequest?.createdAt ?? pr.updatedAt,
        key: `request:${newestRequest?.id ?? latestReview.id}`,
      });
    }

    if (latestReview.state === 'DISMISSED') {
      reasons.push({
        kind: 'dismissed',
        label: 'Review dismissed',
        at: latestReview.updatedAt,
        key: `dismissed:${latestReview.id}`,
      });
    }
  }

  for (const thread of pr.threads) {
    const ownComments = thread.comments.filter((comment) => sameLogin(comment.author.login, login));

    if (ownComments.length === 0) continue;

    const lastOwn = ownComments.reduce(
      (last, comment) => (later(comment.createdAt, last) ? comment.createdAt : last),
      ownComments[0].createdAt,
    );
    const cutoff =
      latestReview && later(latestReview.submittedAt, lastOwn) ? latestReview.submittedAt : lastOwn;

    for (const comment of thread.comments) {
      if (sameLogin(comment.author.login, login) || !later(comment.updatedAt, cutoff)) continue;

      const key = `${comment.id}:${comment.updatedAt}`;

      if (!seen.has(key)) {
        unreadReplyKeys.push(key);
        reasons.push({
          kind: 'reply',
          label: 'New reply',
          at: comment.updatedAt,
          key,
          url: comment.url,
        });
      }
    }
  }

  // Mentions in the conversation, or in review threads the viewer has not joined.
  const mentioned = mentionPattern(login);
  const joinedThreads = new Set(
    pr.threads
      .filter((thread) => thread.comments.some((comment) => sameLogin(comment.author.login, login)))
      .map((thread) => thread.id),
  );
  const ownActivity = [
    ...(latestReview ? [latestReview.submittedAt] : []),
    ...pr.conversation
      .filter((comment) => sameLogin(comment.author.login, login))
      .map((comment) => comment.createdAt),
  ].sort();
  const lastOwnActivity = ownActivity.at(-1) ?? null;
  const mentionCandidates = [
    ...pr.conversation,
    ...pr.threads
      .filter((thread) => !joinedThreads.has(thread.id))
      .flatMap((thread) => thread.comments),
  ];

  for (const comment of mentionCandidates) {
    if (sameLogin(comment.author.login, login) || !mentioned.test(comment.body)) continue;
    if (lastOwnActivity && !later(comment.updatedAt, lastOwnActivity)) continue;

    const key = `mention:${comment.id}:${comment.updatedAt}`;

    if (seen.has(key)) continue;

    unreadReplyKeys.push(key);
    reasons.push({
      kind: 'mention',
      label: 'Mentioned',
      at: comment.updatedAt,
      key,
      url: comment.url,
    });
  }

  const activityKeys = reasons.map((reason) => reason.key);
  const hasNewActivity = activityKeys.some((key) => !triage.snoozedActivityKeys.includes(key));
  const isSnoozed = Boolean(
    triage.snoozedUntil && Date.parse(triage.snoozedUntil) > now && !hasNewActivity,
  );
  const isDone =
    !isSnoozed &&
    Boolean(triage.doneAt) &&
    activityKeys.every((key) => triage.doneActivityKeys.includes(key));
  const queue = isSnoozed
    ? 'snoozed'
    : isDone
      ? 'caught_up'
      : !pr.isDraft && reasons.length > 0
        ? 'attention'
        : effectiveReview?.state === 'CHANGES_REQUESTED'
          ? 'waiting'
          : 'caught_up';

  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repository: pr.repository,
    author: pr.author,
    isDraft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    updatedAt: pr.updatedAt,
    fetchedAt: pr.fetchedAt,
    ci: pr.ci,
    sources: pr.sources,
    requestedVia: activeRequests.map((request) =>
      request.kind === 'team' ? request.login : 'Direct request',
    ),
    latestReview,
    unresolvedThreads: pr.threads.filter((thread) => !thread.isResolved).length,
    reasons,
    queue,
    attentionAt: reasons.map((reason) => reason.at).sort()[0] ?? pr.updatedAt,
    activityKeys,
    unreadReplyKeys,
    hasNote: triage.note.trim().length > 0,
    snoozedUntil: isSnoozed ? triage.snoozedUntil : null,
    doneAt: isDone ? triage.doneAt : null,
    createdAt: pr.createdAt,
    headRefName: pr.headRefName,
    tickets: extractTickets(pr).map((ticket) => ticket.identifier),
  };
}

export function sortItems(items: PullRequestItem[]): PullRequestItem[] {
  const rank = (item: PullRequestItem) =>
    item.reasons.some((reason) => reason.kind !== 'first_review') ? 0 : 1;

  return [...items].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      Date.parse(left.attentionAt) - Date.parse(right.attentionAt) ||
      left.number - right.number,
  );
}
