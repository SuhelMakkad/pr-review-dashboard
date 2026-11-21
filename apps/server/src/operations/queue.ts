import { performance } from 'node:perf_hooks';
import {
  fingerprint as intentFingerprint,
  fullyReceipted,
  intended,
  intentProblem,
  isLegacy,
  literal,
  matches,
  type StepIntent,
} from '@/operations/intent.js';
import { render, renderStored, say, wordingOf, type Wording } from '@/messages.js';
import { isoNow, type Cancel, type Clock } from '@/clock.js';
import { createHash } from 'node:crypto';
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
import { isSameUser } from '@review-desk/shared/accounts';
import type { AiSettings } from '@review-desk/shared/ai';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import { postedReviewMarker, publicationFingerprint } from '@/ai/freshness.js';
import { DiffService } from '@/diff/service.js';
import type { GitHubApi, ReviewReceipt } from '@/github/api.js';
import { accountCheck, bindForge, declaredTraits } from '@/forge/bind.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { DraftStore } from '@/db/drafts.js';
import { ReviewError, ReviewService } from '@/review/service.js';
import { accountNotActive } from '@/review/errors.js';
import type { SyncService } from '@/sync/service.js';
import type { MutationStep, OperationRecord } from './types.js';
import { WRITE_COOLDOWN } from '@/db/settings.js';
import { AccountUnavailable, unattributed } from '@/forge/account.js';

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

/** True once an automatic approval's own approval step has its receipt. */
function approvedAlready(row: OperationRecord): boolean {
  return row.steps.some((step) => step.method === 'approveReview' && step.completedAt);
}

/** True for the summary an automatic approval sends after it, where they are two steps. */
function isSummary(action: AiReviewAction, method: string): boolean {
  return action.event === 'APPROVE' && method === 'addConversationComment';
}

/** The write an automatic post sends next: its approval until that went out, then its text. */
function nextPostMethod(row: OperationRecord): string {
  const approved = row.steps.some((step) => step.method === 'approveReview' && step.completedAt);

  return row.action.type === 'ai_review' && row.action.event === 'APPROVE' && !approved
    ? 'approveReview'
    : 'addConversationComment';
}

/**
 * Your approval of the head an automatic approval is for, as the PR shows it. Where approvals
 * carry their text (GitHub), a review is one submission on one commit. Where they are read from
 * their own notes (GitLab), the approval's commit is the version that was current when its note
 * was made; a review there groups nearby notes and can take another note's commit, so it never
 * counts, and an approval without its note says no commit at all.
 */
function approvalOf(
  row: OperationRecord,
  pr: PullRequestSnapshot | undefined,
  carries: boolean,
): { id: string; url: string } | undefined {
  const action = row.action as AiReviewAction;

  if (carries)
    return pr?.reviews.find(
      (review) => review.state === 'APPROVED' && review.commitOid === action.expectedHeadOid,
    );

  const verdict = pr?.verdicts?.find(
    (candidate) =>
      candidate.id &&
      isSameUser(candidate.login, row.account) &&
      candidate.state === 'APPROVED' &&
      candidate.commitOid === action.expectedHeadOid,
  );

  return verdict ? { id: verdict.id!, url: row.prUrl } : undefined;
}

/** An automatic post stopped for `skipped`: as said before anything was sent, and after. */
function stopped(
  skipped: Wording,
  approving: boolean,
  code = 'POST_STOPPED',
  /** The approval already went out and only its summary is stopped. */
  summary = false,
): PostProblem {
  return {
    skipped,
    code,
    attention: summary
      ? say('stop.summary-held', { reason: skipped })
      : approving
        ? say('stop.nothing-more-approving', { reason: skipped })
        : say('stop.nothing-more', { reason: skipped }),
  };
}

/** Why an automatic post must not go out now: as skipped before anything was sent, and after. */
interface PostProblem {
  skipped: Wording;
  code: string;
  attention: Wording;
  /** Waits for you even when nothing was sent yet. */
  hold?: true;
  /** Not known yet: tried again like a failed read, rather than stopping the post. */
  retry?: true;
}

export interface QueueOptions {
  mutationIntervalMs?: number;
  retryDelaysMs?: number[];
}

/** SQLite is the outbox. A step is committed before its remote call and after its receipt. */
/** An action ID already used, for different content or by another kind of write. */
const conflict = () =>
  new ReviewError(
    'OPERATION_CONFLICT',
    409,
    'This action ID was already used for different content.',
  );

export class OperationQueue {
  private cancelWake: Cancel | null = null;
  private active: Promise<void> | null = null;
  private suspended = false;
  private opened = false;
  private closed = false;
  private holds = 0;
  /** When the last mutation was sent, on the monotonic clock; null before the first. */
  private lastMutationAt: number | null = null;
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

  /** The app's clock, shared with the sync. */
  private get clock(): Clock {
    return this.sync.clock;
  }

  /**
   * Recovers actions a previous process left mid-send, then starts sending. Called once this
   * process owns the data directory, never from the constructor: a second launch must not touch
   * the rows of the process that is still running.
   */
  open(): void {
    if (this.opened || this.closed) return;

    this.opened = true;

    for (const data of this.log.interrupted()) {
      const uncertain = data.steps.some((step) => !step.completedAt && step.uncertain);

      this.save({
        ...data,
        status: uncertain ? 'checking' : 'queued',
        progress: uncertain
          ? say('outbox.checking-interrupted')
          : 'Saved after a restart. Waiting to send.',
      });
    }

    this.wake();
  }

  /** The outbox's rows, as saved (`db/operations.ts`). */
  private get log() {
    return this.sync.store.operations;
  }

  private rows(account: string): OperationRecord[] {
    return this.log.active(account);
  }

  /** A forge operation, as Activity shows it: a local receipt is unavailable, as an unknown ID. */
  private row(account: string, id: string): OperationRecord {
    const row = this.log.visible(account, id);

    if (!row)
      throw new ReviewError('NOT_FOUND', 404, 'That action is unavailable for this account.');

    return row;
  }

  /** Refuses new work for an account other than the one in use: nothing is queued or changed. */
  private assertSelected(account: string): void {
    const selected = this.sync.status.account?.login ?? null;

    if (!account || account !== selected) throw accountNotActive(account, selected);
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
      unsure.every(
        (step) =>
          step.method === 'setThreadResolved' ||
          // A split approval (GitLab), which no approval on the PR can be told to be: see
          // `reconcile`.
          (step.method === 'approveReview' && step.args[2] === ''),
      );

    if (uncertain && !unresolvable && row.error?.code !== 'CHECKPOINT_CONFLICT')
      controls.push('check');
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
      // An automatic post has no draft to go back to: whatever is unconfirmed, you can stop the
      // rest (after confirming), keeping the receipts it has.
      row.action.type === 'ai_review' ||
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
      intent: _intent,
      pendingReviewBackup: _backup,
      ...operation
    } = row;

