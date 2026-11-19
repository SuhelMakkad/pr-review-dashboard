import { forgeOf, isSameUser } from '@review-desk/shared/accounts';
import { withoutQuickActions } from '@/gitlab/quick-actions.js';
import {
  hasBlockingFindings,
  unreadFiles,
  type FullReviewResult,
  type ReviewInputs,
  type SuggestedComment,
} from '@review-desk/shared/ai';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import { postedReviewMarker, publicationFingerprint } from '@/ai/freshness.js';
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

/** Says, first in the post, why a review without blocking findings did not approve. */
function coverageNote(inputs: ReviewInputs): string {
  if (inputs.inventory !== 'verified' || inputs.unreadableCount === 0)
    return '_Not approved automatically: Review Desk could not verify which files this review read._';

  const paths = [...new Set(inputs.unreadable.map((file) => file.path))];
  const shown = paths.slice(0, 10).map((path) => `\`${path}\``);
  const more = inputs.unreadableCount > inputs.unreadable.length || paths.length > 10;

  return `_Not approved automatically: ${unreadFiles(inputs)}${more ? '+' : ''} of ${inputs.changedFiles} changed files could not be read: ${shown.join(', ')}${more ? ', …' : ''}._`;
}

/**
 * The body for a finished full review: its verdict, summary, findings and reviewed commit, with
 * why it did not approve when its inputs were incomplete.
 */
export function postedReviewBody(
  runId: string,
  headOid: string,
  result: FullReviewResult,
  inputs?: ReviewInputs | null,
): string {
  const blocking = hasBlockingFindings(result);
  const verdict = blocking ? 'Changes recommended' : 'No blocking findings';
  const findings = result.comments.map((comment) => {
    const location = comment.line === null ? comment.path : `${comment.path}:${comment.line}`;

    return `**${severityLabels[comment.severity]}** · \`${location}\`\n\n${comment.body.trim()}`;
  });

  const marker = postedReviewMarker(runId);
  const note = !blocking && inputs && !inputs.complete ? coverageNote(inputs) : '';
  const footer = `<sub>Posted automatically by Review Desk when an AI review of ${headOid.slice(0, 7)} finished.</sub>`;
  const room = MAX_BODY - marker.length - footer.length - TRUNCATED.length - 4;
  let content = [note, `**AI review** · ${verdict}`, result.overall.trim(), ...findings]
    .filter(Boolean)
    .join('\n\n');

  if (content.length > room) content = content.slice(0, room).trimEnd() + TRUNCATED;

  return `${marker}\n${content}\n\n${footer}`;
}

/**
 * Decides, as a full review settles, what is posted about it, and queues the post in the same
 * transaction (see `AiRunner.onPublish`). It approves only a review without blocking findings
 * that read every changed file, where Settings allows approving; otherwise it posts a
 * conversation comment. Anything not posted is recorded with the reason. The outbox checks the
 * post again right before each send (`OperationQueue.checkAutomaticPost`).
 */
export class FindingsPublisher {
  constructor(
    private readonly sync: SyncService,
    private readonly runner: AiRunner,
    private readonly operations: OperationQueue,
  ) {}

  publish(row: AiRunRow, reviewed: PullRequestSnapshot): void {
    if (row.task !== 'full_review' || row.status !== 'done' || !row.result) return;

    const settings = this.runner.settings();

    if (!settings.postFindings) return;

    const skip = (reason: string) => this.runner.recordPublication(row.id, { skipped: reason });

    // Only the account that ran the review may post it, and only one selected as it finished.
    if (row.account !== this.sync.status.account?.login)
      return skip('Finished after you switched accounts.');

    const current = this.sync.store.snapshot(row.account, row.prId);

    if (!current || current.state !== 'OPEN') return skip('This PR is no longer tracked.');
    if (!row.inputs?.mergeBaseOid)
      return skip('Review Desk could not tell which commits this review read.');
    if (current.headOid !== row.headOid) return skip('New commits arrived while this review ran.');

    const fingerprint = publicationFingerprint(reviewed, row.id, row.account);

    if (publicationFingerprint(current, row.id, row.account) !== fingerprint)
      return skip('The PR or its discussion changed while this review ran.');

    const result = JSON.parse(row.result) as FullReviewResult;
    const blocking = hasBlockingFindings(result);
    const reason = blocking
      ? undefined
      : !row.inputs.complete
        ? 'The review could not read every changed file.'
        : !settings.approveFindings
          ? 'Approving is turned off in Settings.'
          : current.isDraft
            ? 'Draft PRs are not approved automatically.'
            : isSameUser(current.author.login, row.account)
              ? 'You cannot approve your own PR.'
              : undefined;
    const event = blocking || reason ? 'COMMENT' : 'APPROVE';
    const threadIds =
      event === 'APPROVE' && settings.resolveThreads
        ? reviewed.threads
            .filter((thread) => !thread.isResolved && thread.viewerCanResolve !== false)
            .map((thread) => thread.id)
        : [];
    const body = postedReviewBody(row.id, row.headOid, result, row.inputs);
    const operationId = postedReviewOperationId(row.id);

    this.operations.enqueueAutomatic(row.account, row.prId, operationId, {
      type: 'ai_review',
      runId: row.id,
      expectedHeadOid: row.headOid,
      event,
      // Generated text: on GitLab, no line of it may run as a quick action.
      body: forgeOf(row.account) === 'gitlab' ? withoutQuickActions(body) : body,
      basis: {
        baseRefName: reviewed.baseRefName,
        mergeBaseOid: row.inputs.mergeBaseOid,
        fingerprint,
        threadIds,
        grants: { approve: event === 'APPROVE', resolve: threadIds.length > 0 },
      },
    });
    this.runner.recordPublication(row.id, { operationId, event, ...(reason ? { reason } : {}) });
  }
}
