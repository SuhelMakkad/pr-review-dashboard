import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { FullReviewResult } from '../../../shared/ai';
import type { CiState } from '../../../shared/types';
import { Button } from '../../ui/Button';
import { MarkdownView } from '../../ui/Markdown';
import { FinishSheet } from '../review/FinishSheet';
import { useReview } from '../review/useReview';
import { AiCard } from './AssistPanel';
import { useAi, useAiOverview } from './useAi';

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
  const run = ai.latest('full_review');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [finishOpen, setFinishOpen] = useState(false);
  const result = run?.status === 'done' ? (run.result as FullReviewResult | null) : null;
  const codex = overview.data?.providers.find((provider) => provider.id === 'codex');
  const selected =
    result?.comments.flatMap((_, index) => (excluded.has(`${run!.id}:${index}`) ? [] : [index])) ??
    [];
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
    <section aria-label="Codex review" className="space-y-3">
      {!run ? (
        <div className="space-y-3 rounded-md border border-ai/40 bg-ai/[0.03] p-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-ai">
              <Sparkles size={14} aria-hidden="true" /> Full Codex review
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              Review the complete PR with repository context. Results stay here until you choose to
              post.
            </p>
          </div>
          <Button
            size="sm"
            icon={
              ai.start.isPending ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Sparkles size={13} />
              )
            }
            disabled={ai.start.isPending || codex?.available === false}
            onClick={launch}
          >
            {ai.start.isPending ? 'Preparing review…' : 'Run Codex review'}
          </Button>
          {codex?.available === false && (
            <p className="text-xs text-fail">
              {codex.reason} Install and log in to Codex, then refresh Settings.
            </p>
          )}
        </div>
      ) : (
        <AiCard
          run={run}
          title="Full Codex review"
          onCancel={() => ai.cancel.mutate(run.id)}
          onRerun={launch}
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
              <MarkdownView>{result.overall}</MarkdownView>
              {result.comments.map((comment, index) => (
                <article
                  key={index}
                  className="space-y-2 rounded-sm border border-line bg-panel p-3"
                >
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={!excluded.has(`${run.id}:${index}`)}
                      aria-label={`Include finding ${index + 1}`}
                      disabled={run.stale || ai.prepare.isPending}
                      onChange={(event) =>
                        setExcluded((current) => {
                          const next = new Set(current);

                          if (event.target.checked) next.delete(`${run.id}:${index}`);
                          else next.add(`${run.id}:${index}`);

                          return next;
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
                  New commits arrived. Regenerate this review before posting.
                </p>
              )}
              <div className="space-y-1.5 border-t border-line pt-3">
                <Button size="sm" disabled={run.stale || ai.prepare.isPending} onClick={prepare}>
                  {ai.prepare.isPending ? 'Preparing draft…' : 'Prepare GitHub review'}
                </Button>
                <p className="text-2xs text-fg-subtle">
                  {selected.length} selected. Edit the summary and choose a verdict before posting.
                  Existing draft comments are kept.
                </p>
              </div>
            </div>
          )}
        </AiCard>
      )}
      {ai.start.error && (
        <p className="text-xs text-fail" role="alert">
          {ai.start.error.message}
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
            toast('Run Codex review again to review the new commits.');
          }}
        />
      )}
    </section>
  );
}
