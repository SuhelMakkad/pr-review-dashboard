import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
  MessageSquare,
  X,
} from 'lucide-react';
import { forgeTerms } from '@review-desk/shared/accounts';
import type { CiState } from '@review-desk/shared/types';
import { reviewEventLabels, type ReviewDraft, type ReviewEvent } from '@review-desk/shared/review';
import type { OperationReceipt } from '@review-desk/shared/operations';
import type { Field } from '@/features/review/draft-writer';
import { useDraftWriter } from '@/features/review/use-draft-writer';
import { openActivity } from '@/features/activity/use-operations';
import { ApiError } from '@/lib/api';
import { useStatus } from '@/lib/queries';
import { dateTime } from '@/lib/time';
import { Button, IconButton } from '@/ui/button';
import { DialogClose, DialogTitle, Modal } from '@/ui/dialog';
import { SmoothHeight } from '@/ui/motion';
import { RunButton } from '@/features/ai/assist-panel';
import { useAi } from '@/features/ai/use-ai';
import { cn } from '@/ui/cn';
import { Kbd } from '@/ui/kbd';

const verdicts: {
  event: ReviewEvent;
  keys: string;
  icon: typeof MessageSquare;
  hint: string;
  tone: string;
}[] = [
  {
    event: 'COMMENT',
    keys: 'c',
    icon: MessageSquare,
    hint: 'General feedback, no verdict.',
    tone: 'neutral',
  },
  {
    event: 'APPROVE',
    keys: 'a',
    icon: CheckCircle2,
    hint: 'Ready to merge. Resolves all open review threads.',
    tone: 'ok',
  },
  {
    event: 'REQUEST_CHANGES',
    keys: 'r',
    icon: CircleDot,
    hint: 'Must be addressed before merging.',
    tone: 'rerequest',
  },
];

export interface FinishSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: ReviewDraft;
  account: string;
  ci: CiState;
  /** The head commit the reviewer was looking at. */
  viewedHeadOid: string;
  submit: (input: {
    event: ReviewEvent;
    body: string;
    expectedHeadOid: string;
    allowNewHead?: boolean;
    /** The writer's versions of `body` and `event`, read with them: required, so a submit never
     * retires text it did not send. */
    carried: Record<Field, number>;
    /** The pending review this sheet showed: admission refuses the submit if it is another. */
    expectedPendingReviewId: string | null;
  }) => Promise<OperationReceipt | null>;
  busy: boolean;
  /** Admitted: its receipt, or null when its receipt was read before its own answer came. */
  onSubmitted: (result: OperationReceipt | null) => void;
  onReviewNewCommits: () => void;
}

