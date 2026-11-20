/**
 * AI assist contract. Agents are advisory: nothing they produce is posted without the user, except
 * finished full reviews when the user turns on `postFindings`.
 */

export type AiProvider = 'codex' | 'claude';
export type AiTask =
  'full_review' | 'brief' | 'since_review' | 'draft_comments' | 'author_feedback' | 'draft_summary';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type AiRunStatus =
  'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'interrupted';
/** Who started a run: you, or automatic review when your review was requested. */
export type AiRunTrigger = 'manual' | 'auto';

/**
 * How long a PR must go without new commits before an automatic review that new commits stopped
 * starts again. Each push during the wait starts it over, so a burst of pushes is reviewed once.
 */
export const AUTO_REVIEW_QUIET_MS = 5 * 60_000;

export interface BriefResult {
  summary: string;
  risk: 'low' | 'medium' | 'high';
  riskReasons: string[];
  focusFiles: { path: string; reason: string }[];
  questions: string[];
}

export interface SinceReviewResult {
  summary: string;
  threads: {
    threadId: string;
    verdict: 'addressed' | 'partially' | 'not_addressed' | 'unclear';
    explanation: string;
  }[];
  newConcerns: string[];
}

export interface SuggestedComment {
  path: string;
  /** Null when the model's anchor did not match a commentable line. */
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  severity: 'blocking' | 'suggestion' | 'nit' | 'question';
  body: string;
}

export interface DraftCommentsResult {
  overall: string;
  comments: SuggestedComment[];
}

export interface FullReviewResult extends DraftCommentsResult {
  assessment: 'changes_requested' | 'no_blocking_findings';
  coverage: string[];
}

/**
 * What a full review was given to read, as the server observed it in the review workspace; the
 * model's own `coverage` is what it says it read. Only a complete record lets a review approve.
 */
export interface ReviewInputs {
  v: 1;
  /** The reviewed commits: the PR's head, the merge base it was compared from, and its target. */
  headOid: string;
  mergeBaseOid: string;
  targetBaseOid: string | null;
  /**
   * `verified` when the forge listed every file the reviewed commits change (compared by commit,
   * or from its whole record of the revision); otherwise which files changed is not known.
   */
  inventory: 'verified' | 'unverified';
  /** Changed files the forge counts for the PR. */
  changedFiles: number;
  /** Identifies the file list the agent was given (`review.json`), checked when it is reused. */
  digest: string;
  /** Changed files missing from a reviewed commit's snapshot (the first 50), and how many. */
  unreadable: { path: string; side: 'before' | 'after' }[];
  unreadableCount: number;
  complete: boolean;
}

/**
 * Whether a finished full review was posted automatically, decided when it settled: queued in
 * Activity as an approval or a comment (with why it comments where it could have approved), or
 * not posted, and why.
 */
export type AiPublication =
  { operationId: string; event: 'APPROVE' | 'COMMENT'; reason?: string } | { skipped: string };

/** How many changed files a review could not read in full, where the changed files are known. */
export function unreadFiles(inputs: ReviewInputs): number {
  return new Set(inputs.unreadable.map((file) => file.path)).size;
}

export function hasBlockingFindings(result: FullReviewResult): boolean {
  return (
    result.assessment === 'changes_requested' ||
    result.comments.some((comment) => comment.severity === 'blocking')
  );
}

export interface AuthorFeedbackResult {
  summary: string;
  actionItems: { text: string; threadId: string | null }[];
}

export interface DraftSummaryResult {
  body: string;
}

export type AiResult =
  | FullReviewResult
  | BriefResult
  | SinceReviewResult
  | DraftCommentsResult
  | AuthorFeedbackResult
  | DraftSummaryResult;

export interface AiRun {
  id: string;
  prId: string;
  task: AiTask;
  provider: AiProvider;
  model: string | null;
  effort: AiEffort;
  headOid: string;
  status: AiRunStatus;
  progress: string | null;
  result: AiResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** True when the code, review discussion, or task inputs changed since this run. */
  stale: boolean;
  staleReason: string | null;
  resumable: boolean;
  canPause: boolean;
  pauseReason: 'user' | 'restart' | null;
  /** How far the Codex credit balance fell during the run; null when it did not or is unknown. */
  creditsUsed: number | null;
  trigger: AiRunTrigger;
  /** Full reviews: what the review was given to read, as the server observed it. */
  inputs?: ReviewInputs | null;
  /** Full reviews: whether it was posted automatically when it finished, or why not. */
  publication?: AiPublication | null;
}

