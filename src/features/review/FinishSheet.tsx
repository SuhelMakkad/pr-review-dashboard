import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { AlertTriangle, CheckCircle2, CircleDot, MessageSquare, X } from 'lucide-react';
import type { CiState } from '../../../shared/types';
import {
  reviewEventLabels,
  type ReviewDraft,
  type ReviewEvent,
  type SubmitReviewResult,
} from '../../../shared/review';
import { ApiError } from '../../lib/api';
import { Button, IconButton } from '../../ui/Button';
import { RunButton } from '../ai/AssistPanel';
import { useAi } from '../ai/useAi';
import type { DraftSummaryResult } from '../../../shared/ai';
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
  const requestedAt = useRef<string | null>(null);
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
    if (!open || body === lastSaved.current) return;

    const timer = setTimeout(() => {
      lastSaved.current = body;
      saveMeta({ body });
    }, 800);

    return () => clearTimeout(timer);
  }, [body, open]);

  // Fill the summary with an AI draft once the requested run finishes.
  useEffect(() => {
    if (
      !requestedAt.current ||
      summaryRun?.status !== 'done' ||
      summaryRun.createdAt < requestedAt.current
    )
      return;

    requestedAt.current = null;
    setBody((summaryRun.result as DraftSummaryResult).body);
  }, [summaryRun?.status, summaryRun?.id]);

  const choose = (next: ReviewEvent) => {
    setEvent(next);
    saveMeta({ event: next });
  };

  const send = async (allowNewHead = false) => {
    setProblem(null);

    try {
      const result = await submit({ event, body, expectedHeadOid: viewedHeadOid, allowNewHead });

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
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
                label="Draft summary"
                running={ai.isRunning('draft_summary')}
                onRun={(provider) => {
                  saveMeta({ event });
                  requestedAt.current = new Date(Date.now() - 1000).toISOString();
                  ai.start.mutate({ task: 'draft_summary', provider, force: true });
                }}
              />
            </div>
            <label className="block">
              <span className="sr-only">Summary (optional, Markdown)</span>
              <textarea
                value={body}
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
              disabled={busy || stale.length > 0}
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
