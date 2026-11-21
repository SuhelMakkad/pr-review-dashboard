import type {
  AttentionReason,
  PullRequestItem,
  PullRequestSnapshot,
} from '@review-desk/shared/types';
import type { AiRunRow, AutoReviewEntry } from '@/db/ai-runs.js';
import { GitHubError } from '@/github/errors.js';
import { ReviewError } from '@/review/errors.js';

/**
 * What automatic review decides, apart from how it finds out and what it does about it (see
 * `ai/auto-review.ts`, which gathers the facts and applies the decisions). Each rule asks for its
 * facts as it needs them, in order: a fact it does not need is never read, so the reads happen as
 * they did before the rules were set apart.
 */

type LogRow = AutoReviewEntry;

/** Review requests: first requests (direct, team or assignment) and re-requests after a review. */
const TRIGGERS = new Set<AttentionReason['kind']>(['first_review', 'requested_again']);

/** How many times a request is started before it is left failed. */
export const MAX_ATTEMPTS = 3;

/** Errors that mean "not now" for every PR: stop the pass, record nothing, retry next sync. */
const STOP_CODES = new Set([
  'PLAN_LIMIT',
  'SHUTTING_DOWN',
  'ACCOUNT_CHANGED',
  'ACCOUNT_NOT_ACTIVE',
]);
const STOP_OUTCOMES = new Set<GitHubError['outcome']>(['rate_limit', 'unavailable', 'auth']);

export interface AutoReviewCandidate {
  /** `<PR id>:<reason key>`, one per review request. */
  key: string;
  /** The attention reason's key: `first:<event id>` or `request:<event id>` when GitHub has one. */
  reasonKey: string;
  at: string;
  item: PullRequestItem;
}

/** One key per review request, so each request is reviewed at most once. */
export function autoReviewCandidates(items: PullRequestItem[]): AutoReviewCandidate[] {
  return items.flatMap((item) => {
    const reason = item.reasons.filter((candidate) => TRIGGERS.has(candidate.kind)).at(-1);

    return reason
      ? [{ key: `${item.id}:${reason.key}`, reasonKey: reason.key, at: reason.at, item }]
      : [];
  });
}

/**
 * The request is still open on a PR ready for review (not a draft, snoozed or done). Discovery
 * sources outlive the request (a refresh keeps them, and a PR that leaves every feed keeps its
 * last ones), so "requested" proves nothing: a review request for you or your team must still be
 * active. Assignments are taken on trust, since snapshots do not record assignees.
 */
export const stillDue = (item: PullRequestItem, key: string) =>
  item.queue === 'attention' &&
  (item.requestedVia.length > 0 ||
    item.sources.includes('assigned') ||
    item.sources.includes('manual')) &&
  autoReviewCandidates([item]).some((candidate) => candidate.key === key);

/**
 * The requests a pass handles, oldest first: still due, and new, failed with attempts left, or
 * waiting with its quiet period over (at `restartAt` itself, too).
 */