/**
 * The latest full review of one PR, for status badges in lists. `runId` and `status` are null for
 * a PR whose automatic review has not run yet but waits to restart.
 */
export interface AiReviewStatus {
  prId: string;
  runId: string | null;
  status: AiRunStatus | null;
  stale: boolean;
  trigger: AiRunTrigger;
  /**
   * New commits stopped this PR's automatic review: a fresh one starts at this time, once the PR
   * has been quiet for `AUTO_REVIEW_QUIET_MS`. Null otherwise.
   */
  restartAt: string | null;
  /**
   * A restart is waiting for this account to be in use again: restarts run only for the account
   * in use, so `restartAt` is null meanwhile.
   */
  restartPaused?: boolean;
}

/** A PR's AI runs, and when an automatic review that new commits stopped starts again. */
export interface AiRunsResponse {
  runs: AiRun[];
  restartAt: string | null;
  /** As in `AiReviewStatus`: a restart waits for this account to be in use again. */
  restartPaused?: boolean;
}

/** Fingerprints of the evidence used to generate a review, persisted with the run. */
export interface AiRunContext {
  review: string;
  draft?: string;
  fullReviewId?: string | null;
}

export interface AiTaskSettings {
  provider: AiProvider | null;
  effort: AiEffort;
  model: string | null;
}

/**
 * Starts a full review when your review is requested. It never prepares or posts anything; `since`
 * is set by the server when it is turned on, and requests already waiting then are not reviewed.
 */
export interface AutoReviewSettings {
  enabled: boolean;
  since: string | null;
}

export interface AiSettings {
  defaultProvider: AiProvider;
  tasks: Record<AiTask, AiTaskSettings>;
  autoReview: AutoReviewSettings;
  /**
   * Posts each finished full review as you, as a conversation comment with its findings, or as an
   * approval where `approveFindings` allows it.
   */
  postFindings: boolean;
  /**
   * With `postFindings`, approves a review with no blocking findings that read every changed file,
   * instead of commenting. Saved settings from before it existed read as on, as posting did then.
   */
  approveFindings: boolean;
  /** Before such an approval, resolves the open threads the review read. */
  resolveThreads: boolean;
}

export interface AiProviderStatus {
  id: AiProvider;
  label: string;
  available: boolean;
  version: string | null;
  reason: string | null;
  demo: boolean;
}

export interface CodexUsageWindow {
  /** "5-hour", "Weekly" and so on, from the window's length. */
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

/** The Codex sign-in the dashboard runs under, and how much of the ChatGPT plan is left. */
export interface CodexAccountStatus {
  /** Only a ChatGPT sign-in bills the plan; Codex runs are refused for anything else. */
  type: 'chatgpt' | 'apiKey' | 'other' | null;
  plan: string | null;
  windows: CodexUsageWindow[];
  /** The plan's included usage is used up: Codex runs are paused so no credits are spent. */
  limitReached: boolean;
  /** When the exhausted window resets. */
  resetsAt: string | null;
  models: CodexModel[];
  /** Why Codex cannot run on the plan right now, in words the user can act on. */
  problem: string | null;
}

export const aiTaskLabels: Record<AiTask, string> = {
  full_review: 'Full review',
  brief: 'Brief',
  since_review: 'What changed since your review',
  draft_comments: 'Draft review comments',
  author_feedback: 'Feedback summary',
  draft_summary: 'Review summary',
};

export const defaultAiSettings = (): AiSettings => ({
  defaultProvider: 'codex',
  tasks: {
    full_review: { provider: 'codex', effort: 'high', model: null },
    brief: { provider: null, effort: 'low', model: null },
    since_review: { provider: null, effort: 'medium', model: null },
    draft_comments: { provider: null, effort: 'high', model: null },
    author_feedback: { provider: null, effort: 'low', model: null },
    draft_summary: { provider: null, effort: 'low', model: null },
  },
  autoReview: { enabled: false, since: null },
  postFindings: false,
  approveFindings: false,
  resolveThreads: false,
});

/** Codex runs are refused: the plan's limit is used up, or the sign-in would not bill the plan. */
export const codexBlocked = (status: CodexAccountStatus | null | undefined): boolean =>
  Boolean(status && (status.limitReached || status.type === 'apiKey' || status.type === 'other'));
