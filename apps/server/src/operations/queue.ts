import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  operationInProgress,
  operationUnsettled,
  showsViewedTarget,
  type ViewedTarget,
  type GitHubAction,
  type GitHubOperation,
  type OperationControl,
  type OperationList,
  type OperationReceipt,
} from '@review-desk/shared/operations';
import { forForge, isSameUser } from '@review-desk/shared/accounts';
import type { AiSettings } from '@review-desk/shared/ai';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import { postedReviewMarker, publicationFingerprint } from '@/ai/freshness.js';
import { githubOperations } from '@/db/schema.js';
import { DiffService } from '@/diff/service.js';
import type { GitHubApi } from '@/github/api.js';
import { asAccount } from '@/github/credentials.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { DraftStore } from '@/review/drafts.js';
import { ReviewError, ReviewService } from '@/review/service.js';
import type { SyncService } from '@/sync/service.js';
import type { MutationStep, OperationRecord } from './types.js';

const MUTATIONS = new Set([
  'approveReview',
  'addPendingReview',
  'addReviewThread',
  'submitReview',
  'deleteReview',
  'replyToThread',
  'setThreadResolved',
  'setFileViewed',
  'addConversationComment',
  'requestReviews',
]);
const CONTENT_ACTIONS = new Set(['review', 'comment', 'reply', 'discard', 'ai_review']);
const TERMINAL = ['succeeded', 'cancelled'] as const;
const now = () => new Date().toISOString();
const fingerprint = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/**
 * A viewed action with the diff it is about: as the page that sent it showed it, else (an older
 * page) the PR as stored now.
 */
function withTarget(action: GitHubAction, pr: PullRequestSnapshot): GitHubAction {
  if (action.type !== 'viewed' || action.target) return action;

  const fileKey = pr.files.find((file) => file.path === action.path)?.viewedKey;

  return {
    ...action,
    target: { headOid: pr.headOid, baseOid: pr.baseOid ?? null, ...(fileKey ? { fileKey } : {}) },
  };
}

/**
 * True when `pr` still shows the diff a viewed action is about: the file's own diff where the
 * forge identifies it, else the same head and base.
 */
function showsTarget(
  target: ViewedTarget | undefined,
  pr: PullRequestSnapshot | undefined,
  path: string,
): boolean {
  const file = pr?.files.find((candidate) => candidate.path === path);

  if (!target || !pr || !file) return false;

  return showsViewedTarget(
    target,
    { headOid: pr.headOid, baseOid: pr.baseOid ?? null },
    file.viewedKey,
  );
}

class Suspended extends Error {}
class Cancelled extends Error {}

type AiReviewAction = Extract<GitHubAction, { type: 'ai_review' }>;

/** What Settings allows automatic AI review posts to do, read again before every send. */
export type PostingSettings = Pick<
  AiSettings,
  'postFindings' | 'approveFindings' | 'resolveThreads'
>;

/** Why an automatic post must not go out now: as skipped before anything was sent, and after. */
interface PostProblem {
  skipped: string;
  code: string;
  attention: string;
  /** Waits for you even when nothing was sent yet. */
  hold?: true;
}

export interface QueueOptions {
  mutationIntervalMs?: number;
  retryDelaysMs?: number[];
}

