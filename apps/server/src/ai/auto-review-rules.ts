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

/**
 * A rule's next step: decided, or the fact it needs next. The rule reads nothing itself: the
 * caller reads the fact it names, adds it to what is known, and asks again (`resolve`).
 */
export type Step<F, D> = { need: keyof F & string } | { decided: D };

/** Runs `rule` to its decision, reading each fact it names, once, in the order it names them. */
export function resolve<F, D>(
  rule: (known: Partial<F>) => Step<F, D>,
  read: { [K in keyof F]: () => F[K] },
): D {
  const known: Partial<F> = {};

  for (;;) {
    const step = rule(known);

    if ('decided' in step) return step.decided;

    known[step.need] = read[step.need]() as F[keyof F & string];
  }
}

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

/** What `requestStage` may need: each read only once the ones before it left it open. */
export interface RequestFacts {
  /** It was made before automatic review was turned on. */
  requestedBeforeSince: boolean;
  /** The PR's previous automatic review is still being checked for new commits. */
  checkingPr: boolean;
  /** A wait on the PR whose quiet period has not ended. */
  pendingWait: LogRow | null;
  /** A review started since its wait began. */
  replacement: AiRunRow | null;
}

/** A due request, from what is stored. */
export function requestStage(
  given: {
    /** Its wait, when it is a restart. */
    waiting: LogRow | null;
    /** It has an entry already (a failure being tried again, or a wait). */
    previous: boolean;
  },
  known: Partial<RequestFacts>,
): Step<RequestFacts, RequestStage> {
  // A restart continues a review that was already admitted, so it is never backlog.
  if (!given.waiting) {
    if (known.requestedBeforeSince === undefined) return { need: 'requestedBeforeSince' };
    if (known.requestedBeforeSince) return { decided: { kind: 'primed' } };
    if (known.checkingPr === undefined) return { need: 'checkingPr' };
    if (known.checkingPr) return { decided: { kind: 'hold' } };
  }

  if (!given.previous) {
    if (known.pendingWait === undefined) return { need: 'pendingWait' };
    if (known.pendingWait) return { decided: { kind: 'join', wait: known.pendingWait } };
  }

  if (given.waiting) {
    if (known.replacement === undefined) return { need: 'replacement' };
    if (known.replacement) return { decided: { kind: 'skip', run: known.replacement } };
  }

  return { decided: { kind: 'continue' } };
}

/** What a request that got this far comes to, once Codex is asked. */
export type StartStage = { kind: 'stop' } | { kind: 'skip'; run: AiRunRow } | { kind: 'start' };

/**
 * Whether to start, once it is known whether automatic review is still current and Codex can
 * run (`ready`): never otherwise (the pass stops), and never over a run in progress or one you
 * paused, which it needs only when ready.
 */
export function startStage(
  ready: boolean,
  known: Partial<{ activeRun: AiRunRow | null }>,
): Step<{ activeRun: AiRunRow | null }, StartStage> {
  if (!ready) return { decided: { kind: 'stop' } };
  if (known.activeRun === undefined) return { need: 'activeRun' };

  return { decided: known.activeRun ? { kind: 'skip', run: known.activeRun } : { kind: 'start' } };
}

/** What `admits` may need, each read afresh, in this order. */
export interface AdmitFacts {
  current: boolean;
  stillDue: boolean;
  activeRun: AiRunRow | null;
  replacement: AiRunRow | null;
  checkingPr: boolean;
  pendingWait: LogRow | null;
}

/**
 * Whether `start()` may go ahead, as it asks once it has refreshed the PR: refused first for a
 * restart whose PR moved during the wait (with the head it moved to, for the next wait), then by
 * each fact read afresh.
 */
export function admits(
  given: { waiting: LogRow | null; /** The head `start()` found. */ head: string },
  known: Partial<AdmitFacts>,
): Step<AdmitFacts, { admit: boolean; pushed: string | null }> {
  const { waiting, head } = given;
  const pushed = waiting && head !== waiting.headOid ? head : null;
  const refused = { decided: { admit: false, pushed } };

  if (pushed) return refused;
  if (known.current === undefined) return { need: 'current' };
  if (!known.current) return refused;
  if (known.stillDue === undefined) return { need: 'stillDue' };
  if (!known.stillDue) return refused;
  if (known.activeRun === undefined) return { need: 'activeRun' };
  if (known.activeRun) return refused;

  if (waiting) {
    if (known.replacement === undefined) return { need: 'replacement' };
    if (known.replacement) return refused;
  }

  // The previous review may have finished meanwhile: its check, or the wait it began, comes
  // first. The next pass joins the wait.
  if (known.checkingPr === undefined) return { need: 'checkingPr' };
  if (known.checkingPr) return refused;

  if (!waiting) {
    if (known.pendingWait === undefined) return { need: 'pendingWait' };
    if (known.pendingWait) return refused;
  }

  return { decided: { admit: true, pushed: null } };
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
    };

