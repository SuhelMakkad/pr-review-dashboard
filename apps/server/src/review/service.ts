import { forgeOf, isSameUser } from '@review-desk/shared/accounts';
import { commentableLines, mapLine } from '@review-desk/shared/diff';
import type {
  DraftComment,
  NewDraftComment,
  ReviewDraft,
  ReviewEvent,
  SubmitReviewRequest,
  SubmitReviewResult,
} from '@review-desk/shared/review';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { DiffService } from '@/diff/service.js';
import { textPatch } from '@/diff/patch.js';
import type { EventBus } from '@/events.js';
import type { GitHubApi } from '@/github/api.js';
import { GitHubError, safeError } from '@/github/errors.js';
import type { ThreadInput } from '@/github/write.js';
import type { SyncService } from '@/sync/service.js';
import { DraftStore } from '@/review/drafts.js';
import { ReviewError } from '@/review/errors.js';
import { REQUEST_CHANGES_UNSUPPORTED } from '@/gitlab/write.js';
import type { FrozenReview } from '@review-desk/shared/operations';

export { ReviewError } from '@/review/errors.js';

const IDENTITY_TTL_MS = 30_000;
const WRITES_PER_MINUTE = 20;

/** A simple token bucket: GitHub limits content creation, and so do we, well below its limit. */
class RateLimiter {
  private stamps: number[] = [];

  constructor(private readonly perMinute: number) {}

  take(): void {
    const now = Date.now();

    this.stamps = this.stamps.filter((stamp) => now - stamp < 60_000);

    if (this.stamps.length >= this.perMinute) {
      throw new ReviewError(
        'RATE_LIMITED',
        429,
        'Too many GitHub writes in a minute. Try again shortly.',
      );
    }

    this.stamps.push(now);
  }
}

const toThread = (comment: DraftComment): ThreadInput => ({
  path: comment.path,
  body: comment.body,
  line: comment.subjectType === 'FILE' ? null : comment.line,
  side: comment.side,
  startLine: comment.startLine,
  startSide: comment.startSide,
  subjectType: comment.subjectType,
});

/**
 * Turns explicit user actions into GitHub writes: drafting comments locally, then submitting a
 * review as one resumable sequence, plus replies, resolutions and viewed state.
 */
export class ReviewService {
  readonly drafts: DraftStore;
  private readonly limiter = new RateLimiter(WRITES_PER_MINUTE);
  private identity: { login: string; at: number } | null = null;

  constructor(
    private readonly sync: SyncService,
    private readonly github: GitHubApi,
    private readonly diffs: DiffService,
    private readonly events: EventBus,
    private readonly execution?: {
      operationId: string;
      draft?: FrozenReview;
      pendingReviewId?: string;
      approvalThreadIds?: string[];
      assertActive?: () => void;
    },
  ) {
    this.drafts = new DraftStore(sync.store, execution?.operationId, execution?.assertActive);
  }

  /** Refuses writes for a stale account, re-checking the live gh login before anything is sent. */
  private async guard(account: string, live = false): Promise<void> {
    if (account !== this.sync.status.account?.login) {
      throw new ReviewError(
        'ACCOUNT_CHANGED',
        409,
        'GitHub account changed. Refresh before writing.',
      );
    }

    if (!live) return;

    if (!this.identity || Date.now() - this.identity.at > IDENTITY_TTL_MS) {
      this.identity = { login: (await this.github.identity()).login, at: Date.now() };
    }

    if (this.identity.login.toLowerCase() !== account.toLowerCase()) {
      throw new ReviewError(
        'ACCOUNT_CHANGED',
        409,
        `The GitHub CLI is now logged in as ${this.identity.login}. Nothing was posted.`,
      );
    }
  }

  private snapshot(prId: string): PullRequestSnapshot {
    const detail = this.sync.detail(prId);

    if (!detail) throw new ReviewError('NOT_FOUND', 404, 'This PR is no longer tracked.');

    return detail.snapshot;
  }

  private async write<T>(work: () => Promise<T>): Promise<T> {
    if (this.execution) return work();

    this.limiter.take();

    try {
      return await work();
    } catch (error) {
      if (error instanceof ReviewError) throw error;

      throw new ReviewError('GITHUB_ERROR', 502, safeError(error), {
        retryAt: error instanceof GitHubError ? error.retryAt : null,
      });
    }
  }

  private changed(prId: string) {
    this.events.emit({ type: 'draft.updated', id: prId });
  }

