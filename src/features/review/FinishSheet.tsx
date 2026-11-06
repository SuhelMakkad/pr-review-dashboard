import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
  MessageSquare,
  X,
} from 'lucide-react';
import type { CiState } from '../../../shared/types';
import {
  reviewEventLabels,
  type ReviewDraft,
  type ReviewEvent,
  type SubmitReviewResult,
} from '../../../shared/review';
import { ApiError } from '../../lib/api';
import { dateTime } from '../../lib/time';
import { Button, IconButton } from '../../ui/Button';
import { RunButton } from '../ai/AssistPanel';
import { useAi } from '../ai/useAi';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/Kbd';

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
    hint: 'Ready to merge from your side.',
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
  saveMeta: (changes: { body?: string; event?: ReviewEvent }) => void;
  submit: (input: {
    event: ReviewEvent;
    body: string;
    expectedHeadOid: string;
    allowNewHead?: boolean;
  }) => Promise<SubmitReviewResult>;
  busy: boolean;
  onSubmitted: (result: SubmitReviewResult) => void;
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
  saveMeta,
  submit,
  busy,
  onSubmitted,
  onReviewNewCommits,
}: FinishSheetProps) {
  const [event, setEvent] = useState<ReviewEvent>(draft.event);
  const [body, setBody] = useState(draft.body);
  const [problem, setProblem] = useState<{ code?: string; message: string } | null>(null);
  const lastSaved = useRef(draft.body);
  const ai = useAi(draft.prId, account);
  const summaryRun = ai.latest('draft_summary');
  const savedSummary = ai.completed('draft_summary');
  const generating = ai.isRunning('draft_summary');
  const applying = ai.application?.status === 'pending';
  const generationError = ai.startError('draft_summary');
  const applicationError = ai.application?.status === 'error' ? ai.application.error : null;
  const submitted = useRef(false);
  const current = useRef({ body, saveMeta, applying });

  current.current = { body, saveMeta, applying };
  const pending = draft.comments.filter((comment) => comment.status !== 'stale');
  const stale = draft.comments.filter((comment) => comment.status === 'stale');

  useEffect(() => {
    if (open) {
      setEvent(draft.event);
      setBody(draft.body);
      setProblem(null);
    }
  }, [open]);

  // Autosave the summary so closing the sheet never loses it.
  useEffect(() => {
    if (!open || applying || body === lastSaved.current) return;

    const timer = setTimeout(() => {
      lastSaved.current = body;
      saveMeta({ body });
    }, 800);

    return () => clearTimeout(timer);
  }, [body, open, applying]);

  // Flush pending edits when navigation unmounts the sheet before its debounce finishes.
  useEffect(() => {
    return () => {
      if (
        !submitted.current &&
        !current.current.applying &&
        current.current.body !== lastSaved.current
      )
        current.current.saveMeta({ body: current.current.body });
    };
  }, []);

  const choose = (next: ReviewEvent) => {
    setEvent(next);
    saveMeta({ event: next });
  };

  const send = async (allowNewHead = false) => {
    if (busy || applying || stale.length > 0) return;

    setProblem(null);

    try {
      const result = await submit({ event, body, expectedHeadOid: viewedHeadOid, allowNewHead });

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
    ...(draft.githubPendingReview && draft.githubPendingReview.commentCount > 0
      ? [
          `You already have ${draft.githubPendingReview.commentCount} ${draft.githubPendingReview.commentCount === 1 ? 'comment' : 'comments'} in a pending review on GitHub; they will be submitted with this review.`,
        ]
      : []),
  ];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !applying && body !== lastSaved.current) {
          lastSaved.current = body;
          saveMeta({ body });
        }

        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 dark:bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-elevated shadow-popover"
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
            <Dialog.Title className="text-base font-semibold">Finish your review</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton size="sm" label="Close" icon={<X size={15} />} />
            </Dialog.Close>
          </div>

          <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div role="radiogroup" aria-label="Review verdict" className="grid grid-cols-3 gap-2">
              {verdicts.map((option) => (
                <button
                  key={option.event}
                  type="button"
                  role="radio"
                  aria-checked={event === option.event}
                  onClick={() => choose(option.event)}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left',
                    event === option.event
                      ? 'border-accent bg-selected'
                      : 'border-line hover:bg-hover',
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
                  <span className="text-xs text-fg-muted">{option.hint}</span>
                </button>
              ))}
            </div>

            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-fg-muted">
                Summary (optional, Markdown)
              </span>
              <RunButton
                label={summaryRun ? 'Generate new summary' : 'Draft summary'}
                running={generating || applying || ai.runs.isPending}
                onRun={(provider) => {
                  ai.start.mutate({
                    task: 'draft_summary',
                    provider,
                    force: true,
                    draftEvent: event,
                    draftBody: body,
                  });
                }}
              />
            </div>
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
                  <LoaderCircle
                    size={13}
                    className="mt-px animate-spin text-ai"
                    aria-hidden="true"
                  />
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
                      savedSummary.headOid !== viewedHeadOid
                    }
                    aria-busy={applying}
                    onClick={() => {
                      ai.applySummary.mutate(savedSummary.id, {
                        onSuccess: (next) => {
                          lastSaved.current = next.body;
                          setBody(next.body);
                        },
                      });
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
            <label className="block">
              <span className="sr-only">Summary (optional, Markdown)</span>
              <textarea
                value={body}
                disabled={applying}
                onChange={(change) => setBody(change.target.value)}
                rows={5}
                placeholder="The overall picture: what is good, what must change, what you did not look at."
                className="w-full resize-y rounded-sm border border-line bg-sunken px-3 py-2 text-sm outline-none placeholder:text-fg-subtle focus:border-accent"
              />
            </label>

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
                    {stale.length} {stale.length === 1 ? 'comment sits' : 'comments sit'} on lines
                    that changed. Edit or delete {stale.length === 1 ? 'it' : 'them'} first.
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
              Posts to GitHub as <strong className="text-fg">@{account}</strong>
            </span>
            <Button
              className="ml-auto"
              variant={event === 'REQUEST_CHANGES' ? 'danger' : 'primary'}
              disabled={busy || applying || stale.length > 0}
              onClick={() => void send()}
              shortcut="$mod+Enter"
            >
              {busy ? 'Submitting…' : `Submit ${reviewEventLabels[event]} to GitHub`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
