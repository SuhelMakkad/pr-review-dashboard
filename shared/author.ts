import { extractTickets } from './tickets.js';
import type { CiState, PullRequestSnapshot, Reviewer, ReviewerVerdict } from './types.js';

export type BlockerKind =
  | 'ci_failing'
  | 'conflicts'
  | 'behind'
  | 'changes_requested'
  | 'unanswered_threads'
  | 'no_reviewers'
  | 'awaiting_review'
  | 'ci_pending'
  | 'blocked';

/** Who has to act to clear a blocker. */
export type Actor = 'you' | 'reviewers' | 'ci';

export interface Blocker {
  kind: BlockerKind;
  actor: Actor;
  label: string;
  /** When the wait started, for SLA display. */
  since?: string;
  people?: string[];
}

export type AuthorGroup = 'needs_you' | 'waiting' | 'ready' | 'draft';

export interface AuthorItem {
  id: string;
  number: number;
  title: string;
  url: string;
  repository: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  ci: CiState;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  group: AuthorGroup;
  blockers: Blocker[];
  approvals: string[];
  changesRequestedBy: string[];
  requestedReviewers: Reviewer[];
  unresolvedThreads: number;
  /** Oldest outstanding wait on someone else (review request), if any. */
  waitingSince: string | null;
  hasNote: boolean;
  tickets: string[];
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function latestVerdicts(verdicts: ReviewerVerdict[]): ReviewerVerdict[] {
  const byLogin = new Map<string, ReviewerVerdict>();

  for (const verdict of verdicts) {
    const current = byLogin.get(verdict.login.toLowerCase());

    if (!current || Date.parse(verdict.submittedAt) > Date.parse(current.submittedAt)) {
      byLogin.set(verdict.login.toLowerCase(), verdict);
    }
  }

  return [...byLogin.values()];
}

/** Explains what stands between one of the viewer's own PRs and merging, and whose move it is. */
export function deriveAuthorItem(
  pr: PullRequestSnapshot,
  login: string,
  hasNote = false,
): AuthorItem {
  const verdicts = latestVerdicts(pr.verdicts.filter((verdict) => !same(verdict.login, login)));
  const requested = pr.reviewRequests;
  const requestedLogins = new Set(requested.map((reviewer) => reviewer.login.toLowerCase()));
  const approvals = verdicts
    .filter((verdict) => verdict.state === 'APPROVED')
    .map((verdict) => verdict.login);
  // A reviewer who requested changes but has been re-requested is now the one to act.
  const changesRequestedBy = verdicts
    .filter(
      (verdict) =>
        verdict.state === 'CHANGES_REQUESTED' && !requestedLogins.has(verdict.login.toLowerCase()),
    )
    .map((verdict) => verdict.login);
  const unresolved = pr.threads.filter((thread) => !thread.isResolved);
  const unanswered = unresolved.filter((thread) => {
    const last = thread.comments.at(-1);

    return last && !same(last.author.login, login);
  });
  const requestTimes = requested.map((reviewer) => {
    const event = pr.requestEvents
      .filter(
        (candidate) =>
          !candidate.removed &&
          candidate.reviewer &&
          same(candidate.reviewer.login, reviewer.login),
      )
      .at(-1);

    return event?.createdAt ?? pr.createdAt;
  });
  const waitingSince = requestTimes.sort()[0] ?? null;
  const blockers: Blocker[] = [];

  if (pr.ci === 'failure')
    blockers.push({ kind: 'ci_failing', actor: 'you', label: 'Checks are failing' });

  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    blockers.push({
      kind: 'conflicts',
      actor: 'you',
      label: 'Merge conflicts with the base branch',
    });
  }

  if (pr.mergeStateStatus === 'BEHIND') {
    blockers.push({ kind: 'behind', actor: 'you', label: 'Branch is behind the base branch' });
  }

  if (changesRequestedBy.length > 0) {
    blockers.push({
      kind: 'changes_requested',
      actor: 'you',
      label: `Changes requested by ${changesRequestedBy.join(', ')}`,
      people: changesRequestedBy,
    });
  }

  if (unanswered.length > 0) {
    blockers.push({
      kind: 'unanswered_threads',
      actor: 'you',
      label: `${unanswered.length} ${unanswered.length === 1 ? 'thread is' : 'threads are'} waiting for your reply`,
    });
  }

  if (
    !pr.isDraft &&
    requested.length === 0 &&
    approvals.length === 0 &&
    changesRequestedBy.length === 0
  ) {
    // Someone may have commented without approving; suggest asking them again.
    const participants = [
      ...new Set(
        [...pr.threads.flatMap((thread) => thread.comments), ...pr.conversation]
          .map((comment) => comment.author.login)
          .filter((author) => !same(author, login) && !author.endsWith('[bot]')),
      ),
    ];

    blockers.push({
      kind: 'no_reviewers',
      actor: 'you',
      label: participants.length
        ? `No review requested — ask ${participants.slice(0, 3).join(', ')} again for an approval`
        : 'No reviewers requested yet',
      people: participants,
    });
  }

  if (requested.length > 0) {
    blockers.push({
      kind: 'awaiting_review',
      actor: 'reviewers',
      label: `Waiting for ${requested.map((reviewer) => (reviewer.kind === 'team' ? reviewer.name : reviewer.login)).join(', ')}`,
      since: waitingSince ?? undefined,
      people: requested.map((reviewer) => reviewer.login),
    });
  }

  if (pr.ci === 'pending')
    blockers.push({ kind: 'ci_pending', actor: 'ci', label: 'Checks are running' });

  const ready =
    !pr.isDraft &&
    blockers.length === 0 &&
    (pr.mergeStateStatus === 'CLEAN' ||
      pr.mergeStateStatus === 'HAS_HOOKS' ||
      (pr.reviewDecision === 'APPROVED' && pr.mergeable === 'MERGEABLE'));

  if (!pr.isDraft && !ready && blockers.length === 0 && pr.mergeStateStatus === 'BLOCKED') {
    blockers.push({
      kind: 'blocked',
      actor: 'reviewers',
      label: 'Blocked by branch protection (e.g. required approvals)',
    });
  }

  const group: AuthorGroup = pr.isDraft
    ? 'draft'
    : blockers.some((blocker) => blocker.actor === 'you')
      ? 'needs_you'
      : ready
        ? 'ready'
        : 'waiting';

  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repository: pr.repository,
    isDraft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    ci: pr.ci,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    headRefName: pr.headRefName,
    group,
    blockers,
    approvals,
    changesRequestedBy,
    requestedReviewers: requested,
    unresolvedThreads: unresolved.length,
    waitingSince,
    hasNote,
    tickets: extractTickets(pr).map((ticket) => ticket.identifier),
  };
}

const groupOrder: AuthorGroup[] = ['needs_you', 'waiting', 'ready', 'draft'];

/** Needs-you first, then the longest waits, then ready to merge, then drafts. */
export function sortAuthorItems(items: AuthorItem[]): AuthorItem[] {
  return [...items].sort(
    (left, right) =>
      groupOrder.indexOf(left.group) - groupOrder.indexOf(right.group) ||
      Date.parse(left.waitingSince ?? left.updatedAt) -
        Date.parse(right.waitingSince ?? right.updatedAt) ||
      left.number - right.number,
  );
}
