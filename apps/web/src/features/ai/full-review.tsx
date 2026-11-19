import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { codexBlocked, hasBlockingFindings, type FullReviewResult } from '@review-desk/shared/ai';
import { operationInProgress, type GitHubOperation } from '@review-desk/shared/operations';
import type { PrepareReviewOptions } from '@review-desk/shared/review';
import type { CiState } from '@review-desk/shared/types';
import { forgeTerms } from '@review-desk/shared/accounts';
import { ApiError } from '@/lib/api';
import { refOf } from '@/lib/pr-ref';
import { dateTime } from '@/lib/time';
import { Button } from '@/ui/button';
import { MarkdownView } from '@/ui/markdown';
import { FinishSheet } from '@/features/review/finish-sheet';
import { useReview } from '@/features/review/use-review';
import { FadeSwap, Reveal, StaggerItem } from '@/ui/motion';
import { Skeleton, SkeletonRegion, SkeletonText } from '@/ui/skeleton';
import { AiCard } from '@/features/ai/assist-panel';
import { restartCopy } from '@/features/ai/restart';
import { useAi, useAiOverview } from '@/features/ai/use-ai';
import { useInboxNavigation } from '@/features/inbox/inbox-context';
import { openActivity, useOperations } from '@/features/activity/use-operations';

/** Where this review's automatic approval or comment stands. */
function PostingStatus({ operation }: { operation: GitHubOperation }) {
  const approving = operation.action.type === 'ai_review' && operation.action.event === 'APPROVE';
  const forge = forgeTerms(operation.account);

  if (operation.status === 'succeeded')
    return (
      <p className="text-xs text-ok">
        {approving ? `Approved the ${forge.short}.` : `Posted to the ${forge.short} conversation.`}{' '}
        {operation.result?.url && (
          <a
            href={operation.result.url}
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            Open on {forge.name}
          </a>
        )}
      </p>
    );

  if (operation.status === 'needs_attention')
    return (
      <p role="alert" className="text-xs text-pending">
        Posting to the PR needs attention.{' '}
        <button type="button" onClick={openActivity} className="text-accent hover:underline">
          View activity
        </button>
      </p>
    );

  return (
    <p role="status" className="text-xs text-fg-muted">
      {operationInProgress(operation.status)
        ? approving
          ? 'Resolving threads and approving the PR…'
          : 'Posting to the PR conversation…'
        : operation.progress}
    </p>
  );
}

/**
 * A complete review stays on the dashboard until the user explicitly prepares and posts it, unless
 * Settings posts each finished review to the PR.
 */