  private async refreshQuietly(prId: string): Promise<void> {
    try {
      await this.sync.refresh(prId);
    } catch {
      // The write succeeded; the next sync will catch up.
    }
  }

  draft(account: string, prId: string): ReviewDraft {
    const pr = this.snapshot(prId);
    const draft = this.drafts.draft(account, prId);

    return {
      prId,
      body: draft?.body ?? '',
      event: draft?.event ?? 'COMMENT',
      comments: draft?.comments ?? [],
      updatedAt: draft?.updatedAt ?? null,
      activeOperationId: draft?.activeOperationId ?? null,
      preparedReview: draft?.preparedReview ?? null,
      githubPendingReview: pr.pendingReview
        ? { id: pr.pendingReview.id, commentCount: pr.pendingReview.commentCount }
        : null,
    };
  }

  async saveDraft(
    account: string,
    prId: string,
    changes: { body?: string; event?: ReviewEvent },
  ): Promise<ReviewDraft> {
    await this.guard(account);
    this.snapshot(prId);
    this.drafts.saveMeta(account, prId, changes);
    this.changed(prId);

    return this.draft(account, prId);
  }

  /** GitHub only accepts line comments on lines that appear in the PR's diff. */
  private async assertCommentable(pr: PullRequestSnapshot, input: NewDraftComment): Promise<void> {
    if (input.line === null) return;

    const full = await this.diffs.manifest(pr, 'full', null);
    const file = full.files.find((candidate) => candidate.path === input.path);
    const lines = commentableLines(file?.patch);
    const visible = (input.side ?? 'RIGHT') === 'LEFT' ? lines.left : lines.right;
    const range = [input.startLine ?? input.line, input.line];

    if (!file || range.some((line) => !visible.has(line))) {
      throw new ReviewError(
        'NOT_COMMENTABLE',
        422,
        'GitHub only accepts comments on lines that are part of this PR’s diff. Comment on the whole file instead, or pick a changed line.',
      );
    }
  }

  async addComment(prId: string, input: NewDraftComment): Promise<DraftComment> {
    await this.guard(input.account);

    const pr = this.snapshot(prId);

    await this.assertCommentable(pr, input);

    const comment = this.drafts.addComment(input.account, prId, {
      path: input.path,
      line: input.line,
      side: input.side ?? 'RIGHT',
      startLine: input.startLine && input.startLine !== input.line ? input.startLine : null,
      startSide:
        input.startLine && input.startLine !== input.line
          ? (input.startSide ?? input.side ?? 'RIGHT')
          : null,
      subjectType: input.line === null ? 'FILE' : 'LINE',
      body: input.body,
      origin: input.origin ?? 'user',
      anchorOid: pr.headOid,
    });

    this.changed(prId);

    return comment;
  }

  async updateComment(
    account: string,
    prId: string,
    id: string,
    body: string,
  ): Promise<DraftComment> {
    await this.guard(account);

    const comment = this.drafts.comment(account, id);

    if (!comment) throw new ReviewError('NOT_FOUND', 404, 'That draft comment no longer exists.');
    if (comment.status === 'pushed') {
      throw new ReviewError(
        'ALREADY_SENT',
        409,
        'This comment is already on GitHub as part of your pending review.',
      );
    }

    this.drafts.updateComment(account, id, { body });
    this.changed(prId);

    return this.drafts.comment(account, id)!;
  }

  async deleteComment(account: string, prId: string, id: string): Promise<void> {
    await this.guard(account);
    this.drafts.deleteComment(account, id);
    this.changed(prId);
  }

  /** Throws away the local draft and any pending review an interrupted submit left on GitHub. */
  async discard(account: string, prId: string): Promise<void> {
    await this.guard(account);

    const draft = this.drafts.draft(account, prId);

    if (draft?.githubReviewId) {
      await this.guard(account, true);
      await this.write(() => this.github.deleteReview(draft.githubReviewId!));
    }

    this.drafts.clear(account, prId);
    this.changed(prId);
  }