/** How `start()` answered: a run, or the error it threw. */
export type StartOutcome =
  { kind: 'run'; run: Pick<AiRunRow, 'id' | 'headOid'> } | { kind: 'error'; error: unknown };

/** What `afterStart` may need: whether still current, and the PR's head as last read. */
export interface AfterStartFacts {
  current: boolean;
  /** Null when there is none. */
  latestHead: string | null;
}

/** What a start comes to: the actions, applied in order, and whether the pass goes on. */
export function afterStart(
  outcome: StartOutcome,
  given: {
    entry: Pick<LogRow, 'key' | 'prId'>;
    previous: LogRow | undefined;
    waiting: LogRow | null;
    /** The head `admits` refused a restart for: its PR moved during the wait. */
    pushed: string | null;
  },
  known: Partial<AfterStartFacts>,
): Step<AfterStartFacts, { actions: StartAction[]; goOn: boolean }> {
  const { entry, previous, waiting } = given;
  const goOn = (actions: StartAction[] = []) => ({ decided: { actions, goOn: true } });
  const stop = { decided: { actions: [], goOn: false } };

  if (outcome.kind === 'run') {
    const { run } = outcome;

    // A saved review returned without asking `admits`: the PR moved to a head reviewed before,
    // which is a push during the wait like any other.
    if (waiting && run.headOid !== waiting.headOid) {
      if (known.current === undefined) return { need: 'current' };

      return goOn(known.current ? [{ kind: 'wait', entry: waiting, head: run.headOid }] : []);
    }

    return goOn([{ kind: 'record', status: 'started', runId: run.id }]);
  }

  const { error } = outcome;

  // Not wanted now. Unrecorded, so a PR that is a draft again is reviewed once ready.
  if (error instanceof ReviewError && error.code === 'NOT_ADMITTED') {
    if (known.current === undefined) return { need: 'current' };
    if (!known.current) return stop;

    return goOn(
      waiting && given.pushed ? [{ kind: 'wait', entry: waiting, head: given.pushed }] : [],
    );
  }

  // New commits arrived while the review was being prepared: wait for the PR to go quiet.
  if (error instanceof ReviewError && error.code === 'HEAD_MOVED') {
    if (known.latestHead === undefined) return { need: 'latestHead' };

    const head = known.latestHead;

    if (!head) return goOn();
    if (known.current === undefined) return { need: 'current' };

    return goOn(
      known.current
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
  if (known.current === undefined) return { need: 'current' };
  if (!known.current) return stop;

  const attempts = (previous?.attempts ?? 0) + 1;

  // A restart tries again once the PR has been quiet again, until it runs out of attempts.
  if (waiting && attempts < MAX_ATTEMPTS) {
    if (known.latestHead === undefined) return { need: 'latestHead' };

    const head = known.latestHead ?? waiting.headOid;

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
 * Whether a finished review's changed PR (`changed`) waits for a fresh review: not when a review
 * started since it finished already covers the new commits, which it needs only once it changed.
 */
export function outdated(
  changed: boolean,
  known: Partial<{ coveredSince: boolean }>,
): Step<{ coveredSince: boolean }, boolean> {
  if (!changed) return { decided: false };
  if (known.coveredSince === undefined) return { need: 'coveredSince' };

  return { decided: !known.coveredSince };
}

/** What a finished review's check comes to for each request waiting on it. */
export type SettleAction<E> =
  { entry: E; kind: 'wait'; head: string; began: string | null } | { entry: E; kind: 'started' };

/**
 * Ends the check of a finished review for each of its `entries`: a fresh review waits for
 * `outdatedHead` to go quiet (from when it finished), or the review stands. `waited` when any
 * entry now waits, which is what keeps its completion from being announced.
 */
export function settleCheck<E>(
  entries: E[],
  outdatedHead: string | null,
  finishedAt: string | null,
): { actions: SettleAction<E>[]; waited: boolean } {
  return {
    // An empty head is a head (a snapshot may keep one): only null means nothing is outdated.
    actions: entries.map((entry) =>
      outdatedHead !== null
        ? { entry, kind: 'wait', head: outdatedHead, began: finishedAt }
        : { entry, kind: 'started' },
    ),
    waited: outdatedHead !== null && entries.length > 0,
  };
}