export function dueRequests(
  candidates: AutoReviewCandidate[],
  log: Map<string, LogRow>,
  now: number,
): AutoReviewCandidate[] {
  return candidates
    .filter(({ item, key }) => stillDue(item, key))
    .filter(({ key }) => {
      const entry = log.get(key);

      return (
        !entry ||
        (entry.status === 'failed' && entry.attempts < MAX_ATTEMPTS) ||
        (entry.status === 'waiting' && Date.parse(entry.restartAt ?? '') <= now)
      );
    })
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * A request made before automatic review was turned on (at `since`): backlog. One made at that
 * very moment is not.
 */
export const requestedBefore = (requestedAt: string, since: string) =>
  Date.parse(requestedAt) < Date.parse(since);

/** What a due request comes to before anything is asked of Codex. */
export type RequestStage =
  /** Requested before automatic review was turned on: backlog. */
  | { kind: 'primed' }
  /** The PR's previous review is still being checked: decided once it is. */
  | { kind: 'hold' }
  /** Found while the PR waits to go quiet for another request: it waits with it. */
  | { kind: 'join'; wait: LogRow }
  /** A review started during its wait takes the restart's place. */
  | { kind: 'skip'; run: AiRunRow }
  | { kind: 'continue' };

/**
 * A due request, from what is stored: each fact is read only once the ones before it left the
 * decision open, in this order.
 */
export function requestStage(facts: {
  /** Its wait, when it is a restart. */
  waiting: LogRow | null;
  /** It has an entry already (a failure being tried again, or a wait). */
  previous: boolean;
  /** It was made before automatic review was turned on. */
  requestedBeforeSince: () => boolean;
  /** The PR's previous automatic review is still being checked for new commits. */
  checkingPr: () => boolean;
  /** A wait on the PR whose quiet period has not ended. */
  pendingWait: () => LogRow | null;
  /** A review started since its wait began. */
  replacement: () => AiRunRow | null;
}): RequestStage {
  // A restart continues a review that was already admitted, so it is never backlog.
  if (!facts.waiting && facts.requestedBeforeSince()) return { kind: 'primed' };
  if (!facts.waiting && facts.checkingPr()) return { kind: 'hold' };

  const pending = facts.previous ? null : facts.pendingWait();

  if (pending) return { kind: 'join', wait: pending };

  const replacement = facts.waiting && facts.replacement();

  if (replacement) return { kind: 'skip', run: replacement };

  return { kind: 'continue' };
}

/** What a request that got this far comes to, once Codex is asked. */
export type StartStage = { kind: 'stop' } | { kind: 'skip'; run: AiRunRow } | { kind: 'start' };

/**
 * Whether to start: never while automatic review is no longer current or Codex cannot run (the
 * pass stops), and never over a run in progress or one you paused. Codex is asked only when still
 * current, and the run only when Codex can run.
 */
export async function startStage(facts: {
  current: () => boolean;
  codexReady: () => Promise<boolean>;
  activeRun: () => AiRunRow | null;
}): Promise<StartStage> {
  if (!facts.current() || !(await facts.codexReady())) return { kind: 'stop' };

  const active = facts.activeRun();

  return active ? { kind: 'skip', run: active } : { kind: 'start' };
}

/**
 * Whether `start()` may go ahead, as it asks once it has refreshed the PR: refused first for a
 * restart whose PR moved during the wait (with the head it moved to, for the next wait), then by
 * each fact read afresh, in this order.
 */
export function admits(facts: {
  waiting: LogRow | null;
  /** The head `start()` found. */
  head: string;
  current: () => boolean;
  stillDue: () => boolean;
  activeRun: () => AiRunRow | null;
  replacement: () => AiRunRow | null;
  checkingPr: () => boolean;
  pendingWait: () => LogRow | null;
}): { admit: boolean; pushed: string | null } {
  const pushed = facts.waiting && facts.head !== facts.waiting.headOid ? facts.head : null;
  const admit =
    !pushed &&
    facts.current() &&
    facts.stillDue() &&
    !facts.activeRun() &&
    !(facts.waiting && facts.replacement()) &&
    // The previous review may have finished meanwhile: its check, or the wait it began, comes
    // first. The next pass joins the wait.
    !facts.checkingPr() &&
    (facts.waiting !== null || !facts.pendingWait());

  return { admit, pushed };
}

/** What a request's start came to, for its entry. */
export type StartAction =
  | {
      kind: 'record';
      status: 'started' | 'failed';
      runId?: string | null;
      attempts?: number;
      error?: unknown;
    }
  /** Waits for the PR to go quiet at `head`, from the entry given. */
  | {
      kind: 'wait';
      entry: Pick<LogRow, 'key' | 'prId'> &
        Partial<Pick<LogRow, 'runId' | 'attempts' | 'status' | 'waitingSince'>>;
      head: string;
    }
  /** Stops the pass. */
  | { kind: 'stop' };

/** How `start()` answered: a run, or the error it threw. */
export type StartOutcome =
  { kind: 'run'; run: Pick<AiRunRow, 'id' | 'headOid'> } | { kind: 'error'; error: unknown };

/**
 * What a start comes to, asking for the facts its outcome needs only: the actions, applied in
 * order, and whether the pass goes on.
 */
export function afterStart(
  outcome: StartOutcome,
  facts: {
    entry: Pick<LogRow, 'key' | 'prId'>;
    previous: LogRow | undefined;
    waiting: LogRow | null;
    /** The head `admits` refused a restart for: its PR moved during the wait. */
    pushed: string | null;
    current: () => boolean;
    /** The PR's head as last read. */
    latestHead: () => string | undefined;
  },
): { actions: StartAction[]; goOn: boolean } {
  const { entry, previous, waiting } = facts;
  const goOn = (actions: StartAction[] = []) => ({ actions, goOn: true });
  const stop = { actions: [], goOn: false };

  if (outcome.kind === 'run') {
    const { run } = outcome;

    // A saved review returned without asking `admits`: the PR moved to a head reviewed before,
    // which is a push during the wait like any other.
    if (waiting && run.headOid !== waiting.headOid)
      return goOn(facts.current() ? [{ kind: 'wait', entry: waiting, head: run.headOid }] : []);

    return goOn([{ kind: 'record', status: 'started', runId: run.id }]);
  }

  const { error } = outcome;

  // Not wanted now. Unrecorded, so a PR that is a draft again is reviewed once ready.
  if (error instanceof ReviewError && error.code === 'NOT_ADMITTED') {
    if (!facts.current()) return stop;

    return goOn(
      waiting && facts.pushed ? [{ kind: 'wait', entry: waiting, head: facts.pushed }] : [],
    );
  }

  // New commits arrived while the review was being prepared: wait for the PR to go quiet.
  if (error instanceof ReviewError && error.code === 'HEAD_MOVED') {
    const head = facts.latestHead();

    return goOn(
      head && facts.current()
        ? [
            {
              kind: 'wait',
              entry: waiting ?? { ...entry, runId: previous?.runId, attempts: previous?.attempts },
              head,
            },
          ]
        : [],
    );
  }

  if (error instanceof ReviewError && STOP_CODES.has(error.code)) return stop;
  if (error instanceof GitHubError && STOP_OUTCOMES.has(error.outcome)) return stop;

  // Turned off, or off and on again, while it started: what it decided then no longer holds.
  if (!facts.current()) return stop;

  const attempts = (previous?.attempts ?? 0) + 1;

  // A restart tries again once the PR has been quiet again, until it runs out of attempts.
  if (waiting && attempts < MAX_ATTEMPTS) {
    const head = facts.latestHead() ?? waiting.headOid;

    return goOn(head ? [{ kind: 'wait', entry: { ...waiting, attempts }, head }] : []);
  }

  return goOn([{ kind: 'record', status: 'failed', runId: waiting?.runId, attempts, error }]);
}

/** What a push since its review means for an entry following one. */
export type PushAction =
  | { kind: 'none' }
  /** A wait whose PR moved again: the quiet period starts over at `head`. */
  | { kind: 'rewait'; head: string }
  /** A review whose PR moved: stopped, and a wait for `head` to go quiet. */
  | { kind: 'cancelAndWait'; head: string };

/** An entry following a push: a wait, or a request with a stoppable run (`run`). */
export function followPush(
  entry: LogRow,
  pr: PullRequestSnapshot,
  run: AiRunRow | undefined,
): PushAction {
  if (entry.status === 'waiting')
    return pr.headOid !== entry.headOid ? { kind: 'rewait', head: pr.headOid } : { kind: 'none' };

  return run && run.headOid !== pr.headOid
    ? { kind: 'cancelAndWait', head: pr.headOid }
    : { kind: 'none' };
}

/**
 * Whether a finished review's PR changed while it ran, from the PR as it is now: `compare` when
 * only the commits between the reviewed and current heads can tell (see `changedAfterCompare`).
 *
 * Checked as it finishes, GitHub shows what was pushed meanwhile, so any new head counts. Checked
 * later, a head committed before the review finished counts (a rebase or amend renews the date);
 * a later one may hide an earlier push, which the compare tells.
 */
export function changedWhile(
  run: AiRunRow,
  pr: PullRequestSnapshot,
  asItFinished: boolean,
): boolean | 'compare' {
  if (pr.headOid === run.headOid) return false;
  if (asItFinished) return true;

  return Date.parse(pr.headCommittedAt) <= Date.parse(run.finishedAt ?? '') ? true : 'compare';
}

/**
 * The compare's answer: changed when any commit beyond the reviewed head was made before the
 * review finished, or has no date, or when the history is unknown (`null`). A committer clock that
 * runs ahead can hide a push from this.
 */
export function changedAfterCompare(
  run: AiRunRow,
  compare: { commits: { committedAt: string | null }[] } | null,
): boolean {
  const finished = Date.parse(run.finishedAt ?? '');

  return (
    !compare ||
    compare.commits.some(
      (commit) => commit.committedAt === null || Date.parse(commit.committedAt) <= finished,
    )
  );
}

/**
 * The head a fresh review waits for, once a finished review's PR changed: none when a review
 * started since it finished already covers the new commits (asked only once it changed).
 */
export function outdatedHead(
  changed: PullRequestSnapshot | null,
  coveredSince: () => boolean,
): PullRequestSnapshot | null {
  return changed && !coveredSince() ? changed : null;
}
