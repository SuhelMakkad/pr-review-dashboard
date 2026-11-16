import type { FullReviewResult, SuggestedComment } from '@review-desk/shared/ai';
import { postedReviewMarker } from '@/ai/freshness.js';
import type { AiRunner } from '@/ai/runner.js';
import type { AiRunRow } from '@/db/schema.js';
import type { OperationQueue } from '@/operations/queue.js';
import type { SyncService } from '@/sync/service.js';

/** GitHub refuses comments longer than 65,536 characters; stay clear of the limit. */
const MAX_BODY = 65_000;
const TRUNCATED =
  '\n\n_The rest of this review was cut to fit on GitHub. It is complete in Review Desk._';

const severityLabels: Record<SuggestedComment['severity'], string> = {
  blocking: 'Blocking',
  suggestion: 'Suggestion',
  nit: 'Nit',
  question: 'Question',
};

/** One posting per run: retrying, recovering or finishing twice can never post it again. */
export const postedReviewOperationId = (runId: string) => `ai-review-${runId}`;

/**
 * The comment for a finished full review: its verdict and summary, any findings it tied to code,
 * and which commit it reviewed, since a conversation comment does not go out of date on GitHub.
 */
export function postedReviewBody(runId: string, headOid: string, result: FullReviewResult): string {
  const verdict =
    result.assessment === 'changes_requested' ? 'Changes recommended' : 'No blocking findings';
  const findings = result.comments.map((comment) => {
    const location = comment.line === null ? comment.path : `${comment.path}:${comment.line}`;

    return `**${severityLabels[comment.severity]}** · \`${location}\`\n\n${comment.body.trim()}`;
  });

  const marker = postedReviewMarker(runId);
  const footer = `<sub>Posted automatically by Review Desk when an AI review of ${headOid.slice(0, 7)} finished.</sub>`;
  const room = MAX_BODY - marker.length - footer.length - TRUNCATED.length - 4;
  let content = [`**AI review** · ${verdict}`, result.overall.trim(), ...findings]
    .filter(Boolean)
    .join('\n\n');

  if (content.length > room) content = content.slice(0, room).trimEnd() + TRUNCATED;

  return `${marker}\n${content}\n\n${footer}`;
}

/**
 * Posts each full review that finishes to its PR as one conversation comment, when Settings asks
 * for it. A comment, unlike a GitHub review, leaves your review request open. It goes through the
 * GitHub outbox like any other write, so Activity shows it, and the outbox skips it when new
 * commits arrive before it is sent.
 */
export class FindingsPoster {
  constructor(
    private readonly sync: SyncService,
    private readonly runner: AiRunner,
    private readonly operations: OperationQueue,
  ) {}

  /** Called when a run settles. Never throws. */
  finished(row: AiRunRow): void {
    try {
      if (row.task !== 'full_review' || row.status !== 'done' || !row.result) return;
      if (!this.runner.settings().postFindings) return;

      // Only the account that ran the review may post it; after a switch, the report stays here.
      if (row.account !== this.sync.status.account?.login) return;

      const result = JSON.parse(row.result) as FullReviewResult;

      this.operations.enqueue(row.account, row.prId, postedReviewOperationId(row.id), {
        type: 'ai_review',
        runId: row.id,
        expectedHeadOid: row.headOid,
        body: postedReviewBody(row.id, row.headOid, result),
      });
    } catch {
      // Not posted, for example because the PR is no longer tracked. The report stays in the
      // dashboard, where it can still be prepared and posted by hand.
    }
  }
}