  /**
   * Re-anchors draft comments written against an older head. Lines that changed cannot be mapped
   * automatically and are marked stale for the reviewer to fix.
   */
  private async reanchor(
    account: string,
    pr: PullRequestSnapshot,
    comments: DraftComment[],
  ): Promise<DraftComment[]> {
    const outdated = comments.filter(
      (comment) =>
        comment.status === 'draft' &&
        comment.anchorOid !== pr.headOid &&
        comment.subjectType === 'LINE',
    );
    const stale: DraftComment[] = [];
    const byAnchor = new Map<string, DraftComment[]>();

    for (const comment of outdated)
      byAnchor.set(comment.anchorOid, [...(byAnchor.get(comment.anchorOid) ?? []), comment]);

    for (const [anchor, group] of byAnchor) {
      const comparison = await this.github.compare(pr.repository, anchor, pr.headOid);
      const patches = new Map<string, string | null>();

      if (comparison?.status === 'ahead' || comparison?.status === 'identical') {
        for (const file of comparison.files) patches.set(file.path, file.patch ?? null);
      } else {
        const paths = [...new Set(group.map((comment) => comment.path))];
        const blobs = await this.github.blobs(pr.repository, [
          ...paths.map((path) => ({ oid: anchor, path })),
          ...paths.map((path) => ({ oid: pr.headOid, path })),
        ]);

        paths.forEach((path, index) => {
          const before = blobs[index]?.text;
          const after = blobs[index + paths.length]?.text;

          if (before === after) return;

          patches.set(
            path,
            before !== undefined && after !== undefined && before !== null && after !== null
              ? (textPatch(before, after)?.patch ?? null)
              : null,
          );
        });
      }

      for (const comment of group) {
        const patch = patches.get(comment.path);

        // Base-side lines and untouched files keep their numbers.
        if (comment.side === 'LEFT' || patch === undefined) {
          this.drafts.updateComment(account, comment.id, { anchorOid: pr.headOid });
          continue;
        }

        const line = patch ? mapLine(patch, comment.line!) : null;
        const start = comment.startLine && patch ? mapLine(patch, comment.startLine) : null;

        if (line === null || (comment.startLine && start === null)) {
          this.drafts.updateComment(account, comment.id, { status: 'stale' });
          stale.push(comment);
        } else {
          this.drafts.updateComment(account, comment.id, {
            line,
            startLine: start,
            anchorOid: pr.headOid,
          });
        }
      }
    }

    return stale;
  }

  /**
   * Refuses a verdict the account's forge cannot record, before anything is queued or written.
   * GitLab requests changes from 19.2 on; until a sync has read its version, it is assumed not to.
   */
  assertVerdictSupported(account: string, event: ReviewEvent): void {
    if (
      event === 'REQUEST_CHANGES' &&
      forgeOf(account) === 'gitlab' &&
      this.sync.status.capabilities?.requestChanges !== true
    )
      throw new ReviewError('UNSUPPORTED', 422, REQUEST_CHANGES_UNSUPPORTED);
  }

  async submit(prId: string, request: SubmitReviewRequest): Promise<SubmitReviewResult> {
    await this.guard(request.account, true);

    // Refused before resolving threads or saving comments.
    this.assertVerdictSupported(request.account, request.event);

    const refreshed = this.execution
      ? null
      : await this.sync.refresh(prId, request.account).catch((error: unknown) => {
          throw new ReviewError(
            'GITHUB_ERROR',
            502,
            `Could not check the PR before submitting: ${safeError(error)}`,
          );
        });
    const pr = refreshed?.snapshot ?? this.snapshot(prId);

    if (pr.headOid !== request.expectedHeadOid && !request.allowNewHead) {
      throw new ReviewError(
        'HEAD_MOVED',
        409,
        'New commits were pushed while you were reviewing.',
        {
          headOid: pr.headOid,
        },
      );
    }

    const account = request.account;

    this.drafts.saveMeta(account, prId, { body: request.body, event: request.event });

    const frozen = this.execution?.draft;
    const stale = await this.reanchor(
      account,
      pr,
      frozen?.comments ?? this.drafts.comments(account, prId),
    );
    const alreadyStale = this.drafts
      .comments(account, prId)
      .filter((comment) => comment.status === 'stale');

    if (stale.length || alreadyStale.length) {
      this.changed(prId);

      throw new ReviewError(
        'STALE_COMMENTS',
        409,
        'Some comments sit on lines that changed. Edit or remove them first.',
        {
          commentIds: [...new Set([...stale, ...alreadyStale].map((comment) => comment.id))],
        },
      );
    }

    const draft = this.drafts.draft(account, prId)!;
    const comments = frozen
      ? frozen.comments.map((comment) => {
          const anchored = draft.comments.find((candidate) => candidate.id === comment.id);

          return {
            ...comment,
            line: anchored?.line ?? comment.line,
            startLine: anchored?.startLine ?? comment.startLine,
          };
        })
      : draft.comments;

    return this.write(async () => {
      if (request.event === 'APPROVE') {
        const threadIds =
          this.execution?.approvalThreadIds ??
          pr.threads.filter((thread) => !thread.isResolved).map((thread) => thread.id);

        for (const threadId of threadIds) await this.github.setThreadResolved(threadId, true);
      }

      let reviewId = frozen
        ? frozen.githubReviewId
        : (draft.githubReviewId ?? pr.pendingReview?.id ?? null);

      if (!reviewId) {
        reviewId = await this.github.addPendingReview(prId, pr.headOid);
        this.drafts.saveMeta(account, prId, { githubReviewId: reviewId });
      }

      // Each comment is recorded as it lands, so a retry after a failure never duplicates it.
      for (const comment of comments.filter((candidate) => candidate.status === 'draft')) {
        const threadId = await this.github.addReviewThread(reviewId, toThread(comment));

        this.drafts.updateComment(account, comment.id, {
          status: 'pushed',
          githubThreadId: threadId,
        });
      }

      const review = await this.github.submitReview(reviewId, request.event, request.body);

      if (!this.execution) {
        this.drafts.clear(account, prId);
        this.changed(prId);
      }
      if (!this.execution) await this.refreshQuietly(prId);

      return { reviewUrl: review.url, submittedComments: comments.length };
    });
  }

