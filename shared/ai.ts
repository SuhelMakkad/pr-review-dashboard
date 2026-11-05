/** AI assist contract. Agents are advisory: nothing they produce is posted without the user. */

export type AiProvider = 'codex' | 'claude';
export type AiTask =
  'full_review' | 'brief' | 'since_review' | 'draft_comments' | 'author_feedback' | 'draft_summary';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type AiRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

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
  /** True when the PR head has moved since this run. */
  stale: boolean;
}

export interface AiTaskSettings {
  provider: AiProvider | null;
  effort: AiEffort;
  model: string | null;
}

export interface AiSettings {
  defaultProvider: AiProvider;
  tasks: Record<AiTask, AiTaskSettings>;
}

export interface AiProviderStatus {
  id: AiProvider;
  label: string;
  available: boolean;
  version: string | null;
  reason: string | null;
  demo: boolean;
}

export const aiTaskLabels: Record<AiTask, string> = {
  full_review: 'Full Codex review',
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
});