    // Each message is worded for the row's account, selected or not.
    return {
      ...operation,
      progress: renderStored(operation.progress, row.account),
      error: operation.error && {
        ...operation.error,
        message: renderStored(operation.error.message, row.account),
      },
      controls: this.controls(row),
      ...(this.mayHavePosted(row) ? { confirmStop: true } : {}),
      ...(_backup
        ? { savedPendingReview: { body: _backup.body, comments: _backup.comments } }
        : {}),
    };
  }

  /** Any account's action, selected or not: reading it changes nothing. */
  get(account: string, id: string): GitHubOperation {
    return this.public(this.row(account, id));
  }

  /** Any account's forge action by ID, or null when there is none; never a local receipt. */
  find(account: string, id: string): GitHubOperation | null {
    const row = this.log.visible(account, id);

    return row ? this.public(row) : null;
  }

  /**
   * The receipt of an action already accepted under `id`, for any account, selected or not: a
   * retry of one never does anything new. It must be the same action, on the same target, or the
   * ID was used for something else. Null when there is none.
   */
  replay(
    account: string,
    id: string,
    expected: { prId: string; request: unknown; type: GitHubAction['type']; threadId?: string },
  ): OperationReceipt | null {
    const existing = this.existing(account, id);

    if (!existing) return null;

    // A local write's ID can never become a forge operation's (see `replayedLocally`).
    if (existing.kind === 'local') throw conflict();

    this.assertSame(existing, expected);

    return { operation: this.public(existing) };
  }

  /**
   * True when `id` is the receipt of a local write for this same request, which then answers as
   * it did the first time, whatever has changed since: a retry of a discard never deletes a draft
   * made after it. A forge operation's ID is not one; any other request for this one is refused.
   */
  replayedLocally(
    account: string,
    id: string,
    expected: { prId: string; request: unknown; type: GitHubAction['type'] },
  ): boolean {
    const existing = this.existing(account, id);

    if (existing?.kind !== 'local') return false;

    this.assertSame(existing, expected);

    return true;
  }

  /**
   * Makes a local write that answers the outbox ID `id`, such as discarding a draft with nothing
   * on the forge: `write` makes it, or returns false when the forge has to take part after all.
   * The ID lookup, the write and its receipt commit together; the receipt is kept as long as
   * outbox rows, so a retry of `id` replays it (`replayedLocally`).
   */
  writeLocally(
    account: string,
    prId: string,
    id: string,
    action: GitHubAction,
    request: unknown,
    write: () => boolean,
  ): boolean {
    return this.sync.store.transaction(() => {
      // Taken meanwhile, as a forge operation or a local receipt: never written twice.
      if (this.existing(account, id)) throw conflict();
      if (!write()) return false;

      const at = isoNow(this.clock);

      this.log.insert({
        id,
        account,
        prId,
        kind: 'local',
        // Never read from the PR cache: a draft clears even when its cached PR is unreadable, or
        // gone. Activity never shows a receipt, so nothing needs these.
        repository: '',
        number: 0,
        title: '',
        prUrl: '',
        action: structuredClone(action),
        status: 'succeeded',
        progress: 'Done here; nothing was sent.',
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
        retryAt: null,
        dismissedAt: null,
        error: null,
        result: null,
        steps: [],
        attempts: 0,
        requestKey: fingerprint({ prId, request }),
      });

      return true;
    });
  }

  private existing(account: string, id: string): OperationRecord | undefined {
    return this.log.find(account, id);
  }

  /** The request key as legacy routes made it, plus the action's type and thread. */
  private assertSame(
    existing: OperationRecord,
    expected: { prId: string; request: unknown; type: GitHubAction['type']; threadId?: string },
  ): void {
    const threadOf = (action: GitHubAction) =>
      action.type === 'reply' || action.type === 'resolve' ? action.threadId : undefined;

    if (
      existing.requestKey !== fingerprint({ prId: expected.prId, request: expected.request }) ||
      existing.action.type !== expected.type ||
      threadOf(existing.action) !== expected.threadId
    )
      throw conflict();
  }

  list(account: string, cursor?: string): OperationList {
    const [before, beforeId] = cursor?.split('|') ?? [];
    const page = this.log.finished(
      account,
      [...TERMINAL],
      before && beforeId ? { createdAt: before, id: beforeId } : null,
      51,
    );
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
    return this.insert(
      account,
      prId,
      id,
      action,
      request,
      () => this.sync.detailFor(account, prId)?.snapshot,
      // Only new work needs the account in use; a replay above it returns its receipt.
      () => this.assertSelected(account),
    );
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
    admit: () => void = () => undefined,
  ): OperationReceipt {
    const requestKey = fingerprint({ prId, request });
    const existing = this.existing(account, id);

    // A local write's ID can never become a forge operation's.
    if (existing?.kind === 'local') throw conflict();

    if (existing) {
      this.assertSame(existing, {
        prId,
        request,
        type: action.type,
        ...(action.type === 'reply' || action.type === 'resolve'
          ? { threadId: action.threadId }
          : {}),
      });

      return { operation: this.public(existing) };
    }

    admit();

    const pr = lookup();
    if (!pr) throw new ReviewError('NOT_FOUND', 404, say('pull.untracked'));

    const lastCreatedAt = this.log.latestCreatedAt(account);
    const timestamp = new Date(
      Math.max(this.clock.now(), lastCreatedAt ? Date.parse(lastCreatedAt) + 1 : -Infinity),
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

      this.log.insert(row);
    });

    // Inside a caller's transaction, nothing is announced or sent before it commits.
    this.sync.store.afterCommit(() => {
      this.emit(row);
      this.wake();
    });

    return { operation: this.public(row) };
  }

  private save(row: OperationRecord): OperationRecord {
    const next = { ...row, updatedAt: isoNow(this.clock) };

    this.log.update(next);
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
    this.sync.events.emit({ type: 'draft.updated', account: row.account, id: row.prId });
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
    // Stopping or hiding an action changes nothing on the forge: any account's can be. The rest
    // schedule forge work, so they need the account in use.
    if (command !== 'cancel' && command !== 'dismiss') this.assertSelected(account);

    const row = this.row(account, id);

    if (!this.controls(row).includes(command))
      throw new ReviewError(
        'ACTION_UNAVAILABLE',
        409,
        'This action is no longer available. Refresh Activity.',
      );
    const uncertain = this.mayHavePosted(row);

    if (command === 'reopen' && uncertain && !confirmed)
      throw new ReviewError('CONFIRM_REQUIRED', 409, say('outbox.confirm-reopen'));
    if (command === 'cancel' && uncertain && !confirmed)
      throw new ReviewError('CONFIRM_REQUIRED', 409, say('outbox.confirm-stop'));
    if (command === 'restore') return this.restore(row);

    if (command === 'check') {
      this.save({
        ...row,
        status: 'checking',
        dismissedAt: null,
        progress: say('outbox.checking-before-retry'),
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
      this.save({ ...row, dismissedAt: isoNow(this.clock) });
    } else {
      this.sync.store.transaction(() => {
        this.save({
          ...row,
          status: 'cancelled',
          finishedAt: isoNow(this.clock),
          progress:
            command === 'reopen'
              ? 'Returned to your draft. Saved content is available here.'
              : row.action.type !== 'ai_review'
                ? 'Cancelled before sending. Your draft is preserved.'
                : this.refusedCombined(row)
                  ? 'Stopped. Check GitLab: the approval may have gone out without its summary.'
                  : uncertain && approvedAlready(row)
                    ? say('outbox.stopped-approved')
                    : uncertain
                      ? say('outbox.stopped-unconfirmed')
                      : approvedAlready(row)
                        ? say('outbox.cancelled-approved')
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
        finishedAt: isoNow(this.clock),
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
    if (this.active || this.cancelWake) return;

    // The one timer that does not keep the process alive, as before.
    this.cancelWake = this.clock.after(
      100,
      () => {
        this.cancelWake = null;
        this.active = this.tick()
          .catch(() => {
            // A failed preflight is recorded on its operation. Keep the outbox alive after a local error.
          })
          .finally(() => {
            this.active = null;
            this.wake();
          });
      },
      { unref: true },
    );
  }

  private async tick(): Promise<void> {
    const account = this.sync.status.account?.login;
    if (!account) return;

    const rows = this.rows(account);
    const cooldown = this.sync.store.settings.get(WRITE_COOLDOWN.of(account));
    if (
      Math.max(
        cooldown ? Date.parse(cooldown) : -Infinity,
        this.sync.status.retryAt ? Date.parse(this.sync.status.retryAt) : -Infinity,
      ) > this.clock.now()
    )
      return;

    const row = rows.find(
      (candidate, index) =>
        ['queued', 'waiting', 'checking'].includes(candidate.status) &&
        (!candidate.retryAt || Date.parse(candidate.retryAt) <= this.clock.now()) &&
        !rows
          .slice(0, index)
          .some((prior) => prior.prId === candidate.prId && operationUnsettled(prior.status)),
    );
    if (!row) return;

    // Checked before anything is sent or reconciled: reconciling an unfinished step could hide
    // that a later one was sent before it.
    const problem = row.intent ? intentProblem(row.intent, row.steps) : null;

    if (problem) {
      this.holdConflict(row, problem);

      return;
    }

    // Each action is sent as the account that queued it, whatever is selected meanwhile.
    const forge = this.forge(row.account);

    if (row.status === 'checking') await this.reconcile(row, forge);
    else await this.execute(row, forge);
  }

  /**
   * Holds a row whose receipts are not its declared writes: it needs your attention, and nothing
   * more is sent or checked for it. Saved directly, so an uncertain step cannot send it back to
   * checking.
   */
  private holdConflict(row: OperationRecord, problem: string): void {
    this.save({
      ...row,
      status: 'needs_attention',
      dismissedAt: null,
      retryAt: null,
      progress: say('outbox.held', { reason: problem }),
      error: { code: 'CHECKPOINT_CONFLICT', message: say('outbox.checkpoint-conflict') },
    });
  }

  /**
   * The writes that end the action: its last declared write, on success, must be one of them.
   * An automatic approval sent in two steps ends with its summary, not the approval.
   */
  private finalMethods(row: OperationRecord): string[] {
    const finals: Record<GitHubAction['type'], string[]> = {
      review: ['submitReview'],
      comment: ['submitReview', 'addConversationComment'],
      reply: ['replyToThread'],
      resolve: ['setThreadResolved'],
      viewed: ['setFileViewed'],
      reviewers: ['requestReviews'],
      discard: ['deleteReview'],
      ai_review: ['addConversationComment', 'approveReview'],
    };

    return row.action.type === 'ai_review'
      ? [
          row.action.event === 'APPROVE' && row.plan !== 2
            ? 'approveReview'
            : 'addConversationComment',
        ]
      : finals[row.action.type];
  }

  /**
   * Refuses to call an action done before it has sent all it declared: every declared write
   * receipted, the last the action's terminal one. A row from before intents keeps its old
   * completion; one that declared nothing completes only where its path settles with nothing to
   * send.
   */
  private assertSettled(row: OperationRecord, nothingToSend: boolean): void {
    if (isLegacy(row)) return;

    if (!row.intent) {
      if (nothingToSend) return;

      throw new ReviewError('PLAN_MISSING', 409, say('outbox.plan-missing'));
    }

    if (
      !fullyReceipted(row.intent, row.steps) ||
      !this.finalMethods(row).includes(row.intent.steps.at(-1)?.method ?? '')
    )
      throw new ReviewError('PLAN_INCOMPLETE', 409, say('outbox.plan-incomplete'));
  }

  /**
   * Records, for a declared write whose effect is already on the forge (a thread already resolved,
   * a pending review already gone), a receipt verified from that state, at the first unfinished
   * step: nothing is sent. It must be the write declared there.
   */
  private settleDeclared(row: OperationRecord, verified: StepIntent): OperationRecord {
    const index = row.steps.findIndex((step) => !step.completedAt);
    const at = index === -1 ? row.steps.length : index;
    const args = verified.args.map((arg) => ('value' in arg ? arg.value : undefined));

    if (!row.intent || !matches(row.intent.steps[at], verified.method, args, row.steps))
      throw new ReviewError('CHECKPOINT_CONFLICT', 409, say('outbox.checkpoint-conflict'));

    const now = isoNow(this.clock);
    const steps = [...row.steps];

    steps[at] = {
      method: verified.method,
      args,
      startedAt: now,
      completedAt: now,
      result: null,
      uncertain: false,
    };

    return this.save({ ...row, steps });
  }

  /** The forge, with every call made as `account` (see `GitHubApi.as`). */
  private forge(account: string): GitHubApi {
    return bindForge(this.sync.github, account);
  }

  /**
   * A review's receipt, read as `account`. glab signs each request in with its own sign-in, so the
   * read counts only between two checks that it is still that account: a sign-in change around it
   * fails the read (`AccountUnavailable`), so another user's drafts never answer for this account.
   */
  private async checkedReceipt(
    forge: GitHubApi,
    account: string,
    id: string,
    /** True where an identity check has just opened the bracket (reconciliation's). */
    opened = false,
  ): Promise<ReviewReceipt | null> {
    // A limit met by a check itself cannot be tied to the account: it is nobody's cooldown.
    const check = async () =>
      accountCheck(forge)?.(account).catch((error: unknown) => Promise.reject(unattributed(error)));

    if (!opened) await check();

    let receipt: ReviewReceipt | null;

    try {
      receipt = await forge.reviewReceipt(id);
    } catch (error) {
      if (error instanceof AccountUnavailable) throw error;

      // A limit the read met is the account's only if glab is still signed in as it.
      const confirmed = await check().then(
        () => true,
        () => false,
      );

      throw confirmed ? error : unattributed(error);
    }

    await check();

    return receipt;
  }

  private async execute(original: OperationRecord, forge: GitHubApi): Promise<void> {
    let row = this.save({
      ...original,
      status: 'running',
      retryAt: null,
      error: null,
      progress: say('outbox.checking-account'),
    });

    // Decided once, as execution starts: a row from before intents replays its steps by position.
    const legacy = isLegacy(row);

    /**
     * Records the writes a path declares before its first: once, then each retry must declare the
     * same. A legacy row takes none.
     */
    const declare = (writes: StepIntent[]) => {
      if (legacy) return;

      const current = this.row(row.account, row.id);

      if (current.status === 'cancelled') throw new Cancelled();
      if (current.intent) {
        if (intentFingerprint(current.intent.steps) !== intentFingerprint(writes))
          throw new ReviewError('CHECKPOINT_CONFLICT', 409, say('outbox.checkpoint-conflict'));

        row = current;

        return;
      }

      row = this.save({ ...current, intent: { version: 1, steps: writes } });
    };

    try {
      const final = row.steps.at(-1);

      // A durable final receipt already proves success, even if the PR changed after a crash: for
      // an intent row, only once every declared write has its receipt.
      if (
        final?.completedAt &&
        this.finalMethods(row).includes(final.method) &&
        (!row.intent || fullyReceipted(row.intent, row.steps))
      ) {
        const receipt = final.result as { url?: string; pending?: boolean } | null;
        this.complete(
          row,
          row.action.type === 'review'
            ? { url: receipt?.url, submittedComments: row.action.draft.comments.length }
            : receipt,
        );
        return;
      }

      // An automatic post Settings no longer allows stops before anything is read for it, and
      // when a read fails, rather than waiting ahead of your own actions on the PR. A combined
      // approval the forge refused is first checked for what went out (`planApproval`).
      const combined = this.refusedCombined(row);
      const allowed = () => {
        if (row.action.type !== 'ai_review') return;

        const action = row.action;

        this.stopFor(
          this.row(row.account, row.id),
          this.settingsProblem(action, nextPostMethod(row), false),
        );
      };

      if (!combined) allowed();

      const preflight = async () => {
        const identity = await forge.identity();
        if (identity.login.toLowerCase() !== row.account.toLowerCase())
          throw new ReviewError('ACCOUNT_CHANGED', 409, say('outbox.cli-account-changed'));

        // A read started now: an older read still in flight can no longer be saved over it.
        return (await this.sync.refresh(row.prId, row.account, forge))?.snapshot;
      };
      const pr = await preflight().catch((error: unknown) => {
        this.coolDown(row.account, error);
        if (!combined) allowed();

        throw error;
      });
      if (this.row(row.account, row.id).status === 'cancelled') return;

      const planned = await this.planApproval(forge, row, pr);

      if (!planned) return;
      row = planned;

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
          finishedAt: isoNow(this.clock),
          progress: pr
            ? 'Not posted: new commits arrived after this review. Run it again to review them.'
            : say('outbox.untracked'),
        });
        return;
      }

      if (!pr) throw new ReviewError('NOT_FOUND', 404, say('pull.unavailable'));

      const action = row.action;
      // Already in the wanted state: nothing to send. Once declared, its write is receipted from
      // that state.
      if (
        action.type === 'resolve' &&
        pr.threads.find((thread) => thread.id === action.threadId)?.isResolved === action.resolved
      ) {
        if (row.intent)
          row = this.settleDeclared(
            row,
            intended('setThreadResolved', literal(action.threadId), literal(action.resolved)),
          );

        this.complete(row, null, !row.intent);
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
          finishedAt: isoNow(this.clock),
          progress: gone
            ? say('outbox.viewed-file-gone', { path: action.path })
            : say('outbox.viewed-file-changed', { path: action.path }),
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
        throw new ReviewError('PENDING_REVIEW_CHANGED', 409, say('outbox.pending-review-changed'));
      }
      if (pendingId && !row.pendingReviewBackup) {
        const backup = await this.checkedReceipt(forge, row.account, pendingId);
        if (
          row.action.type === 'review' &&
          backup?.state === 'PENDING' &&
          backup.commitOid &&
          backup.commitOid !== row.action.review.expectedHeadOid
        ) {
          throw new ReviewError('HEAD_MOVED', 409, say('outbox.pending-review-outdated'));
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
      const github = new Proxy(forge, {
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

            // Steps are made in order: one past the end would leave a gap.
            if (index > row.steps.length)
              throw new ReviewError('CHECKPOINT_CONFLICT', 409, say('outbox.checkpoint-conflict'));

            // Every write of a row that is not legacy is the one declared at its index.
            if (!legacy) {
              if (!row.intent)
                throw new ReviewError('PLAN_MISSING', 409, say('outbox.plan-missing'));
              if (!matches(row.intent.steps[index], method, args, row.steps))
                throw new ReviewError(
                  'CHECKPOINT_CONFLICT',
                  409,
                  say('outbox.checkpoint-conflict'),
                );
            }

            if (
              previous &&
              (previous.method !== method || fingerprint(previous.args) !== fingerprint(args))
            )
              throw new ReviewError('CHECKPOINT_CONFLICT', 409, say('outbox.checkpoint-conflict'));
            if (previous?.completedAt) return previous.result;
            if (previous?.uncertain)
              throw new ReviewError('UNCONFIRMED', 409, say('outbox.previous-unconfirmed'));
            if (this.suspended || this.closed) throw new Suspended();
            if (this.row(row.account, row.id).status === 'cancelled') throw new Cancelled();

            // Spacing is elapsed time, not wall time: a clock change cannot stall a send.
            const wait =
              this.lastMutationAt === null
                ? 0
                : Math.max(0, this.lastMutationAt + this.interval - performance.now());
            if (wait) await new Promise<void>((resolve) => this.clock.after(wait, resolve));
            if (this.suspended || this.closed) throw new Suspended();

            const identity = await target.identity();
            if (
              identity.login.toLowerCase() !== row.account.toLowerCase() ||
              this.sync.status.account?.login !== row.account
            )
              throw new ReviewError(
                'ACCOUNT_CHANGED',
                409,
                say('outbox.account-changed-before-sending'),
              );
            // Commits, discussion and Settings can change after the check before sending, while
            // writes are paced. Every automatic post checks again right before it goes out.
            if (row.action.type === 'ai_review')
              row = await this.checkAutomaticPost(forge, row, method, args);

            // The pacing wait and the account check above take time, and GitHub marks whichever
            // diff is current when the mark arrives: check the diff again right before it goes.
            if (
              method === 'setFileViewed' &&
              args[2] === true &&
              row.action.type === 'viewed' &&
              row.action.target
            ) {
              const pr = (await this.sync.refresh(row.prId, row.account, forge))?.snapshot;

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
                  finishedAt: isoNow(this.clock),
                  progress: say('outbox.viewed-file-changed', { path: String(args[1]) }),
                });
                throw new Cancelled();
              }
            }

            if (
              method === 'submitReview' &&
              (row.action.type === 'review' || row.action.type === 'comment')
            ) {
              await this.sync.refresh(row.prId, row.account, forge);
              const expected =
                row.action.type === 'review'
                  ? row.action.review.expectedHeadOid
                  : row.action.expectedHeadOid;
              if (this.sync.detailFor(row.account, row.prId)?.snapshot.headOid !== expected)
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
              startedAt: isoNow(this.clock),
              completedAt: null,
              result: null,
              uncertain: true,
            };
            const steps = [...row.steps];
            steps[index] = step;
            row = this.save({ ...row, steps, progress: this.stepLabel(method, row) });
            this.lastMutationAt = performance.now();

            let result: unknown;

            // Only the write itself can be refused: what follows its receipt never undoes it.
            try {
              result = await value.apply(target, args);
            } catch (error) {
              if (error instanceof GitHubError && error.outcome !== 'unknown') {
                steps[index] = { ...step, uncertain: false };
                row = this.save({ ...row, steps });
              }

              throw error;
            }

            steps[index] = {
              ...step,
              completedAt: isoNow(this.clock),
              result: result ?? null,
              uncertain: false,
              acknowledged: true,
            };
            row = this.save({ ...row, steps });

            // The approval this post just gave, named while nothing else can have replaced it:
            // its summary goes only with that one.
            if (method === 'approveReview' && args[2] === '' && row.action.type === 'ai_review')
              row = await this.bindApproval(forge, row);

            return result;
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
          intend: declare,
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
          const backup = await this.checkedReceipt(forge, row.account, action.reviewId);

          // The read took time: a cancellation meanwhile stands.
          row = this.row(row.account, row.id);
          if (row.status === 'cancelled') throw new Cancelled();

          if (backup && backup.state !== 'PENDING')
            throw new ReviewError('ALREADY_SUBMITTED', 409, say('outbox.already-submitted'));

          if (backup && !row.pendingReviewBackup)
            row = this.save({ ...row, pendingReviewBackup: backup });

          const deletion = intended('deleteReview', literal(action.reviewId));

          // No pending review to delete: nothing to send, or, once declared, its write receipted.
          if (!backup) {
            if (row.intent) row = this.settleDeclared(row, deletion);

            this.complete(row, null, !row.intent);
            return;
          }

          declare([deletion]);
          await github.deleteReview(action.reviewId);
          break;
        }
        case 'ai_review': {
          const action = row.action;
          const posts =
            action.event !== 'APPROVE'
              ? [intended('addConversationComment', literal(row.prId), literal(action.body))]
              : row.plan === 2
                ? [
                    intended(
                      'approveReview',
                      literal(row.prId),
                      literal(action.expectedHeadOid),
                      literal(''),
                    ),
                    intended('addConversationComment', literal(row.prId), literal(action.body)),
                  ]
                : [
                    intended(
                      'approveReview',
                      literal(row.prId),
                      literal(action.expectedHeadOid),
                      literal(action.body),
                    ),
                  ];

          declare([
            ...(action.event === 'APPROVE' ? (row.approvalThreadIds ?? []) : []).map((threadId) =>
              intended('setThreadResolved', literal(threadId), literal(true)),
            ),
            ...posts,
          ]);

          if (action.event === 'APPROVE') {
            for (const threadId of row.approvalThreadIds ?? [])
              await github.setThreadResolved(threadId, true);
          }

          let posted: { url: string };

          if (action.event !== 'APPROVE') {
            posted = await github.addConversationComment(row.prId, action.body);
          } else if (row.plan === 2) {
            // Two writes, each with its own checkpoint and receipt: a summary GitLab refuses, or
            // a lost response, can never hide whether the approval went out.
            await github.approveReview(row.prId, action.expectedHeadOid, '');
            posted = await github.addConversationComment(row.prId, action.body);
          } else {
            posted = await github.approveReview(row.prId, action.expectedHeadOid, action.body);
          }

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
   * True when something of this action may be on the forge without a receipt here: a step whose
   * response was lost, or a combined approval the forge refused, which may have approved without
   * its summary.
   */
  private mayHavePosted(row: OperationRecord): boolean {
    return row.steps.some((step) => step.uncertain) || this.refusedCombined(row);
  }

  /**
   * True for a row from before plans were versioned that sent an approval and its summary in one
   * step, which the forge answered with an error: the approval may have gone out without it.
   */
  private refusedCombined(row: OperationRecord): boolean {
    const action = row.action;
    const step = row.steps.find((candidate) => candidate.method === 'approveReview');

    return Boolean(
      action.type === 'ai_review' &&
      action.event === 'APPROVE' &&
      !row.plan &&
      !declaredTraits(this.forge(row.account)).approvalCarriesSummary &&
      step &&
      !step.completedAt &&
      !step.uncertain,
    );
  }

  /**
   * Where the forge's approval carries no summary (GitLab), an automatic approval is sent as two
   * steps, the approval and then its summary (plan 2). A row from before plans were versioned
   * sent both in one `approveReview` step. One the forge refused may have approved without its
   * summary, and GitLab's history cannot always tell a send that failed from an approval since
   * withdrawn, so nothing of it is sent again. Both on the PR (the summary found through every
   * page) means done; anything else waits for you, unconfirmed. A step whose response was lost
   * is left to `reconcile`. Null when the row is settled here.
   */
  private async planApproval(
    forge: GitHubApi,
    row: OperationRecord,
    pr: PullRequestSnapshot | undefined,
  ): Promise<OperationRecord | null> {
    const action = row.action;

    if (action.type !== 'ai_review' || action.event !== 'APPROVE') return row;
    if (declaredTraits(forge).approvalCarriesSummary) return row;

    const unsent = !row.steps.some((step) => step.method === 'approveReview');
    // Not given yet: never sent, or refused as a split step (a refused combined step is checked
    // for what went out below, never sent again).
    const notGiven =
      !this.refusedCombined(row) &&
      !row.steps.some(
        (step) => step.method === 'approveReview' && (step.completedAt || step.uncertain),
      );

    // Queued by an earlier version, with nothing to check its summary against after approving
    // (whichever plan it was given): nothing more of it is sent.
    if (notGiven && action.basis && !action.basis.summaryFingerprint)
      throw new ReviewError('LEGACY_APPROVAL', 409, say('stop.legacy-gitlab-approval'));

    if (row.plan === 2) return row;
    if (unsent) return this.save({ ...row, plan: 2 });
    if (!this.refusedCombined(row)) return row;

    const approved = approvalOf(row, pr, false);
    const summary = approved
      ? await forge.markedComment(row.prId, row.account, postedReviewMarker(action.runId))
      : null;

    // Stopped while the forge was asked: it stays stopped.
    row = this.row(row.account, row.id);
    if (row.status === 'cancelled') throw new Cancelled();

    if (approved && summary) {
      this.complete(row, { url: summary.url });
      return null;
    }

    throw new ReviewError(
      'UNCONFIRMED',
      409,
      'Review Desk cannot tell whether this approval and its summary reached GitLab: the step that sent both was refused, and the merge request does not show both. Check it, then approve it yourself if it still applies.',
    );
  }

  /**
   * Right before each send of an automatic AI review post: what it does must still be allowed by
   * Settings, for the diff the PR shows and the discussion the review read. Before anything was
   * sent, a post that fails a check is skipped with the reason; after, the rest waits for you.
   */
  private async checkAutomaticPost(
    forge: GitHubApi,
    row: OperationRecord,
    method: string,
    args: unknown[],
  ): Promise<OperationRecord> {
    const action = row.action as AiReviewAction;
    // What Settings allows is known here: a post it no longer allows stops without waiting on
    // the forge, before the lookup and again when the lookup fails.
    const allowed = () => {
      row = this.row(row.account, row.id);
      if (row.status === 'cancelled') throw new Cancelled();

      this.stopFor(row, this.settingsProblem(action, method));
    };

    allowed();

    // A failed read is retried, unless Settings stopped the post meanwhile. A rate limit holds
    // either way: it is recorded first, so nothing reaches the forge before its time.
    const read = async <T>(lookup: () => Promise<T>): Promise<T> => {
      try {
        return await lookup();
      } catch (error) {
        this.coolDown(row.account, error);
        allowed();

        throw error;
      }
    };
    const basis = action.basis;

    // The merge base of the reviewed head on the commit the target branch points to now, then
    // the last read of the PR, which reads the target branch with the rest: the merge base
    // counts only if the branch still points there, so a target that moved is noticed even where
    // the PR still shows its earlier diff. A merge base of two commits never changes, so nothing
    // needs reading after the PR. From that read to the step's checkpoint, everything is
    // synchronous.
    let target: string | null = null;
    let compared: string | null = null;

    if (basis) {
      target = await read(() => forge.branchHead(row.repository, basis.baseRefName));
      compared = target
        ? ((await read(() => forge.compare(row.repository, target!, action.expectedHeadOid)))
            ?.mergeBaseOid ?? null)
        : null;
    }

    await read(() => this.sync.refresh(row.prId, row.account, forge));

    row = this.row(row.account, row.id);
    if (row.status === 'cancelled') throw new Cancelled();

    const stored = this.sync.store.snapshot(row.account, row.prId);
    // Where the last read could not say where the branch is, the merge base is unknown, not
    // wrong: the post waits and tries again.
    const tip = stored?.baseTipOid;
    const mergeBase = !target
      ? null
      : tip === undefined
        ? undefined
        : tip === target
          ? compared
          : null;

    const open = stored?.state === 'OPEN' ? stored : undefined;

    this.stopFor(row, this.postProblem(row, action, open, mergeBase, method, args));

    return row;
  }

  /**
   * Why Settings, now or when the review finished, does not allow this step. `legacy: false`
   * leaves out the hold on approvals queued before inputs were checked, which waits for the
   * checks that skip an outdated post.
   */
  private settingsProblem(
    action: AiReviewAction,
    method: string,
    legacy = true,
  ): PostProblem | null {
    const approving = action.event === 'APPROVE';
    const basis = action.basis;
    const settings = this.posting();

    if (!settings.postFindings)
      return stopped(
        'posting findings was turned off in Settings.',
        approving,
        undefined,
        isSummary(action, method),
      );

    // Queued before Review Desk checked a review's inputs: comments still go out while posting
    // is on, but an approval or a resolution is yours to send.
    if (!basis)
      return legacy && (approving || method === 'setThreadResolved')
        ? {
            skipped: 'this approval was queued before Review Desk checked what a review read.',
            code: 'LEGACY_APPROVAL',
            hold: true,
            attention: say('stop.legacy-approval'),
          }
        : null;

    // A summary follows an approval that went out: approving no longer governs it.
    if (
      approving &&
      !isSummary(action, method) &&
      (!basis.grants.approve || !settings.approveFindings)
    )
      return stopped('automatic approval was turned off in Settings.', approving);
    if (method === 'setThreadResolved' && (!basis.grants.resolve || !settings.resolveThreads))
      return stopped('resolving threads was turned off in Settings.', approving);

    return null;
  }

  /**
   * Records which approval an automatic approval just gave, read right after it: GitLab names it
   * by its note. Where it cannot be read, nothing is recorded, and the summary waits for you.
   */
  private async bindApproval(forge: GitHubApi, row: OperationRecord): Promise<OperationRecord> {
    try {
      await this.sync.refresh(row.prId, row.account, forge);
    } catch (error) {
      // A rate limit holds everything until its time, and stops this attempt; the approval's
      // receipt is kept. Any other failure leaves it unnamed, and the summary waits.
      if (error instanceof GitHubError && error.outcome === 'rate_limit') {
        this.coolDown(row.account, error);
        throw error;
      }

      return row;
    }

    const pr = this.sync.store.snapshot(row.account, row.prId) ?? undefined;
    const approval = approvalOf(row, pr, declaredTraits(forge).approvalCarriesSummary);
    const current = this.row(row.account, row.id);

    return approval ? this.save({ ...current, approvalId: approval.id }) : current;
  }

  /** Holds every request of the action's account until a rate limit it reported has passed. */
  private coolDown(account: string, error: unknown): void {
    if (error instanceof GitHubError && error.outcome === 'rate_limit')
      this.sync.deferUntil(
        error.retryAt ?? new Date(this.clock.now() + 60_000).toISOString(),
        account,
      );
  }

  /** Records why a post stops: skipped when nothing was sent yet, otherwise needing attention. */
  private stopFor(row: OperationRecord, problem: PostProblem | null): void {
    if (!problem) return;
    if (problem.retry)
      throw new GitHubError(render(problem.attention, row.account), null, null, 'unavailable');

    if (!problem.hold && !row.steps.some((step) => step.completedAt || step.uncertain)) {
      this.save({
        ...row,
        status: 'cancelled',
        finishedAt: isoNow(this.clock),
        progress: say('outbox.not-posted', { reason: problem.skipped }),
      });
      throw new Cancelled();
    }

    throw new ReviewError(problem.code, 409, problem.attention);
  }

  /**
   * Synchronous, so nothing it reads can change before the step it allows is checkpointed.
   * `mergeBase` is the reviewed head's live merge base on the reviewed target branch, null where
   * it is not the one reviewed (or there is no such branch), undefined where it is unknown.
   */
  private postProblem(
    row: OperationRecord,
    action: AiReviewAction,
    pr: PullRequestSnapshot | undefined,
    mergeBase: string | null | undefined,
    method: string,
    args: unknown[],
  ): PostProblem | null {
    const approving = action.event === 'APPROVE';
    const stop = (skipped: Wording, code?: string) =>
      stopped(skipped, approving, code, isSummary(action, method));

    if (!pr) return stop(say('stop.untracked'), 'NOT_FOUND');
    if (pr.headOid !== action.expectedHeadOid)
      return stop(
        'new commits arrived after this review. Run it again to review them.',
        'HEAD_MOVED',
      );

    const allowed = this.settingsProblem(action, method);
    const basis = action.basis;

    if (allowed || !basis) return allowed;
    if (pr.baseRefName !== basis.baseRefName) return stop(say('stop.retargeted'), 'BASE_CHANGED');
    if (mergeBase === undefined)
      return {
        skipped: 'Review Desk could not confirm where the target branch is.',
        code: 'TARGET_UNKNOWN',
        attention:
          'Review Desk could not confirm where the target branch is. It tries again; nothing is sent until it can.',
        retry: true,
      };
    if (mergeBase !== basis.mergeBaseOid) return stop(say('stop.other-diff'), 'BASE_CHANGED');

    const resolved = new Set(
      row.steps
        .filter(
          (step) => step.method === 'setThreadResolved' && step.completedAt && step.acknowledged,
        )
        .map((step) => String(step.args[0])),
    );

    // The summary after its approval goes with that approval: withdrawn, or not shown for the
    // reviewed commit, the summary waits for you.
    const summary = isSummary(action, method);

    const approval = summary
      ? approvalOf(row, pr, declaredTraits(this.forge(row.account)).approvalCarriesSummary)
      : undefined;

    if (summary && !row.approvalId)
      return {
        skipped: 'Review Desk could not record which approval this post gave.',
        code: 'APPROVAL_UNKNOWN',
        hold: true,
        attention: say('stop.approval-unknown'),
      };
    if (summary && (!approval || approval.id !== row.approvalId))
      return {
        skipped: say('stop.approval-withdrawn'),
        code: 'APPROVAL_WITHDRAWN',
        hold: true,
        attention: say('stop.approval-gone'),
      };

    // The summary after its approval is checked without your reviews, which that approval
    // changed; a post queued before that fingerprint existed cannot be checked, and waits.
    const expected = summary ? basis.summaryFingerprint : basis.fingerprint;

    if (!expected)
      return {
        skipped: 'this summary was queued before Review Desk could check it after approving.',
        code: 'DISCUSSION_CHANGED',
        hold: true,
        attention: say('stop.summary-unchecked'),
      };

    if (
      [...resolved].some((id) => !pr.threads.find((thread) => thread.id === id)?.isResolved) ||
      publicationFingerprint(pr, action.runId, row.account, resolved, !summary) !== expected
    )
      return stop(say('stop.discussion-changed'), 'DISCUSSION_CHANGED');

    if (approving && !isSummary(action, method)) {
      if (pr.isDraft) return stop(say('stop.draft'));
      if (isSameUser(pr.author.login, row.account)) return stop(say('stop.own'));
    }

    if (method === 'setThreadResolved') {
      const thread = pr.threads.find((candidate) => candidate.id === String(args[0]));

      if (!basis.threadIds.includes(String(args[0])) || !thread || thread.isResolved)
        return stop(say('stop.discussion-changed'), 'DISCUSSION_CHANGED');
      if (thread.viewerCanResolve === false)
        return stop('a thread this review read can no longer be resolved by you.');
    }

    return null;
  }

  private stepLabel(method: string, row: OperationRecord): Wording {
    if (method === 'addReviewThread' && row.action.type === 'review') {
      const completed = row.steps.filter(
        (step) => step.method === 'addReviewThread' && step.completedAt,
      ).length;

      return `Saving comment ${completed + 1} of ${row.action.draft.comments.filter((comment) => comment.status === 'draft').length} to your pending review.`;
    }

    if (row.action.type === 'ai_review')
      return method === 'setThreadResolved'
        ? 'Resolving open review threads before approving.'
        : method === 'approveReview'
          ? say('outbox.approving')
          : row.action.event === 'APPROVE'
            ? 'Posting the AI review summary after approving.'
            : say('outbox.posting-review');

    return method === 'submitReview' ? say('outbox.submitting') : say('outbox.sending');
  }

  /**
   * Marks the action done. `nothingToSend`: its path found the work already done before declaring
   * any write (see `assertSettled`).
   */
  private complete(
    row: OperationRecord,
    result: GitHubOperation['result'],
    nothingToSend = false,
  ): void {
    this.assertSettled(row, nothingToSend);
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
        finishedAt: isoNow(this.clock),
        progress:
          row.action.type === 'discard'
            ? row.action.restoreOperationId
              ? 'Pending review removed. Your editable draft is restored.'
              : 'Pending review discarded.'
            : result?.pending
              ? say('outbox.added-to-pending')
              : say('outbox.confirmed'),
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
        progress: say('outbox.connection-ended'),
        error: { code: 'UNCONFIRMED', message: wordingOf(error, safeError) },
      });
      return;
    }

    // Uncertain mutations returned above. Transport failures here belong to safe reads or
    // definitely rejected calls; confirmed mutation checkpoints will not be sent again.
    const retryable =
      error instanceof GitHubError &&
      ['rate_limit', 'unavailable', 'unknown'].includes(error.outcome);
    if (error instanceof GitHubError && error.outcome === 'rate_limit') {
      this.sync.deferUntil(
        error.retryAt ?? new Date(this.clock.now() + 60_000).toISOString(),
        row.account,
      );
    }
    if (retryable && row.attempts < this.retryDelays.length) {
      const retryAt = new Date(
        Math.max(
          this.clock.now() + this.retryDelays[row.attempts],
          error.retryAt
            ? Date.parse(error.retryAt)
            : error.outcome === 'rate_limit'
              ? this.clock.now() + 60_000
              : -Infinity,
        ),
      ).toISOString();

      if (error.outcome === 'rate_limit') this.sync.deferUntil(retryAt, row.account);
      this.save({
        ...row,
        status: 'waiting',
        attempts: row.attempts + 1,
        retryAt,
        progress: 'Waiting to retry. Your action is saved.',
        error: { code: error.outcome.toUpperCase(), message: wordingOf(error, safeError) },
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
        message: wordingOf(error, safeError),
      },
    });
  }

  private async reconcile(row: OperationRecord, forge: GitHubApi): Promise<void> {
    const step = row.steps.find((candidate) => candidate.uncertain && !candidate.completedAt);
    if (!step) {
      this.save({ ...row, status: 'queued', error: null });
      return;
    }

    try {
      const identity = await forge.identity();
      if (identity.login.toLowerCase() !== row.account.toLowerCase())
        throw new ReviewError('ACCOUNT_CHANGED', 409, say('outbox.sign-in-to-check'));

      let confirmed = false;
      let result: unknown = null;

      if (step.method === 'submitReview') {
        const receipt = await this.checkedReceipt(forge, row.account, String(step.args[0]), true);
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
            progress: say('outbox.pending-review-kept'),
            error: {
              code: 'RETRY_SUBMISSION',
              message: 'The review has not been submitted. Its comments are preserved.',
            },
          });
          return;
        }
      } else if (step.method === 'deleteReview') {
        confirmed =
          (await this.checkedReceipt(forge, row.account, String(step.args[0]), true)) === null;
      } else if (step.method === 'approveReview' && row.action.type === 'ai_review') {
        await this.sync.refresh(row.prId, row.account, forge);

        const action = row.action;
        const pr = this.sync.detailFor(row.account, row.prId)?.snapshot;
        const carries = declaredTraits(forge).approvalCarriesSummary;

        // An approval sent alone (plan 2) is confirmed by your approval of the head (see
        // `approvalOf`). One that carries its summary (GitHub) by the review with its text. A
        // step that sent an approval and a note together (rows from before plan 2) only by both,
        // the note found through every page: either alone is inconclusive, so it stays
        // unconfirmed for you.
        let receipt: { id: string; url: string } | null | undefined;

        if (step.args[2] === '') {
          // Nothing on GitLab tells this approval from one you gave by hand meanwhile: an
          // approval carries no trace of the request that made it. It stays unconfirmed.
          receipt = undefined;
        } else if (carries) {
          receipt = pr?.reviews.find(
            (review) =>
              review.state === 'APPROVED' &&
              review.commitOid === action.expectedHeadOid &&
              review.body === action.body,
          );
        } else if (approvalOf(row, pr, false)) {
          receipt = await forge.markedComment(
            row.prId,
            row.account,
            postedReviewMarker(action.runId),
          );
        }

        if (receipt) {
          confirmed = true;
          result = { id: receipt.id, url: receipt.url };
        }
      } else if (step.method === 'addConversationComment' && row.action.type === 'ai_review') {
        // The run's marker identifies the comment exactly, looked for through every page of the
        // conversation by the PR's repository and number (a snapshot keeps only the latest, and
        // none once the PR closes). Absence is not proof: the forge may not list it yet, so an
        // unfound comment stays unconfirmed rather than being sent again.
        const posted = await forge.markedComment(
          row.prId,
          row.account,
          postedReviewMarker(row.action.runId),
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
        await this.sync.refresh(row.prId, row.account, forge);
        const pr = this.sync.detailFor(row.account, row.prId)?.snapshot;

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
        step.completedAt = isoNow(this.clock);
        step.result = result;
        step.uncertain = false;
        this.save({
          ...row,

          status: 'queued',
          error: null,
          progress: say('outbox.step-confirmed'),
        });
      } else {
        this.save({
          ...row,
          status: 'needs_attention',
          dismissedAt: null,
          progress: say('outbox.unconfirmed'),
          error: {
            code: 'UNCONFIRMED',
            message: say('outbox.may-have-reached'),
          },
        });
      }
    } catch (error) {
      this.save({
        ...row,
        status: 'needs_attention',
        dismissedAt: null,
        progress: say('outbox.result-unconfirmed'),
        error: { code: 'UNCONFIRMED', message: wordingOf(error, safeError) },
      });
    }
  }

  async pause(): Promise<void> {
    this.suspended = true;
    this.cancelWake?.();
    this.cancelWake = null;

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
    this.cancelWake?.();
    this.cancelWake = null;

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