/** SQLite is the outbox. A step is committed before its remote call and after its receipt. */
export class OperationQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private suspended = false;
  private opened = false;
  private closed = false;
  private holds = 0;
  private lastMutationAt = 0;
  private readonly refreshes = new Set<Promise<unknown>>();
  private readonly interval: number;
  private readonly retryDelays: number[];
  /** Set by the app to the AI settings; until then automatic posts are allowed nothing. */
  posting: () => PostingSettings = () => ({
    postFindings: false,
    approveFindings: false,
    resolveThreads: false,
  });

  constructor(
    private readonly sync: SyncService,
    options: QueueOptions = {},
  ) {
    this.interval = options.mutationIntervalMs ?? 1000;
    this.retryDelays = options.retryDelaysMs ?? [5000, 15000, 45000];
  }

  /**
   * Recovers actions a previous process left mid-send, then starts sending. Called once this
   * process owns the data directory, never from the constructor: a second launch must not touch
   * the rows of the process that is still running.
   */
  open(): void {
    if (this.opened || this.closed) return;

    this.opened = true;

    for (const { data } of this.db
      .select()
      .from(githubOperations)
      .where(inArray(githubOperations.status, ['running', 'checking']))
      .all()) {
      const uncertain = data.steps.some((step) => !step.completedAt && step.uncertain);

      this.save({
        ...data,
        status: uncertain ? 'checking' : 'queued',
        progress: uncertain
          ? 'Checking an interrupted GitHub request.'
          : 'Saved after a restart. Waiting to send.',
      });
    }

    this.wake();
  }

  private get db() {
    return this.sync.store.db;
  }

  private rows(account: string): OperationRecord[] {
    return this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(
        and(
          eq(githubOperations.account, account),
          inArray(githubOperations.status, [
            'queued',
            'running',
            'waiting',
            'checking',
            'needs_attention',
          ]),
        ),
      )
      .orderBy(asc(githubOperations.createdAt), asc(githubOperations.id))
      .all()
      .map((row) => row.data);
  }

  private row(account: string, id: string): OperationRecord {
    const row = this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(and(eq(githubOperations.account, account), eq(githubOperations.id, id)))
      .get();

    if (!row)
      throw new ReviewError('NOT_FOUND', 404, 'That action is unavailable for this account.');

    return row.data;
  }

  private assertAccount(account: string): void {
    if (!account || account !== this.sync.status.account?.login) {
      throw new ReviewError(
        'ACCOUNT_CHANGED',
        409,
        'GitHub account changed. Refresh before writing.',
      );
    }
  }

  private controls(row: OperationRecord): OperationControl[] {
    const controls: OperationControl[] = [];
    const started = row.steps.some((step) => step.uncertain || step.completedAt);

    if (['queued', 'waiting', 'running'].includes(row.status) && !started) controls.push('cancel');
    if (row.status !== 'needs_attention') return controls;

    const unsure = row.steps.filter((step) => step.uncertain && !step.completedAt);
    const uncertain = unsure.length > 0;
    // An automatic post's lost resolution is never inferred (see `reconcile`): checking cannot
    // settle it, and you can stop the rest, keeping the resolutions it confirmed.
    const unresolvable =
      row.action.type === 'ai_review' &&
      uncertain &&
      unsure.every((step) => step.method === 'setThreadResolved');

    if (uncertain && !unresolvable) controls.push('check');
    else if (uncertain) {
      // Nothing to retry until you look: the resolution may or may not have reached the forge.
    } else if (
      ![
        'HEAD_MOVED',
        'STALE_COMMENTS',
        'NOT_COMMENTABLE',
        'CHECKPOINT_CONFLICT',
        'ALREADY_SUBMITTED',
        'PENDING_REVIEW_CHANGED',
        // An automatic post stopped on what changed since its review: retrying stops again.
        'DISCUSSION_CHANGED',
        'BASE_CHANGED',
        'LEGACY_APPROVAL',
      ].includes(row.error?.code ?? '')
    )
      controls.push('retry');

    // Automatic posting has no local draft to restore; confirmed resolutions can be kept.
    if (
      !started ||
      (row.action.type === 'ai_review' && (!uncertain || unresolvable)) ||
      (uncertain && !this.pendingId(row) && !row.steps.some((step) => step.completedAt))
    )
      controls.push(row.action.type === 'ai_review' ? 'cancel' : 'reopen');
    // Cleanup is safe even after an uncertain comment: the cleanup job first verifies that the
    // known review is still pending and saves all of its remote content before deleting it.
    if (['review', 'comment'].includes(row.action.type) && this.pendingId(row))
      controls.push('restore');
    if (!row.dismissedAt) controls.push('dismiss');

    return controls;
  }

  private public(row: OperationRecord): GitHubOperation {
    const {
      requestKey: _key,
      attempts: _attempts,
      steps: _steps,
      pendingReviewBackup: _backup,
      ...operation
    } = row;

    // Messages are written for GitHub; a GitLab account's actions read as GitLab's.
    return {
      ...operation,
      progress: operation.progress && forForge(operation.progress, row.account),
      error: operation.error && {
        ...operation.error,
        message: forForge(operation.error.message, row.account),
      },
      controls: this.controls(row),
      ...(_backup
        ? { savedPendingReview: { body: _backup.body, comments: _backup.comments } }
        : {}),
    };
  }

  get(account: string, id: string): GitHubOperation {
    this.assertAccount(account);

    return this.public(this.row(account, id));
  }

  find(account: string, id: string): GitHubOperation | null {
    this.assertAccount(account);
    const row = this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(and(eq(githubOperations.account, account), eq(githubOperations.id, id)))
      .get();

    return row ? this.public(row.data) : null;
  }

  list(account: string, cursor?: string): OperationList {
    this.assertAccount(account);
    const [before, beforeId] = cursor?.split('|') ?? [];
    const page = this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(
        and(
          eq(githubOperations.account, account),
          inArray(githubOperations.status, [...TERMINAL]),
          before && beforeId
            ? or(
                lt(githubOperations.createdAt, before),
                and(eq(githubOperations.createdAt, before), lt(githubOperations.id, beforeId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(githubOperations.createdAt), desc(githubOperations.id))
      .limit(51)
      .all()
      .map((row) => row.data);
    const recent = page.slice(0, 50);
    const active = cursor ? [] : this.rows(account).filter((row) => operationUnsettled(row.status));
    const last = recent.at(-1);

    return {
      items: [...active, ...recent].map((row) => this.public(row)),
      nextCursor: page.length > 50 && last ? `${last.createdAt}|${last.id}` : null,
    };
  }

  enqueue(
    account: string,
    prId: string,
    id: string,
    action: GitHubAction,
    request: unknown = action,
  ): OperationReceipt {
    this.assertAccount(account);

    return this.insert(account, prId, id, action, request, () => this.sync.detail(prId)?.snapshot);
  }

  /**
   * Queues a finished AI review's post as the account that ran it, inside the caller's
   * transaction (the run's settlement), so the run is never saved done without it. Like every
   * row, it is sent only while that account is selected.
   */
  enqueueAutomatic(
    account: string,
    prId: string,
    id: string,
    action: AiReviewAction,
  ): OperationReceipt {
    return this.insert(account, prId, id, action, action, () => {
      const pr = this.sync.store.snapshot(account, prId);

      return pr?.state === 'OPEN' ? pr : undefined;
    });
  }

  private insert(
    account: string,
    prId: string,
    id: string,
    action: GitHubAction,
    request: unknown,
    lookup: () => PullRequestSnapshot | undefined,
  ): OperationReceipt {
    const requestKey = fingerprint({ prId, request });
    const existing = this.db
      .select({ data: githubOperations.data })
      .from(githubOperations)
      .where(and(eq(githubOperations.account, account), eq(githubOperations.id, id)))
      .get()?.data;

    if (existing) {
      if (existing.requestKey !== requestKey)
        throw new ReviewError(
          'OPERATION_CONFLICT',
          409,
          'This action ID was already used for different content.',
        );

      return { operation: this.public(existing) };
    }

    const pr = lookup();
    if (!pr) throw new ReviewError('NOT_FOUND', 404, 'This PR is no longer tracked.');

    const lastCreatedAt = this.db
      .select({ createdAt: githubOperations.createdAt })
      .from(githubOperations)
      .where(eq(githubOperations.account, account))
      .orderBy(desc(githubOperations.createdAt))
      .limit(1)
      .get()?.createdAt;
    const timestamp = new Date(
      Math.max(Date.now(), lastCreatedAt ? Date.parse(lastCreatedAt) + 1 : 0),
    ).toISOString();
    const row: OperationRecord = {
      id,
      account,
      prId,
      repository: pr.repository,
      number: pr.number,
      title: pr.title,
      prUrl: pr.url,
      action: structuredClone(withTarget(action, pr)),
      status: 'queued',
      progress: 'Saved. Waiting to send.',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
      retryAt: null,
      dismissedAt: null,
      error: null,
      result: null,
      steps: [],
      attempts: 0,
      requestKey,
    };

    this.sync.store.transaction(() => {
      const drafts = new DraftStore(this.sync.store);

      // Automatic posts never consume the local draft or its pending GitHub review.
      if (CONTENT_ACTIONS.has(action.type) && action.type !== 'ai_review')
        drafts.assertEditable(account, prId);

      if (action.type === 'review') {
        if (
          this.rows(account).some(
            (other) =>
              other.prId === prId &&
              operationUnsettled(other.status) &&
              CONTENT_ACTIONS.has(other.action.type),
          )
        ) {
          throw new ReviewError(
            'ACTION_PENDING',
            409,
            'Another action on this review needs to finish first. Open Activity.',
          );
        }

        if (action.draft.comments.some((comment) => comment.status === 'stale')) {
          throw new ReviewError(
            'STALE_COMMENTS',
            409,
            'Edit or remove comments on changed lines before submitting.',
          );
        }

        drafts.saveMeta(account, prId, { body: action.review.body, event: action.review.event });
        drafts.lock(account, prId, id);
      }

      if (action.type === 'discard') drafts.lock(account, prId, id);

      if (action.type === 'viewed') {
        for (const other of this.rows(account)) {
          if (
            other.prId === prId &&
            other.action.type === 'viewed' &&
            other.action.path === action.path &&
            ['queued', 'waiting'].includes(other.status) &&
            other.steps.length === 0
          ) {
            this.save({
              ...other,
              status: 'cancelled',
              finishedAt: timestamp,
              progress: 'Replaced by your newer viewed state.',
            });
          }
        }
      }

      this.db
        .insert(githubOperations)
        .values({ account, id, prId, status: row.status, createdAt: timestamp, data: row })
        .run();
    });

    // Inside a caller's transaction, nothing is announced or sent before it commits.
    this.sync.store.afterCommit(() => {
      this.emit(row);
      this.wake();
    });

    return { operation: this.public(row) };
  }

  private save(row: OperationRecord): OperationRecord {
    const next = { ...row, updatedAt: now() };

    this.db
      .update(githubOperations)
      .set({ status: next.status, data: next })
      .where(and(eq(githubOperations.account, row.account), eq(githubOperations.id, row.id)))
      .run();
    this.emit(next);

    return next;
  }

  private emit(row: OperationRecord): void {
    this.sync.events.emit({
      type: 'operation.updated',
      account: row.account,
      prId: row.prId,
      operationId: row.id,
      status: row.status,
    });
    this.sync.events.emit({ type: 'draft.updated', id: row.prId });
  }

  private pendingId(row: OperationRecord): string | null {
    const created = row.steps.find(
      (step) => step.method === 'addPendingReview' && step.completedAt,
    )?.result;

    return typeof created === 'string'
      ? created
      : row.action.type === 'review'
        ? row.action.draft.githubReviewId
        : null;
  }

  async control(
    account: string,
    id: string,
    command: OperationControl,
    confirmed = false,
  ): Promise<OperationReceipt> {
    this.assertAccount(account);
    const row = this.row(account, id);

    if (!this.controls(row).includes(command))
      throw new ReviewError(
        'ACTION_UNAVAILABLE',
        409,
        'This action is no longer available. Refresh Activity.',
      );
    const uncertain = row.steps.some((step) => step.uncertain);

    if (command === 'reopen' && uncertain && !confirmed)
      throw new ReviewError(
        'CONFIRM_REQUIRED',
        409,
        'Check GitHub and confirm this action did not post before reopening it.',
      );
    if (command === 'cancel' && uncertain && !confirmed)
      throw new ReviewError(
        'CONFIRM_REQUIRED',
        409,
        'Check GitHub before stopping: this action may already have posted.',
      );
    if (command === 'restore') return this.restore(row);

    if (command === 'check') {
      this.save({
        ...row,
        status: 'checking',
        dismissedAt: null,
        progress: 'Checking GitHub before retrying.',
      });
    } else if (command === 'retry') {
      this.save({
        ...row,
        status: 'queued',
        retryAt: null,
        error: null,
        attempts: 0,
        dismissedAt: null,
        progress: 'Waiting to retry the remaining steps.',
      });
    } else if (command === 'dismiss') {
      this.save({ ...row, dismissedAt: now() });
    } else {
      this.sync.store.transaction(() => {
        this.save({
          ...row,
          status: 'cancelled',
          finishedAt: now(),
          progress:
            command === 'reopen'
              ? 'Returned to your draft. Saved content is available here.'
              : row.action.type !== 'ai_review'
                ? 'Cancelled before sending. Your draft is preserved.'
                : uncertain
                  ? 'Stopped. Check GitHub: this review may already be posted.'
                  : 'Cancelled. Nothing was posted.',
        });
        new DraftStore(this.sync.store).unlock(account, row.prId, id);
      });
    }

    this.wake();

    return { operation: this.public(this.row(account, id)) };
  }

  private restore(row: OperationRecord): OperationReceipt {
    const reviewId = this.pendingId(row)!;
    const id = `${row.id}-restore`;
    const drafts = new DraftStore(this.sync.store);

    return this.sync.store.transaction(() => {
      drafts.unlock(row.account, row.prId, row.id);
      this.save({
        ...row,
        status: 'cancelled',
        finishedAt: now(),
        progress: 'Pending-review cleanup queued. Your content is preserved.',
      });

      return this.enqueue(row.account, row.prId, id, {
        type: 'discard',
        reviewId,
        restoreOperationId: row.id,
      });
    });
  }

  /** Schedules the next send. Nothing is sent before `open()` has recovered interrupted actions. */
  wake(): void {
    if (!this.opened || this.closed || this.suspended || this.holds > 0) return;
    if (this.active || this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = this.tick()
        .catch(() => {
          // A failed preflight is recorded on its operation. Keep the outbox alive after a local error.
        })
        .finally(() => {
          this.active = null;
          this.wake();
        });
    }, 100);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const account = this.sync.status.account?.login;
    if (!account) return;

    const rows = this.rows(account);
    const cooldown = this.sync.store.getSetting<string>(`github-write-retry:${account}`);
    if (
      Math.max(
        cooldown ? Date.parse(cooldown) : 0,
        this.sync.status.retryAt ? Date.parse(this.sync.status.retryAt) : 0,
      ) > Date.now()
    )
      return;

    const row = rows.find(
      (candidate, index) =>
        ['queued', 'waiting', 'checking'].includes(candidate.status) &&
        (!candidate.retryAt || Date.parse(candidate.retryAt) <= Date.now()) &&
        !rows
          .slice(0, index)
          .some((prior) => prior.prId === candidate.prId && operationUnsettled(prior.status)),
    );
    if (!row) return;

    // Each action is sent as the account that queued it, whatever is selected meanwhile.
    if (row.status === 'checking') await asAccount(row.account, () => this.reconcile(row));
    else await asAccount(row.account, () => this.execute(row));
  }

  private async execute(original: OperationRecord): Promise<void> {
    let row = this.save({
      ...original,
      status: 'running',
      retryAt: null,
      error: null,
      progress: 'Checking the GitHub account and pull request.',
    });

    try {
      const final = row.steps.at(-1);
      const finalMethods: Record<GitHubAction['type'], string[]> = {
        review: ['submitReview'],
        comment: ['submitReview', 'addConversationComment'],
        reply: ['replyToThread'],
        resolve: ['setThreadResolved'],
        viewed: ['setFileViewed'],
        reviewers: ['requestReviews'],
        discard: ['deleteReview'],
        ai_review: ['addConversationComment', 'approveReview'],
      };

      // A durable final receipt already proves success, even if the PR changed after a crash.
      if (final?.completedAt && finalMethods[row.action.type].includes(final.method)) {
        const receipt = final.result as { url?: string; pending?: boolean } | null;
        this.complete(
          row,
          row.action.type === 'review'
            ? { url: receipt?.url, submittedComments: row.action.draft.comments.length }
            : receipt,
        );
        return;
      }

      const identity = await this.sync.github.identity();
      if (identity.login.toLowerCase() !== row.account.toLowerCase())
        throw new ReviewError(
          'ACCOUNT_CHANGED',
          409,
          'The GitHub CLI account changed. Sign in to the original account before retrying.',
        );

      // A read started now: an older read still in flight can no longer be saved over it.
      const pr = (await this.sync.refresh(row.prId, row.account))?.snapshot;
      if (this.row(row.account, row.id).status === 'cancelled') return;

      // Posting was automatic, so an outdated review is skipped rather than left needing attention,
      // which would also hold back your own actions on the PR. Once a step may have gone out,
      // its receipts are replayed or checked first, and the next send stops on its own checks.
      if (
        row.action.type === 'ai_review' &&
        pr?.headOid !== row.action.expectedHeadOid &&
        !row.steps.some((step) => step.completedAt || step.uncertain)
      ) {
        this.save({
          ...row,
          status: 'cancelled',
          finishedAt: now(),
          progress: pr
            ? 'Not posted: new commits arrived after this review. Run it again to review them.'
            : 'Not posted: this PR is no longer tracked.',
        });
        return;
      }

      if (!pr) throw new ReviewError('NOT_FOUND', 404, 'This PR is no longer available.');

      const action = row.action;
      if (
        action.type === 'resolve' &&
        pr.threads.find((thread) => thread.id === action.threadId)?.isResolved === action.resolved
      ) {
        this.complete(row, null);
        return;
      }

      // A mark is for the diff you viewed; once the PR shows another, sending it would mark a diff
      // you have not seen. (GitLab also refuses it at the moment of the write.)
      if (
        action.type === 'viewed' &&
        action.viewed &&
        action.target &&
        !showsTarget(action.target, pr, action.path)
      ) {
        const gone = !pr.files.some((file) => file.path === action.path);

        this.save({
          ...row,
          status: 'cancelled',
          finishedAt: now(),
          progress: gone
            ? `Not marked viewed: ${action.path} is no longer part of this PR.`
            : `Not marked viewed: ${action.path} changed after you viewed it. Look at the new diff first.`,
        });
        return;
      }

      if (row.action.type === 'comment' && pr.headOid !== row.action.expectedHeadOid)
        throw new ReviewError(
          'HEAD_MOVED',
          409,
          'New commits were pushed. Review the comment location before sending.',
        );
      if (row.action.type === 'review' && pr.headOid !== row.action.review.expectedHeadOid)
        throw new ReviewError(
          'HEAD_MOVED',
          409,
          'New commits were pushed. Review them before submitting.',
        );

      const pendingId = this.pendingId(row);
      if (
        row.action.type === 'review' &&
        pr.pendingReview?.id &&
        pr.pendingReview.id !== pendingId
      ) {
        throw new ReviewError(
          'PENDING_REVIEW_CHANGED',
          409,
          'A different pending review appeared on GitHub. Return to your draft and check its contents before submitting.',
        );
      }
      if (pendingId && !row.pendingReviewBackup) {
        const backup = await this.sync.github.reviewReceipt(pendingId);
        if (
          row.action.type === 'review' &&
          backup?.state === 'PENDING' &&
          backup.commitOid &&
          backup.commitOid !== row.action.review.expectedHeadOid
        ) {
          throw new ReviewError(
            'HEAD_MOVED',
            409,
            'The pending GitHub review belongs to an older commit. Restore its draft and review the new commits.',
          );
        }
        if (backup) row = this.save({ ...row, pendingReviewBackup: backup });
      }

      if (
        ((row.action.type === 'review' && row.action.review.event === 'APPROVE') ||
          (row.action.type === 'ai_review' && row.action.event === 'APPROVE')) &&
        !row.approvalThreadIds
      ) {
        row = this.save({
          ...row,
          // An automatic approval resolves only the threads its review read open.
          approvalThreadIds:
            row.action.type === 'ai_review' && row.action.basis
              ? row.action.basis.threadIds
              : pr.threads.filter((thread) => !thread.isResolved).map((thread) => thread.id),
        });
      }

      let stepIndex = 0;
      const github = new Proxy(this.sync.github, {
        get: (target, property) => {
          const method = String(property);
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          if (!MUTATIONS.has(method)) return value.bind(target);

          return async (...args: unknown[]) => {
            const index = stepIndex++;
            row = this.row(row.account, row.id);
            if (row.status === 'cancelled') throw new Cancelled();
            const previous = row.steps[index];

            if (
              previous &&
              (previous.method !== method || fingerprint(previous.args) !== fingerprint(args))
            )
              throw new ReviewError(
                'CHECKPOINT_CONFLICT',
                409,
                'The saved execution no longer matches this request. Open GitHub before recovering.',
              );
            if (previous?.completedAt) return previous.result;
            if (previous?.uncertain)
              throw new ReviewError(
                'UNCONFIRMED',
                409,
                'The previous request may have reached GitHub. Check its result first.',
              );
            if (this.suspended || this.closed) throw new Suspended();
            if (this.row(row.account, row.id).status === 'cancelled') throw new Cancelled();

            const wait = Math.max(0, this.lastMutationAt + this.interval - Date.now());
            if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
            if (this.suspended || this.closed) throw new Suspended();

            const identity = await target.identity();
            if (
              identity.login.toLowerCase() !== row.account.toLowerCase() ||
              this.sync.status.account?.login !== row.account
            )
              throw new ReviewError(
                'ACCOUNT_CHANGED',
                409,
                'The GitHub account changed before sending. Sign in to the original account before retrying.',
              );
            // Commits, discussion and Settings can change after the check before sending, while
            // writes are paced. Every automatic post checks again right before it goes out.
            if (row.action.type === 'ai_review')
              row = await this.checkAutomaticPost(row, method, args);

            // The pacing wait and the account check above take time, and GitHub marks whichever
            // diff is current when the mark arrives: check the diff again right before it goes.
            if (
              method === 'setFileViewed' &&
              args[2] === true &&
              row.action.type === 'viewed' &&
              row.action.target
            ) {
              const pr = (await this.sync.refresh(row.prId, row.account))?.snapshot;

              row = this.row(row.account, row.id);
              if (row.status === 'cancelled') throw new Cancelled();

              if (
                row.action.type === 'viewed' &&
                row.action.target &&
                !showsTarget(row.action.target, pr, String(args[1]))
              ) {
                this.save({
                  ...row,
                  status: 'cancelled',
                  finishedAt: now(),
                  progress: `Not marked viewed: ${String(args[1])} changed after you viewed it. Look at the new diff first.`,
                });
                throw new Cancelled();
              }
            }

            if (
              method === 'submitReview' &&
              (row.action.type === 'review' || row.action.type === 'comment')
            ) {
              await this.sync.refresh(row.prId, row.account);
              const expected =
                row.action.type === 'review'
                  ? row.action.review.expectedHeadOid
                  : row.action.expectedHeadOid;
              if (this.sync.detail(row.prId)?.snapshot.headOid !== expected)
                throw new ReviewError(
                  'HEAD_MOVED',
                  409,
                  'New commits arrived while preparing this review. Your pending comments are saved; review the new commits before submitting.',
                );
            }

            row = this.row(row.account, row.id);
            if (row.status === 'cancelled') throw new Cancelled();
            // The checks above wait on GitHub; shutdown may have begun meanwhile. Nothing is sent
            // or checkpointed for this step yet, so it resumes on the next start.
            if (this.suspended || this.closed) throw new Suspended();

            const step: MutationStep = {
              method,
              args,
              startedAt: now(),
              completedAt: null,
              result: null,
              uncertain: true,
            };
            const steps = [...row.steps];
            steps[index] = step;
            row = this.save({ ...row, steps, progress: this.stepLabel(method, row) });
            this.lastMutationAt = Date.now();

            try {
              const result: unknown = await value.apply(target, args);
              steps[index] = {
                ...step,
                completedAt: now(),
                result: result ?? null,
                uncertain: false,
                acknowledged: true,
              };
              row = this.save({ ...row, steps });

              return result;
            } catch (error) {
              if (error instanceof GitHubError && error.outcome !== 'unknown') {
                steps[index] = { ...step, uncertain: false };
                row = this.save({ ...row, steps });
              }

              throw error;
            }
          };
        },
      }) as GitHubApi;
      const reviews = new ReviewService(
        this.sync,
        github,
        new DiffService(github),
        this.sync.events,
        {
          operationId: row.id,
          draft: row.action.type === 'review' ? row.action.draft : undefined,
          pendingReviewId: pendingId ?? undefined,
          approvalThreadIds: row.approvalThreadIds,
          assertActive: () => {
            if (this.row(row.account, row.id).status === 'cancelled') throw new Cancelled();
          },
        },
      );
      let result: GitHubOperation['result'] = null;

      switch (row.action.type) {
        case 'review': {
          const submitted = await reviews.submit(row.prId, {
            ...row.action.review,
            allowNewHead: false,
          });
          result = { url: submitted.reviewUrl, submittedComments: submitted.submittedComments };
          break;
        }
        case 'comment':
          result = await reviews.commentNow(row.prId, row.action.comment);
          break;
        case 'reply':
          result = await reviews.reply(row.account, row.prId, row.action.threadId, row.action.body);
          break;
        case 'resolve':
          await reviews.resolve(row.account, row.prId, row.action.threadId, row.action.resolved);
          break;
        case 'viewed': {
          const fileKey = row.action.viewed ? row.action.target?.fileKey : undefined;

          await reviews.setViewed(
            row.account,
            row.prId,
            row.action.path,
            row.action.viewed,
            ...(fileKey ? [{ fileKey }] : []),
          );
          break;
        }
        case 'reviewers':
          await reviews.requestReviewers(row.account, row.prId, row.action.logins);
          break;
        case 'discard': {
          const action = row.action;
          const backup = await this.sync.github.reviewReceipt(action.reviewId);
          if (backup && backup.state !== 'PENDING')
            throw new ReviewError(
              'ALREADY_SUBMITTED',
              409,
              'This review was submitted on GitHub. Its saved content is preserved in Activity.',
            );

          if (backup && !row.pendingReviewBackup) {
            if (backup) row = this.save({ ...row, pendingReviewBackup: backup });
          }

          if (backup) await github.deleteReview(action.reviewId);
          break;
        }
        case 'ai_review': {
          const action = row.action;

          if (action.event === 'APPROVE') {
            for (const threadId of row.approvalThreadIds ?? [])
              await github.setThreadResolved(threadId, true);
          }

          const posted =
            action.event === 'APPROVE'
              ? await github.approveReview(row.prId, action.expectedHeadOid, action.body)
              : await github.addConversationComment(row.prId, action.body);

          result = { url: posted.url };
          break;
        }
      }

      this.complete(this.row(row.account, row.id), result);
    } catch (error) {
      this.failed(this.row(row.account, row.id), error);
    }
  }

  /**
   * Right before each send of an automatic AI review post: what it does must still be allowed by
   * Settings, for the diff the PR shows and the discussion the review read. Before anything was
   * sent, a post that fails a check is skipped with the reason; after, the rest waits for you.
   */
  private async checkAutomaticPost(
    row: OperationRecord,
    method: string,
    args: unknown[],
  ): Promise<OperationRecord> {
    const action = row.action as AiReviewAction;
    const refreshed = (await this.sync.refresh(row.prId, row.account))?.snapshot;
    // The live merge base of the PR as just read, where its head and target are still the
    // reviewed ones (otherwise the checks below stop it anyway). A failed lookup is retried.
    const mergeBase =
      action.basis &&
      refreshed?.headOid === action.expectedHeadOid &&
      refreshed.baseRefName === action.basis.baseRefName
        ? await this.sync.github
            .compare(refreshed.repository, refreshed.baseRefName, refreshed.headOid)
            .then((comparison) => comparison?.mergeBaseOid ?? null)
        : null;

    // Everything below is read now, with no wait before the step is checkpointed: Settings
    // changed and snapshots saved during the lookups above count.
    row = this.row(row.account, row.id);
    if (row.status === 'cancelled') throw new Cancelled();
    if (row.action.type !== 'ai_review') return row;

    const stored = this.sync.store.snapshot(row.account, row.prId);
    const pr = stored?.state === 'OPEN' ? stored : undefined;
    const compared =
      pr?.headOid === refreshed?.headOid && pr?.baseRefName === refreshed?.baseRefName
        ? mergeBase
        : null;
    const problem = this.postProblem(row, row.action, pr, compared, method, args);

    if (!problem) return row;

    if (!problem.hold && !row.steps.some((step) => step.completedAt || step.uncertain)) {
      this.save({
        ...row,
        status: 'cancelled',
        finishedAt: now(),
        progress: `Not posted: ${problem.skipped}`,
      });
      throw new Cancelled();
    }

    throw new ReviewError(problem.code, 409, problem.attention);
  }

  /** Synchronous, so nothing it reads can change before the step it allows is checkpointed. */
  private postProblem(
    row: OperationRecord,
    action: AiReviewAction,
    pr: PullRequestSnapshot | undefined,
    mergeBase: string | null,
    method: string,
    args: unknown[],
  ): PostProblem | null {
    const approving = action.event === 'APPROVE';
    const stop = (skipped: string, code = 'POST_STOPPED'): PostProblem => ({
      skipped,
      code,
      attention: `${skipped.charAt(0).toUpperCase()}${skipped.slice(1)} Nothing more is sent; check the PR${approving ? ', then approve it yourself if it still applies' : ''}.`,
    });

    if (!pr) return stop('this PR is no longer tracked.', 'NOT_FOUND');
    if (pr.headOid !== action.expectedHeadOid)
      return stop(
        'new commits arrived after this review. Run it again to review them.',
        'HEAD_MOVED',
      );

    const basis = action.basis;
    const resolving = method === 'setThreadResolved';
    const settings = this.posting();

    if (!settings.postFindings) return stop('posting findings was turned off in Settings.');

    // Queued before Review Desk checked a review's inputs: comments still go out while posting
    // is on, but an approval or a resolution is yours to send.
    if (!basis)
      return approving || resolving
        ? {
            skipped: 'this approval was queued before Review Desk checked what a review read.',
            code: 'LEGACY_APPROVAL',
            hold: true,
            attention:
              'This automatic approval was queued before Review Desk checked what a review read. Nothing more is sent; check the PR, then approve it yourself if it still applies.',
          }
        : null;

    if (pr.baseRefName !== basis.baseRefName)
      return stop('the PR now targets another branch.', 'BASE_CHANGED');
    if (mergeBase !== basis.mergeBaseOid)
      return stop('the PR shows another diff than the one reviewed.', 'BASE_CHANGED');

    const resolved = new Set(
      row.steps
        .filter(
          (step) => step.method === 'setThreadResolved' && step.completedAt && step.acknowledged,
        )
        .map((step) => String(step.args[0])),
    );

    if (
      [...resolved].some((id) => !pr.threads.find((thread) => thread.id === id)?.isResolved) ||
      publicationFingerprint(pr, action.runId, row.account, resolved) !== basis.fingerprint
    )
      return stop(
        'the PR or its discussion changed after this review. Run it again to review it.',
        'DISCUSSION_CHANGED',
      );

    if (approving) {
      if (!basis.grants.approve || !settings.approveFindings)
        return stop('automatic approval was turned off in Settings.');
      if (pr.isDraft) return stop('the PR was turned into a draft.');
      if (isSameUser(pr.author.login, row.account)) return stop('you cannot approve your own PR.');
    }

    if (resolving) {
      const thread = pr.threads.find((candidate) => candidate.id === String(args[0]));

      if (!basis.grants.resolve || !settings.resolveThreads)
        return stop('resolving threads was turned off in Settings.');
      if (!basis.threadIds.includes(String(args[0])) || !thread || thread.isResolved)
        return stop(
          'the PR or its discussion changed after this review. Run it again to review it.',
          'DISCUSSION_CHANGED',
        );
      if (thread.viewerCanResolve === false)
        return stop('a thread this review read can no longer be resolved by you.');
    }

    return null;
  }

  private stepLabel(method: string, row: OperationRecord): string {
    if (method === 'addReviewThread' && row.action.type === 'review') {
      const completed = row.steps.filter(
        (step) => step.method === 'addReviewThread' && step.completedAt,
      ).length;

      return `Saving comment ${completed + 1} of ${row.action.draft.comments.filter((comment) => comment.status === 'draft').length} to your pending review.`;
    }

    if (row.action.type === 'ai_review')
      return method === 'setThreadResolved'
        ? 'Resolving open review threads before approving.'
        : row.action.event === 'APPROVE'
          ? 'Approving the PR with the AI review.'
          : 'Posting the AI review to the PR conversation.';

    return method === 'submitReview'
      ? 'Submitting your pending review to GitHub.'
      : 'Sending to GitHub.';
  }

  private complete(row: OperationRecord, result: GitHubOperation['result']): void {
    this.sync.store.transaction(() => {
      const drafts = new DraftStore(this.sync.store, row.id);

      if (row.action.type === 'review') drafts.clear(row.account, row.prId);
      if (row.action.type === 'discard') {
        if (row.action.restoreOperationId) {
          const parent = this.row(row.account, row.action.restoreOperationId);

          if (parent.action.type === 'review') {
            drafts.clear(row.account, row.prId);
            drafts.saveMeta(row.account, row.prId, {
              body: parent.action.draft.body,
              event: parent.action.draft.event,
            });

            for (const comment of parent.action.draft.comments) {
              const {
                id: _id,
                status: _status,
                createdAt: _created,
                updatedAt: _updated,
                githubThreadId: _thread,
                ...input
              } = comment;
              drafts.addComment(row.account, row.prId, input);
            }
          } else if (parent.action.type === 'comment') {
            const comment = parent.action.comment;
            drafts.addComment(row.account, row.prId, {
              ...comment,
              side: comment.side ?? 'RIGHT',
              startLine: comment.startLine ?? null,
              startSide: comment.startSide ?? null,
              subjectType: comment.line === null ? 'FILE' : 'LINE',
              origin: comment.origin ?? 'user',
              anchorOid: parent.action.expectedHeadOid,
            });
          }
        } else drafts.clear(row.account, row.prId);
      }

      drafts.unlock(row.account, row.prId, row.id);
      this.save({
        ...row,
        status: 'succeeded',
        result,
        error: null,
        finishedAt: now(),
        progress:
          row.action.type === 'discard'
            ? row.action.restoreOperationId
              ? 'Pending review removed. Your editable draft is restored.'
              : 'Pending review discarded.'
            : result?.pending
              ? 'Added to your pending review on GitHub.'
              : 'Confirmed by GitHub.',
      });
    });

    // Cache refresh is independent of the confirmed write and cannot turn it into a failure.
    const refresh = this.sync
      .refresh(row.prId, row.account)
      .catch(() => {})
      .finally(() => this.refreshes.delete(refresh));
    this.refreshes.add(refresh);
  }

  private failed(row: OperationRecord, error: unknown): void {
    if (row.status === 'cancelled' || error instanceof Cancelled) return;

    const uncertain = row.steps.some((step) => step.uncertain && !step.completedAt);
    if (error instanceof Suspended) {
      this.save({
        ...row,
        status: uncertain ? 'checking' : 'queued',
        progress: 'Saved. Execution will resume when the server starts.',
      });
      return;
    }

    if (uncertain) {
      this.save({
        ...row,
        status: 'checking',
        progress: 'The connection ended after sending. Checking GitHub before retrying.',
        error: { code: 'UNCONFIRMED', message: safeError(error) },
      });
      return;
    }

    // Uncertain mutations returned above. Transport failures here belong to safe reads or
    // definitely rejected calls; confirmed mutation checkpoints will not be sent again.
    const retryable =
      error instanceof GitHubError &&
      ['rate_limit', 'unavailable', 'unknown'].includes(error.outcome);
    if (error instanceof GitHubError && error.outcome === 'rate_limit') {
      this.sync.deferUntil(error.retryAt ?? new Date(Date.now() + 60_000).toISOString());
    }
    if (retryable && row.attempts < this.retryDelays.length) {
      const retryAt = new Date(
        Math.max(
          Date.now() + this.retryDelays[row.attempts],
          error.retryAt
            ? Date.parse(error.retryAt)
            : error.outcome === 'rate_limit'
              ? Date.now() + 60_000
              : 0,
        ),
      ).toISOString();

      if (error.outcome === 'rate_limit') this.sync.deferUntil(retryAt);
      this.save({
        ...row,
        status: 'waiting',
        attempts: row.attempts + 1,
        retryAt,
        progress: 'Waiting to retry. Your action is saved.',
        error: { code: error.outcome.toUpperCase(), message: safeError(error) },
      });
      return;
    }

    this.save({
      ...row,
      status: 'needs_attention',
      dismissedAt: null,
      progress:
        row.action.type === 'review' && this.pendingId(row)
          ? `${row.steps.filter((step) => step.method === 'addReviewThread' && step.completedAt).length + row.action.draft.comments.filter((comment) => comment.status === 'pushed').length} of ${row.action.draft.comments.length} inline comments saved to your pending review. Review not submitted.`
          : 'Action paused. Your content and confirmed progress are saved.',
      error: {
        code:
          error instanceof ReviewError
            ? error.code
            : error instanceof GitHubError
              ? error.outcome.toUpperCase()
              : 'GITHUB_ERROR',
        message: safeError(error),
      },
    });
  }

  private async reconcile(row: OperationRecord): Promise<void> {
    const step = row.steps.find((candidate) => candidate.uncertain && !candidate.completedAt);
    if (!step) {
      this.save({ ...row, status: 'queued', error: null });
      return;
    }

    try {
      const identity = await this.sync.github.identity();
      if (identity.login.toLowerCase() !== row.account.toLowerCase())
        throw new Error('Sign in to the original GitHub account before checking this action.');

      let confirmed = false;
      let result: unknown = null;

      if (step.method === 'submitReview') {
        const receipt = await this.sync.github.reviewReceipt(String(step.args[0]));
        const states: Record<string, string> = {
          APPROVE: 'APPROVED',
          COMMENT: 'COMMENTED',
          REQUEST_CHANGES: 'CHANGES_REQUESTED',
        };

        if (
          receipt?.state === states[String(step.args[1])] &&
          receipt.body === (step.args[2] ?? '')
        ) {
          confirmed = true;
          result = { id: receipt.id, url: receipt.url };
        } else if (receipt?.state === 'PENDING') {
          step.uncertain = false;
          this.save({
            ...row,
            status: 'needs_attention',
            progress: 'GitHub still has your pending review. You can retry submission.',
            error: {
              code: 'RETRY_SUBMISSION',
              message: 'The review has not been submitted. Its comments are preserved.',
            },
          });
          return;
        }
      } else if (step.method === 'deleteReview') {
        confirmed = (await this.sync.github.reviewReceipt(String(step.args[0]))) === null;
      } else if (step.method === 'approveReview' && row.action.type === 'ai_review') {
        await this.sync.refresh(row.prId, row.account);

        const action = row.action;
        const approved = this.sync
          .detail(row.prId)
          ?.snapshot.reviews.find(
            (review) =>
              review.state === 'APPROVED' &&
              review.commitOid === action.expectedHeadOid &&
              review.body === action.body,
          );

        if (approved) {
          confirmed = true;
          result = { id: approved.id, url: approved.url };
        }
      } else if (step.method === 'addConversationComment' && row.action.type === 'ai_review') {
        // The run's marker identifies the comment exactly. Absence is not proof: GitHub may not
        // list it yet, so an unfound comment stays unconfirmed rather than being sent again.
        const marker = postedReviewMarker(row.action.runId);

        await this.sync.refresh(row.prId, row.account);
        const posted = this.sync
          .detail(row.prId)
          ?.snapshot.conversation.find(
            (comment) =>
              isSameUser(comment.author.login, row.account) && comment.body.startsWith(marker),
          );

        if (posted) {
          confirmed = true;
          result = { id: posted.id, url: posted.url };
        }
      } else if (step.method === 'setThreadResolved' && row.action.type === 'ai_review') {
        // A resolved thread does not say who resolved it: assuming it was this post could
        // approve over someone else's resolution, and sending it again over their reopening.
        // It waits for you (`confirmed` stays false).
      } else if (step.method === 'setFileViewed' || step.method === 'setThreadResolved') {
        await this.sync.refresh(row.prId, row.account);
        const pr = this.sync.detail(row.prId)?.snapshot;

        const viewedState = pr?.files.find((file) => file.path === step.args[1])?.viewerViewedState;

        confirmed =
          step.method === 'setFileViewed'
            ? viewedState === (step.args[2] ? 'VIEWED' : 'UNVIEWED')
            : pr?.threads.find((thread) => thread.id === step.args[0])?.isResolved === step.args[1];

        // A mark is sent again only where the forge itself refuses it for another diff (GitLab,
        // given the file's diff), the PR still shows the diff you marked, and the file is not
        // viewed. Otherwise (GitHub, which marks whatever the file is now; changed since viewed;
        // a newer diff; a file no longer there; an action from before targets were recorded) it
        // could mark a diff nobody has seen, and assuming it was sent could lose it, so it stays
        // unconfirmed for you to check. An unmark holds for every diff: always safe to repeat.
        const bound =
          row.action.type === 'viewed' &&
          row.action.target?.fileKey !== undefined &&
          showsTarget(row.action.target, pr, String(step.args[1]));
        const ambiguous =
          step.method === 'setFileViewed' &&
          step.args[2] === true &&
          !confirmed &&
          !(viewedState === 'UNVIEWED' && bound);

        // These desired-state mutations are safe to repeat if GitHub has not reached that state.
        if (!confirmed && !ambiguous) {
          step.uncertain = false;
          this.save({ ...row, status: 'queued', error: null });
          return;
        }
      }

      if (confirmed) {
        step.completedAt = now();
        step.result = result;
        step.uncertain = false;
        this.save({
          ...row,
          status: 'queued',
          error: null,
          progress: 'GitHub confirmed the interrupted step. Resuming.',
        });
      } else {
        this.save({
          ...row,
          status: 'needs_attention',
          dismissedAt: null,
          progress: 'Unconfirmed. Open GitHub to verify before taking another action.',
          error: {
            code: 'UNCONFIRMED',
            message:
              'This request may have reached GitHub. Your saved content is available below; it will not be sent again automatically.',
          },
        });
      }
    } catch (error) {
      this.save({
        ...row,
        status: 'needs_attention',
        dismissedAt: null,
        progress: 'Could not confirm the GitHub result.',
        error: { code: 'UNCONFIRMED', message: safeError(error) },
      });
    }
  }

  async pause(): Promise<void> {
    this.suspended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    await this.active;
    await Promise.allSettled([...this.refreshes]);
  }

  resume(): void {
    this.suspended = false;
    this.wake();
  }

  /**
   * Lets the action being sent finish, without starting another, until the returned release is
   * called. Used while switching accounts, so no action is cut off halfway.
   */
  async hold(): Promise<() => void> {
    this.holds++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    await this.active;

    let released = false;

    return () => {
      if (released) return;

      released = true;
      this.holds--;
      this.wake();
    };
  }

  /** Actions queued as this account that are still being sent; they wait while it is not active. */
  inProgress(account: string): number {
    return this.rows(account).filter((row) => operationInProgress(row.status)).length;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pause();
  }
}
