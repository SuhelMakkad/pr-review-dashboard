import type { PullRequestSnapshot, Reviewer } from '../../shared/types.js';

export type ActivityKind =
  | 'request_received'
  | 'request_removed'
  | 'review_submitted'
  | 'comment_posted'
  | 'pr_closed'
  | 'pr_merged'
  | 'authored_opened'
  | 'authored_review_received';

export interface ActivityEvent {
  /** Unique per account; re-extracting the same snapshot yields the same keys. */
  key: string;
  prId: string;
  repository: string;
  number: number;
  kind: ActivityKind;
  actor: string | null;
  at: string;
  data?: Record<string, unknown>;
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * Turns a snapshot into the viewer's review history: requests received (directly or via a team),
 * reviews and comments the viewer posted, and lifecycle events. Pure and idempotent.
 */
export function extractActivity(
  pr: PullRequestSnapshot,
  login: string,
  teams: string[],
): ActivityEvent[] {
  const base = { prId: pr.id, repository: pr.repository, number: pr.number };
  const events: ActivityEvent[] = [];
  const targetsViewer = (reviewer: Reviewer | null) =>
    Boolean(
      reviewer &&
      (reviewer.kind === 'user'
        ? same(reviewer.login, login)
        : teams.some((team) => same(team, reviewer.login))),
    );
  const authoredByViewer = same(pr.author.login, login);

  for (const event of pr.requestEvents) {
    if (!targetsViewer(event.reviewer)) continue;

    events.push({
      ...base,
      key: `${event.removed ? 'unrequest' : 'request'}:${event.id}`,
      kind: event.removed ? 'request_removed' : 'request_received',
      actor: null,
      at: event.createdAt,
      data: { via: event.reviewer?.kind === 'team' ? event.reviewer.login : 'direct' },
    });
  }

  for (const review of pr.reviews) {
    events.push({
      ...base,
      key: `review:${review.id}`,
      kind: 'review_submitted',
      actor: login,
      at: review.submittedAt,
      data: { state: review.state, commitOid: review.commitOid },
    });
  }

  for (const thread of pr.threads) {
    for (const comment of thread.comments) {
      if (!same(comment.author.login, login)) continue;

      events.push({
        ...base,
        key: `comment:${comment.id}`,
        kind: 'comment_posted',
        actor: login,
        at: comment.createdAt,
        data: { path: thread.path },
      });
    }
  }

  for (const comment of pr.conversation) {
    if (!same(comment.author.login, login)) continue;

    events.push({
      ...base,
      key: `comment:${comment.id}`,
      kind: 'comment_posted',
      actor: login,
      at: comment.createdAt,
      data: { conversation: true },
    });
  }

  if (authoredByViewer) {
    events.push({
      ...base,
      key: `authored:${pr.id}`,
      kind: 'authored_opened',
      actor: login,
      at: pr.createdAt,
    });

    for (const verdict of pr.verdicts) {
      if (same(verdict.login, login)) continue;

      events.push({
        ...base,
        key: `received:${pr.id}:${verdict.login}:${verdict.submittedAt}`,
        kind: 'authored_review_received',
        actor: verdict.login,
        at: verdict.submittedAt,
        data: { state: verdict.state },
      });
    }
  }

  if (pr.state !== 'OPEN') {
    events.push({
      ...base,
      key: `state:${pr.id}:${pr.state}`,
      kind: pr.state === 'MERGED' ? 'pr_merged' : 'pr_closed',
      actor: null,
      at: pr.updatedAt,
    });
  }

  return events;
}
