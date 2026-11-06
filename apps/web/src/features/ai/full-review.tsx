import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { codexBlocked, type FullReviewResult } from '../../../../../packages/shared/src/ai';
import type { CiState } from '../../../../../packages/shared/src/types';
import { dateTime } from '../../lib/time';
import { Button } from '../../ui/button';
import { MarkdownView } from '../../ui/markdown';
import { FinishSheet } from '../review/finish-sheet';
import { useReview } from '../review/use-review';
import { AiCard } from './assist-panel';
import { useAi, useAiOverview } from './use-ai';

/** A complete review stays on the dashboard until the user explicitly prepares and posts it. */
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
  const overview = useAiOverview();
  const review = useReview(prId, account);
  const latest = ai.latest('full_review');
  const run =
    latest && ['failed', 'cancelled', 'interrupted'].includes(latest.status)
      ? (ai.completed('full_review') ?? latest)
      : latest;
  const starting = ai.isStarting('full_review');
  const [selection, setSelection] = useState<{ runId: string; indices: number[] } | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const result = run?.status === 'done' ? (run.result as FullReviewResult | null) : null;
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
  const prepareError = ai.preparation?.status === 'error' ? ai.preparation.error : null;
  const launch = () => ai.start.mutate({ task: 'full_review', force: Boolean(run) });
  const target = {
    owner: repository.split('/')[0],
    repo: repository.split('/')[1],
    number: String(number),
  };

  const prepare = () => {
    if (!run) return;
    ai.prepare.mutate(
      { runId: run.id, indices: selected },
      {
        onSuccess: () => setFinishOpen(true),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <section aria-label="Full review" className="space-y-3">
      {!run && ai.runs.isPending ? (
        <p role="status" className="text-xs text-fg-muted">
          Loading saved review…
        </p>
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
              Find issues across the complete PR. Review the findings before posting.
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
              <Link to="/settings" className="underline">
                Settings
              </Link>
              .
            </p>
          )}
        </div>
      ) : (
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
                className={`text-xs font-medium ${result.assessment === 'changes_requested' ? 'text-pending' : 'text-ok'}`}
              >
                {result.assessment === 'changes_requested'
                  ? 'Changes recommended'
                  : 'No blocking findings'}
                {' · '}
                {result.comments.length} {result.comments.length === 1 ? 'finding' : 'findings'}
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
              {result.comments.map((comment, index) => (
                <article
                  key={index}
                  className="space-y-2 rounded-sm border border-line bg-panel p-3"
                >
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={selected.includes(index)}
                      aria-label={`Include finding ${index + 1}`}
                      disabled={run.stale || preparing}
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
                        comment.severity === 'blocking' ? 'font-medium text-fail' : 'text-fg-muted'
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
                </article>
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
                  disabled={run.stale || preparing}
                  aria-busy={preparing}
                  onClick={prepare}
                >
                  {preparing
                    ? 'Preparing draft…'
                    : reusable
                      ? 'Use prepared review'
                      : 'Prepare GitHub review'}
                </Button>
                {preparing && (
                  <p role="status" className="text-xs text-fg-muted">
                    Preparing your GitHub review. You can navigate away; preparation will continue.
                  </p>
                )}
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
                  <p role="alert" className="text-xs text-fail">
                    {prepareError.message}
                  </p>
                )}
                <p className="text-2xs text-fg-subtle">
                  {selected.length} selected. Edit the summary and choose a verdict before posting.
                  Existing draft comments are kept.
                </p>
              </div>
            </div>
          )}
        </AiCard>
      )}
      {(starting || latest?.status === 'running' || latest?.status === 'queued') && (
        <p className="text-2xs text-fg-subtle">
          You can navigate away. This review will continue in the background.
        </p>
      )}
      {latest && run?.id !== latest.id && (
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
      {finishOpen && review.draft.data && (
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
            toast('Review posted to GitHub');
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