export function FullReview({
  prId,
  account,
  repository,
  number,
  headOid,
  ci,
}: {
  prId: string;
  account: string;
  repository: string;
  number: number;
  headOid: string;
  ci: CiState;
}) {
  const ai = useAi(prId, account);
  const forge = forgeTerms(account);
  const overview = useAiOverview();
  const review = useReview(prId, account);
  const inbox = useInboxNavigation();
  const locked = Boolean(review.draft.data?.activeOperationId);
  const latest = ai.latest('full_review');
  const run =
    latest && ['failed', 'cancelled', 'interrupted'].includes(latest.status)
      ? (ai.completed('full_review') ?? latest)
      : latest;
  const starting = ai.isStarting('full_review');
  const [selection, setSelection] = useState<{ runId: string; indices: number[] } | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const result = run?.status === 'done' ? (run.result as FullReviewResult | null) : null;
  const operations = useOperations(account);
  const autoPost = overview.data?.settings.postFindings ?? false;
  const posting = run
    ? operations.data?.pages
        .flatMap((page) => page.items)
        .find((item) => item.action.type === 'ai_review' && item.action.runId === run.id)
    : undefined;
  const willPost =
    autoPost && !posting && ['queued', 'running', 'paused'].includes(run?.status ?? '');
  const codex = overview.data?.providers.find((provider) => provider.id === 'codex');
  const plan = overview.data?.codex ?? null;
  const blocked = codexBlocked(plan);
  const prepared = review.draft.data?.preparedReview;
  const selected =
    selection && selection.runId === run?.id
      ? selection.indices
      : prepared && prepared.runId === run?.id
        ? prepared.indices
        : (result?.comments.map((_, index) => index) ?? []);
  const reusable =
    prepared?.runId === run?.id &&
    [...selected].sort((a, b) => a - b).join(',') === prepared?.indices.join(',');
  const preparing = ai.preparation?.status === 'pending';
  const prepareError =
    ai.preparation?.status === 'error' &&
    ai.preparation.runId === run?.id &&
    [...ai.preparation.indices].sort((a, b) => a - b).join(',') ===
      [...selected].sort((a, b) => a - b).join(',')
      ? ai.preparation.error
      : null;
  const replacementRevision =
    prepareError instanceof ApiError &&
    prepareError.code === 'PREPARED_REVIEW_EDITED' &&
    typeof prepareError.details.draftRevision === 'string'
      ? prepareError.details.draftRevision
      : null;
  const launch = () => ai.start.mutate({ task: 'full_review', force: Boolean(run) });
  // GitLab projects can sit in nested groups: the project name is the last segment.
  const { owner, repo } = refOf({ repository, number });
  const target = { owner, repo, number: String(number) };

  const prepare = (options: PrepareReviewOptions = {}) => {
    if (!run || locked) return;

    ai.prepare.mutate(
      { runId: run.id, indices: selected, ...options },
      {
        onSuccess: () => setFinishOpen(true),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <section aria-label="Full review" className="space-y-3">
      <Reveal show={Boolean(ai.restartAt)}>
        {ai.restartAt && (
          <p role="status" className="flex gap-1.5 text-xs text-fg-muted">
            <RefreshCw size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-ai" />
            {restartCopy(ai.restartAt)}
          </p>
        )}
      </Reveal>
      <FadeSwap
        swapKey={run ? 'run' : ai.runs.isPending ? 'loading' : ai.runs.error ? 'error' : 'idle'}
        className="space-y-3"
        smoothHeight
      >
        {!run && ai.runs.isPending ? (
          <SkeletonRegion
            label="Loading saved review…"
            className="space-y-2.5 rounded-md border border-line p-3"
          >
            <Skeleton className="h-3.5 w-28" />
            <SkeletonText lines={2} />
            <Skeleton className="h-7 w-28 rounded-sm" />
          </SkeletonRegion>
        ) : !run && ai.runs.error ? (
          <div role="alert" className="space-y-2 text-xs text-fail">
            <p>Could not load the saved review. {ai.runs.error.message}</p>
            <Button size="sm" onClick={() => void ai.runs.refetch()}>
              Try again
            </Button>
          </div>
        ) : !run ? (
          <div className="space-y-3 rounded-md border border-ai/40 bg-ai/[0.03] p-3">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-ai">
                <Sparkles size={14} aria-hidden="true" /> Full review
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                Find issues across the complete PR.{' '}
                {autoPost
                  ? 'Its findings are posted to the PR when it finishes.'
                  : 'Review the findings before posting.'}
              </p>
            </div>
            <Button
              size="sm"
              icon={
                starting ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} />
                )
              }
              disabled={starting || codex?.available === false || blocked}
              aria-busy={starting}
              onClick={launch}
            >
              {starting ? 'Preparing review…' : 'Run review'}
            </Button>
            {codex?.available !== false && blocked && (
              <p className="text-xs text-fail" role="alert">
                {plan?.problem}
              </p>
            )}
            {codex?.available === false && (
              <p className="text-xs text-fail">
                Review agent unavailable. Check installed agents in{' '}
                <Link to="/settings/$section" params={{ section: 'ai' }} className="underline">
                  Settings
                </Link>
                .
              </p>
            )}
          </div>
        ) : (
          <>
            {run.trigger === 'auto' && (
              <p className="flex items-center gap-1.5 text-2xs text-fg-subtle">
                <Sparkles size={11} aria-hidden="true" /> Started automatically when your review was
                requested.
                {!autoPost &&
                  !posting &&
                  ' Nothing is posted until you prepare and submit a review.'}
              </p>
            )}
            {posting && <PostingStatus operation={posting} />}
            {run.publication && 'reason' in run.publication && run.publication.reason && (
              <p className="text-2xs text-fg-subtle">
                Commented instead of approving: {run.publication.reason}
              </p>
            )}
            {run.publication && 'skipped' in run.publication && (
              <p role="status" className="text-xs text-fg-muted">
                Not posted to the PR: {run.publication.skipped}
              </p>
            )}
            {willPost && (
              <p className="text-2xs text-fg-subtle">
                Its findings will be posted to the PR when this review finishes.
              </p>
            )}
            <AiCard
              run={run}
              title="Full review"
              showProvider={false}
              starting={starting}
              onCancel={() => ai.cancel.mutate(run.id)}
              onRerun={launch}
              onPause={() => ai.pause(run.id)}
              onResume={() => ai.resume(run.id)}
            >
              {result && (
                <div className="space-y-3">
                  <p
                    className={`text-xs font-medium ${hasBlockingFindings(result) ? 'text-pending' : 'text-ok'}`}
                  >
                    {hasBlockingFindings(result) ? 'Changes recommended' : 'No blocking findings'}
                    {result.comments.length > 0 && (
                      <>
                        {' · '}
                        {result.comments.length}{' '}
                        {result.comments.length === 1 ? 'finding' : 'findings'}
                      </>
                    )}
                  </p>
                  <p className="text-2xs text-fg-subtle">
                    Generated{' '}
                    <time dateTime={run.finishedAt ?? run.createdAt}>
                      {dateTime(run.finishedAt ?? run.createdAt)}
                    </time>
                    {' · '}
                    {run.stale ? 'Out of date' : 'Up to date'}
                  </p>
                  <MarkdownView>{result.overall}</MarkdownView>
                  {/* Findings arrive one after another when a review finishes. */}
                  {result.comments.map((comment, index) => (
                    <StaggerItem
                      as="article"
                      key={index}
                      index={index}
                      className="space-y-2 rounded-sm border border-line bg-panel p-3"
                    >
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={selected.includes(index)}
                          aria-label={`Include finding ${index + 1}`}
                          disabled={run.stale || preparing || locked}
                          onChange={(event) =>
                            setSelection({
                              runId: run.id,
                              indices: event.target.checked
                                ? [...selected, index]
                                : selected.filter((item) => item !== index),
                            })
                          }
                          className="size-3.5 accent-accent"
                        />
                        <span
                          className={
                            comment.severity === 'blocking'
                              ? 'font-medium text-fail'
                              : 'text-fg-muted'
                          }
                        >
                          {comment.severity}
                        </span>
                        <Link
                          to="/pr/$owner/$repo/$number/files"
                          params={target}
                          search={{ file: comment.path, mode: 'all' }}
                          className="min-w-0 truncate font-mono text-accent hover:underline"
                        >
                          {comment.path}
                          {comment.line === null ? ' (whole file)' : `:${comment.line}`}
                        </Link>
                      </label>
                      <MarkdownView className="text-xs">{comment.body}</MarkdownView>
                    </StaggerItem>
                  ))}
                  {result.coverage.length > 0 && (
                    <details className="text-xs text-fg-muted">
                      <summary className="cursor-pointer font-medium">Review coverage</summary>
                      <ul className="mt-1 list-disc space-y-1 pl-4">
                        {result.coverage.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {run.stale && (
                    <p className="text-xs text-pending">
                      {run.staleReason} Regenerate this review before posting.
                    </p>
                  )}
                  <div className="space-y-1.5 border-t border-line pt-3">
                    <Button
                      size="sm"
                      disabled={!locked && (run.stale || preparing)}
                      aria-busy={preparing}
                      onClick={locked ? openActivity : () => prepare()}
                    >
                      {locked
                        ? 'Review queued · View activity'
                        : preparing
                          ? 'Preparing draft…'
                          : reusable
                            ? 'Use prepared review'
                            : `Prepare ${forge.name} review`}
                    </Button>
                    <Reveal show={preparing}>
                      <p role="status" className="text-xs text-fg-muted">
                        Preparing your {forge.name} review. You can navigate away; preparation will
                        continue.
                      </p>
                    </Reveal>
                    {reusable && prepared && !preparing && (
                      <p className="text-2xs text-fg-subtle">
                        Draft prepared{' '}
                        <time dateTime={prepared.preparedAt}>{dateTime(prepared.preparedAt)}</time>.{' '}
                        Your saved edits are kept when you reopen it.
                      </p>
                    )}
                    {ai.isRunning('draft_summary') && (
                      <p role="status" className="text-xs text-fg-muted">
                        Your review summary is being generated in the background. Open the prepared
                        review to follow its progress.
                      </p>
                    )}
                    {ai.completed('draft_summary') && !ai.isRunning('draft_summary') && (
                      <p className="text-2xs text-fg-subtle">
                        {ai.completed('draft_summary')!.stale
                          ? 'The saved review summary is out of date. Open the prepared review to generate a new one.'
                          : 'A generated summary is saved. Open the prepared review to use it or generate a new one.'}
                      </p>
                    )}
                    {prepareError && (
                      <div role="alert" className="space-y-2 text-xs text-fail">
                        <p>{prepareError.message}</p>
                        {replacementRevision && (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => setFinishOpen(true)}>
                              View current draft
                            </Button>
                            <Button
                              size="sm"
                              disabled={locked || preparing || run.stale}
                              onClick={() =>
                                prepare({
                                  replace: true,
                                  expectedDraftRevision: replacementRevision,
                                })
                              }
                            >
                              Save a copy and replace
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    <p className="text-2xs text-fg-subtle">
                      {selected.length} selected for the summary. Findings are included in the
                      review body. Edit the summary and verdict before posting. Independent comments
                      are kept.
                    </p>
                  </div>
                </div>
              )}
            </AiCard>
          </>
        )}
      </FadeSwap>
      <Reveal show={starting || latest?.status === 'running' || latest?.status === 'queued'}>
        <p className="text-2xs text-fg-subtle">
          You can navigate away. This review will continue in the background.
        </p>
      </Reveal>
      {latest && run?.id !== latest.id && !ai.restartAt && (
        <p role={latest.status === 'failed' ? 'alert' : 'status'} className="text-xs text-fg-muted">
          {latest.status === 'failed'
            ? `The new review failed: ${latest.error}`
            : latest.status === 'cancelled'
              ? 'The new review was stopped.'
              : 'The new review was interrupted by a restart.'}{' '}
          Your previous completed review is still available above.
          {latest.resumable && (
            <Button size="sm" variant="ghost" onClick={() => ai.resume(latest.id)}>
              Resume saved review
            </Button>
          )}
        </p>
      )}
      {ai.startError('full_review') && (
        <p className="text-xs text-fail" role="alert">
          {ai.startError('full_review')!.message}
        </p>
      )}
      {ai.controlError && (
        <p role="alert" className="text-xs text-fail">
          {ai.controlError.message}
        </p>
      )}
      {/* Mounted while closed, like the Files tab's sheet, so closing can animate out. */}
      {review.draft.data && (
        <FinishSheet
          open={finishOpen}
          onOpenChange={setFinishOpen}
          draft={review.draft.data}
          account={account}
          ci={ci}
          viewedHeadOid={run?.headOid ?? headOid}
          saveMeta={(changes) => review.saveMeta.mutate(changes)}
          submit={(input) => review.submit.mutateAsync(input)}
          busy={review.submit.isPending}
          onSubmitted={() => {
            setFinishOpen(false);
            toast('Review queued', { action: { label: 'View activity', onClick: openActivity } });
            inbox?.advance();
          }}
          onReviewNewCommits={() => {
            setFinishOpen(false);
            toast('Run review again to review the new commits.');
          }}
        />
      )}
    </section>
  );
}