/** The only place a review is submitted. States exactly what will be posted, as whom. */
export function FinishSheet({
  open,
  onOpenChange,
  draft,
  account,
  ci,
  viewedHeadOid,
  submit,
  busy,
  onSubmitted,
  onReviewNewCommits,
}: FinishSheetProps) {
  // The summary and verdict are the PR's writer's: every editor of this draft shows the same,
  // and its saves are queued with the draft's other writes.
  const writer = useDraftWriter(account, draft.prId, draft);
  const event = writer.value('event', draft);
  const body = writer.value('body', draft);
  const saveProblem = writer.failure('body') ?? writer.failure('event');
  const [problem, setProblem] = useState<{ code?: string; message: string } | null>(null);
  const ai = useAi(draft.prId, account);
  const summaryRun = ai.latest('draft_summary');
  const savedSummary = ai.completed('draft_summary');
  const generating = ai.isRunning('draft_summary');
  const applying = ai.application?.status === 'pending';
  const generationError = ai.startError('draft_summary');
  const applicationError = ai.application?.status === 'error' ? ai.application.error : null;
  const locked = Boolean(draft.activeOperationId);
  const forge = forgeTerms(account);
  const capabilities = useStatus().data?.capabilities;
  // GitLab requests changes through its API from 19.2 on; older releases take comments and approvals.
  const unavailable = (option: ReviewEvent) =>
    forge.name === 'GitLab' &&
    option === 'REQUEST_CHANGES' &&
    capabilities?.requestChanges !== true;
  const submitted = useRef(false);
  const pending = draft.comments.filter((comment) => comment.status !== 'stale');
  const stale = draft.comments.filter((comment) => comment.status === 'stale');

  useEffect(() => {
    if (open) {
      submitted.current = false;
      setProblem(null);
    }
  }, [open]);

  // Saved now, rather than after the pause, when navigation unmounts the sheet: the writer keeps
  // the edit either way.
  useEffect(() => () => void writer.flush(), [writer]);

  const choose = (next: ReviewEvent) => {
    if (locked || unavailable(next)) return;

    writer.edit('event', next);
  };

  // The pending review this submits: the draft's own, else the one the forge shows.
  const pendingReviewId = draft.githubReviewId ?? draft.githubPendingReview?.id ?? null;

  const send = async (allowNewHead = false) => {
    if (busy || applying || locked || stale.length > 0) return;

    setProblem(null);

    try {
      // The values and their versions, read at once: only those are retired once it is accepted.
      const carried = writer.carry(draft);
      const result = await submit({
        event: carried.event,
        body: carried.body,
        expectedHeadOid: viewedHeadOid,
        allowNewHead,
        carried: carried.versions,
        expectedPendingReviewId: pendingReviewId,
      });

      submitted.current = true;
      onSubmitted(result);
    } catch (error) {
      setProblem({
        code: error instanceof ApiError ? error.code : undefined,
        message: (error as Error).message,
      });
    }
  };

  const warnings = [
    ...(event === 'APPROVE' && ci === 'failure' ? ['Checks are failing on this commit.'] : []),
    ...(event === 'REQUEST_CHANGES' && pending.length === 0 && !body.trim()
      ? ['Say what needs to change: add a summary or comments.']
      : []),
    // Its count is shown only when the forge's part names the very review this submits.
    ...(pendingReviewId && draft.githubPendingReview?.id === pendingReviewId
      ? draft.githubPendingReview.commentCount > 0
        ? [
            `You already have ${draft.githubPendingReview.commentCount} ${draft.githubPendingReview.commentCount === 1 ? 'comment' : 'comments'} in a pending review on ${forge.name}; they will be submitted with this review.`,
          ]
        : []
      : pendingReviewId
        ? [
            `You have a pending review on ${forge.name}. Its comments could not be counted; any it has will be submitted with this review.`,
          ]
        : []),
  ];

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitted.current) void writer.flush();

        onOpenChange(next);
      }}
      aria-describedby={undefined}
      className="top-1/2 flex max-h-[86vh] w-[640px] -translate-y-1/2 flex-col"
      onKeyDown={(keyEvent) => {
        const typing = keyEvent.target instanceof HTMLTextAreaElement;
        const verdict = verdicts.find((option) => option.keys === keyEvent.key);

        if (!typing && verdict && !keyEvent.metaKey && !keyEvent.ctrlKey) {
          keyEvent.preventDefault();
          choose(verdict.event);
        }

        if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key === 'Enter') {
          keyEvent.preventDefault();
          void send();
        }
      }}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <DialogTitle className="text-base font-semibold">Finish your review</DialogTitle>
        <DialogClose asChild>
          <IconButton size="sm" label="Close" icon={<X size={15} />} />
        </DialogClose>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {locked && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-md border border-line bg-sunken p-3 text-xs"
          >
            <p>This review is saved in Activity and is read-only until its action is resolved.</p>
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false);
                openActivity();
              }}
            >
              View activity
            </Button>
          </div>
        )}
        <div role="radiogroup" aria-label="Review verdict" className="grid grid-cols-3 gap-2">
          {verdicts.map((option) => (
            <button
              key={option.event}
              type="button"
              role="radio"
              aria-checked={event === option.event}
              onClick={() => choose(option.event)}
              disabled={locked || unavailable(option.event)}
              className={cn(
                'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left',
                event === option.event ? 'border-accent bg-selected' : 'border-line hover:bg-hover',
                unavailable(option.event) && 'cursor-not-allowed opacity-60 hover:bg-transparent',
              )}
            >
              <span className="flex w-full items-center gap-1.5 text-sm font-medium">
                <option.icon
                  size={14}
                  style={{ color: `var(--${option.tone})` }}
                  aria-hidden="true"
                />
                {reviewEventLabels[option.event]}
                <Kbd keys={option.keys} className="ml-auto" />
              </span>
              <span className="text-xs text-fg-muted">
                {unavailable(option.event)
                  ? 'Needs GitLab 19.2 or later. Say what needs to change in a comment.'
                  : option.hint}
              </span>
            </button>
          ))}
        </div>

        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">Summary (optional, Markdown)</span>
          <RunButton
            label={summaryRun ? 'Generate new summary' : 'Draft summary'}
            running={generating || applying || locked || ai.runs.isPending}
            onRun={(provider) => {
              ai.start.mutate({
                task: 'draft_summary',
                provider,
                force: true,
              });
            }}
          />
        </div>
        {/* Eases between loading, generating, failed and ready instead of jumping in height. */}
        <SmoothHeight
          trigger={[ai.runs.isPending, Boolean(ai.runs.error), generating, summaryRun?.status].join(
            '|',
          )}
        >
          <section aria-label="Generated review summary" className="space-y-2 text-xs">
            {ai.runs.isPending && (
              <p role="status" className="text-fg-muted">
                Loading saved summaries…
              </p>
            )}
            {ai.runs.error && (
              <div role="alert" className="space-y-1 text-fail">
                <p>Could not load saved summaries. {ai.runs.error.message}</p>
                <Button size="sm" onClick={() => void ai.runs.refetch()}>
                  Try again
                </Button>
              </div>
            )}
            {generating && (
              <div className="flex items-start gap-2 text-fg-muted">
                <LoaderCircle size={13} className="mt-px animate-spin text-ai" aria-hidden="true" />
                <div className="space-y-1">
                  <p role="status">
                    {ai.isStarting('draft_summary')
                      ? 'Starting summary…'
                      : summaryRun?.status === 'queued'
                        ? 'Summary queued…'
                        : 'Generating summary…'}
                  </p>
                  <p>
                    You can close this window or navigate away. Generation will continue, and the
                    result will be saved here.
                  </p>
                </div>
                {summaryRun && !ai.isStarting('draft_summary') && (
                  <>
                    {summaryRun.canPause && (
                      <Button size="sm" variant="ghost" onClick={() => ai.pause(summaryRun.id)}>
                        Pause
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => ai.cancel.mutate(summaryRun.id)}
                    >
                      Stop
                    </Button>
                  </>
                )}
              </div>
            )}
            {summaryRun?.status === 'failed' && (
              <p role="alert" className="text-fail">
                Summary generation failed: {summaryRun.error ?? 'Try generating it again.'}
              </p>
            )}
            {summaryRun?.status === 'paused' && (
              <p role="status" className="text-fg-muted">
                Summary generation is paused. Your progress is saved.
              </p>
            )}
            {summaryRun?.resumable && !generating && (
              <Button size="sm" onClick={() => ai.resume(summaryRun.id)}>
                Resume summary
              </Button>
            )}
            {summaryRun?.status === 'paused' && summaryRun.stale && (
              <p className="text-pending">{summaryRun.staleReason} Generate a new summary.</p>
            )}
            {summaryRun?.status === 'paused' && summaryRun.error && (
              <p role="alert" className="text-fail">
                {summaryRun.error}
              </p>
            )}
            {ai.controlError && (
              <p role="alert" className="text-fail">
                {ai.controlError.message}
              </p>
            )}
            {(summaryRun?.status === 'cancelled' || summaryRun?.status === 'interrupted') && (
              <p role="status" className="text-fg-muted">
                {summaryRun.status === 'cancelled'
                  ? 'Summary generation was stopped.'
                  : 'Summary generation was interrupted by a restart.'}{' '}
                Generate a new summary to try again.
              </p>
            )}
            {generationError && (
              <p role="alert" className="text-fail">
                {generationError.message}
              </p>
            )}
            {savedSummary && (
              <div className="space-y-2 rounded-md border border-ai/30 bg-ai/[0.03] p-3">
                <p className="text-fg-muted">
                  Generated{' '}
                  <time dateTime={savedSummary.finishedAt ?? savedSummary.createdAt}>
                    {dateTime(savedSummary.finishedAt ?? savedSummary.createdAt)}
                  </time>
                  {' · '}
                  {savedSummary.headOid.slice(0, 7)}
                  {' · '}
                  {savedSummary.stale ? 'Out of date' : 'Up to date'}
                </p>
                {savedSummary.stale && (
                  <p className="text-pending">
                    {savedSummary.staleReason} Generate a new summary before using it.
                  </p>
                )}
                <Button
                  size="sm"
                  disabled={
                    savedSummary.stale ||
                    generating ||
                    applying ||
                    locked ||
                    savedSummary.headOid !== viewedHeadOid
                  }
                  aria-busy={applying}
                  onClick={() => {
                    // The writer seeds the draft it leaves: the sheet shows it from there.
                    ai.applySummary.mutate(savedSummary.id);
                  }}
                >
                  {applying ? 'Loading generated summary…' : 'Use generated summary'}
                </Button>
                <p className="text-2xs text-fg-subtle">
                  Using this summary replaces the text below. Your current text is kept until you
                  choose to use it.
                </p>
              </div>
            )}
            {applicationError && (
              <p role="alert" className="text-fail">
                {applicationError.message}
              </p>
            )}
          </section>
        </SmoothHeight>
        <label className="block">
          <span className="sr-only">Summary (optional, Markdown)</span>
          <textarea
            value={body}
            disabled={applying || locked}
            onChange={(change) => writer.edit('body', change.target.value)}
            rows={5}
            placeholder="The overall picture: what is good, what must change, what you did not look at."
            className="w-full resize-y rounded-sm border border-line bg-sunken px-3 py-2 text-sm outline-none placeholder:text-fg-subtle focus:border-accent"
          />
        </label>
        {saveProblem && (
          <p role="alert" className="text-sm text-fail">
            {saveProblem}
          </p>
        )}

        {Boolean(draft.preparedReview?.previousDrafts?.length) && (
          <details className="space-y-2 rounded-sm border border-line p-3 text-xs">
            <summary className="cursor-pointer font-medium text-fg-muted">
              Saved drafts before replacement
            </summary>
            {[...draft.preparedReview!.previousDrafts!].reverse().map((saved, index) => (
              <details key={index} className="space-y-2 border-t border-line pt-2">
                <summary className="cursor-pointer text-fg-muted">
                  Draft saved {dateTime(saved.savedAt)}
                </summary>
                <pre className="whitespace-pre-wrap break-words font-sans">{saved.body}</pre>
                {saved.comments.map((comment) => (
                  <div key={comment.id} className="space-y-1">
                    <code className="break-all text-fg-subtle">
                      {comment.path}
                      {comment.line === null ? '' : `:${comment.line}`}
                    </code>
                    <pre className="whitespace-pre-wrap break-words font-sans">{comment.body}</pre>
                  </div>
                ))}
              </details>
            ))}
          </details>
        )}

        <div>
          <h3 className="mb-1.5 text-xs font-medium text-fg-muted">
            {pending.length === 0
              ? 'No inline comments'
              : `${pending.length} inline ${pending.length === 1 ? 'comment' : 'comments'}`}
          </h3>
          <ul className="space-y-1">
            {pending.map((comment) => (
              <li key={comment.id} className="flex gap-2 text-xs">
                <code className="shrink-0 text-fg-subtle">
                  {comment.path.split('/').pop()}
                  {comment.line ? `:${comment.line}` : ''}
                </code>
                <span className="truncate">{comment.body}</span>
              </li>
            ))}
          </ul>
        </div>

        {(warnings.length > 0 || stale.length > 0) && (
          <ul className="space-y-1.5 rounded-md border border-pending/40 bg-pending/8 px-3 py-2">
            {stale.length > 0 && (
              <li className="flex gap-2 text-xs text-fg">
                <AlertTriangle
                  size={13}
                  className="mt-px shrink-0 text-pending"
                  aria-hidden="true"
                />
                {stale.length} {stale.length === 1 ? 'comment sits' : 'comments sit'} on lines that
                changed. Edit or delete {stale.length === 1 ? 'it' : 'them'} first.
              </li>
            )}
            {warnings.map((warning) => (
              <li key={warning} className="flex gap-2 text-xs text-fg">
                <AlertTriangle
                  size={13}
                  className="mt-px shrink-0 text-pending"
                  aria-hidden="true"
                />
                {warning}
              </li>
            ))}
          </ul>
        )}

        {problem && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-fail/40 bg-fail/8 px-3 py-2 text-xs"
          >
            <p className="text-fg">{problem.message}</p>
            {problem.code === 'HEAD_MOVED' && (
              <div className="flex gap-2">
                <Button size="sm" onClick={onReviewNewCommits}>
                  Review the new commits
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void send(true)}>
                  Submit on the new head anyway
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-line px-5 py-3">
        <span className="text-xs text-fg-muted">
          Posts to {forge.name} as <strong className="text-fg">@{account}</strong>
        </span>
        <Button
          className="ml-auto"
          variant={event === 'REQUEST_CHANGES' ? 'danger' : 'primary'}
          disabled={busy || applying || locked || stale.length > 0}
          onClick={() => void send()}
          shortcut="$mod+Enter"
        >
          {busy
            ? 'Queueing…'
            : locked
              ? 'Review queued'
              : `Submit ${reviewEventLabels[event]} to ${forge.name}`}
        </Button>
      </div>
    </Modal>
  );
}