  async commentNow(prId: string, input: NewDraftComment): Promise<{ url: string }> {
    await this.guard(input.account, true);

    const pr = this.snapshot(prId);

    if (input.path) {
      await this.assertCommentable(pr, input);

      if (pr.pendingReview && pr.pendingReview.id !== this.execution?.pendingReviewId) {
        throw new ReviewError(
          'PENDING_REVIEW_EXISTS',
          409,
          'You have a pending review on GitHub. Add this comment to your review instead.',
        );
      }
    }

    const result = await this.write(() =>
      input.path && this.execution
        ? (async () => {
            const reviewId = await this.github.addPendingReview(prId, pr.headOid);

            await this.github.addReviewThread(reviewId, {
              ...input,
              subjectType: input.line === null ? 'FILE' : 'LINE',
            });

            return this.github.submitReview(reviewId, 'COMMENT', '');
          })()
        : input.path
          ? this.github.commentNow(prId, pr.headOid, {
              path: input.path,
              body: input.body,
              line: input.line,
              side: input.side,
              startLine: input.startLine,
              startSide: input.startSide,
              subjectType: input.line === null ? 'FILE' : 'LINE',
            })
          : this.github.addConversationComment(prId, input.body),
    );

    if (!this.execution) await this.refreshQuietly(prId);

    return { url: result.url };
  }

  async reply(
    account: string,
    prId: string,
    threadId: string,
    body: string,
  ): Promise<{ url: string; pending: boolean }> {
    await this.guard(account, true);
    this.snapshot(prId);

    const result = await this.write(() => this.github.replyToThread(threadId, body));

    if (!this.execution) await this.refreshQuietly(prId);

    return { url: result.url, pending: result.pending };
  }

  async resolve(account: string, prId: string, threadId: string, resolved: boolean): Promise<void> {
    await this.guard(account, true);
    this.snapshot(prId);
    await this.write(() => this.github.setThreadResolved(threadId, resolved));
    if (!this.execution) await this.refreshQuietly(prId);
  }

  /** Asks reviewers (again) on one of your own PRs. */
  async requestReviewers(account: string, prId: string, logins: string[]): Promise<void> {
    await this.guard(account, true);

    const pr = this.snapshot(prId);

    if (!isSameUser(pr.author.login, account)) {
      throw new ReviewError(
        'NOT_AUTHOR',
        403,
        'You can only request reviewers on your own PRs here.',
      );
    }

    await this.write(() => this.github.requestReviews(prId, logins));
    if (!this.execution) await this.refreshQuietly(prId);
  }

  async setViewed(
    account: string,
    prId: string,
    path: string,
    viewed: boolean,
    expected?: { fileKey: string },
  ): Promise<void> {
    await this.guard(account, true);

    // Fails with NOT_FOUND before writing when the PR is not tracked.
    this.snapshot(prId);

    // Called with exactly the arguments it needs, so checkpoints of older actions still match.
    const revision = await this.write(() =>
      expected
        ? this.github.setFileViewed(prId, path, viewed, expected)
        : this.github.setFileViewed(prId, path, viewed),
    );

    // Onto the latest stored PR and the reads that started before the write, where they show the
    // revision the forge marked. Elsewhere the forge's own state stands; the refresh that follows
    // every confirmed action brings it in.
    this.sync.markViewed(account, prId, path, viewed, revision ?? null);
  }
}
