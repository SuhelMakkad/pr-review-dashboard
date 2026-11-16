import { and, eq, inArray } from 'drizzle-orm';
import { codexBlocked, hasBlockingFindings, type FullReviewResult } from '@review-desk/shared/ai';
import { addedByHand } from '@review-desk/shared/attention';
import type { ReviewNotification } from '@review-desk/shared/notify';
import type { AttentionReason, PullRequestItem } from '@review-desk/shared/types';
import type { AiRunner } from '@/ai/runner.js';
import { autoReviewLog, type AiRunRow } from '@/db/schema.js';
import { batches } from '@/db/store.js';
import { GitHubError, safeError } from '@/github/errors.js';
import type { Notifier } from '@/notify/notifier.js';
import { ReviewError } from '@/review/errors.js';
import type { SyncService } from '@/sync/service.js';

type LogRow = typeof autoReviewLog.$inferSelect;

/** Review requests: first requests (direct, team or assignment) and re-requests after a review. */
const TRIGGERS = new Set<AttentionReason['kind']>(['first_review', 'requested_again']);
const MAX_ATTEMPTS = 3;

/** Errors that mean "not now" for every PR: stop the pass, record nothing, retry next sync. */
const STOP_CODES = new Set(['PLAN_LIMIT', 'SHUTTING_DOWN', 'ACCOUNT_CHANGED']);
const STOP_OUTCOMES = new Set<GitHubError['outcome']>(['rate_limit', 'unavailable', 'auth']);

const primedKey = (account: string) => `auto-review-primed:${account}`;

export interface AutoReviewCandidate {
  /** `<PR id>:<reason key>`, one per review request. */
  key: string;
  /** The attention reason's key: `first:<event id>` or `request:<event id>` when GitHub has one. */
  reasonKey: string;
  at: string;
  item: PullRequestItem;
}

/** One key per review request, so each request is reviewed at most once. */
export function autoReviewCandidates(items: PullRequestItem[]): AutoReviewCandidate[] {
  return items.flatMap((item) => {
    const reason = item.reasons.filter((candidate) => TRIGGERS.has(candidate.kind)).at(-1);

    return reason
      ? [{ key: `${item.id}:${reason.key}`, reasonKey: reason.key, at: reason.at, item }]
      : [];
  });
}

/**
 * The request is still open on a PR ready for review (not a draft, snoozed or done). Discovery
 * sources outlive the request (a refresh keeps them, and a PR that leaves every feed keeps its
 * last ones), so "requested" proves nothing: a review request for you or your team must still be
 * active. Assignments are taken on trust, since snapshots do not record assignees.
 */
const stillDue = (item: PullRequestItem, key: string) =>
  item.queue === 'attention' &&
  (item.requestedVia.length > 0 ||
    item.sources.includes('assigned') ||
    item.sources.includes('manual')) &&
  autoReviewCandidates([item]).some((candidate) => candidate.key === key);

function readyCopy(row: AiRunRow): string {
  if (row.status === 'failed') return 'Automatic AI review failed. Open the PR to run it again.';

  try {
    const result = JSON.parse(row.result ?? '') as FullReviewResult;
    const count = result.comments.length;
    const blocking = hasBlockingFindings(result);

    if (count === 0)
      return blocking
        ? 'AI review ready · Changes recommended'
        : 'AI review ready · No blocking findings';

    const findings = `${count} finding${count === 1 ? '' : 's'}`;

    if (blocking) return `AI review ready · ${findings}, changes suggested`;

    return `AI review ready · ${findings}, none blocking`;
  } catch {
    return 'AI review ready';
  }
}

/**
 * Starts a full review when your review is requested. It stops at the finished report, so nothing
 * here can reach GitHub: posting the report is FindingsPoster's job, and only when Settings asks
 * for it. FindingsPoster decides whether the result warrants an approval or a comment.
 */
export class AutoReviewer {
  private running: Promise<void> | null = null;
  private pending: string | null = null;
  private closed = false;

  constructor(
    private readonly sync: SyncService,
    private readonly runner: AiRunner,
    private readonly notifier: Notifier,
  ) {}

  private get db() {
    return this.sync.store.db;
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Called after each sync. Passes run one at a time; a call during a pass schedules one more, so
   * requests that arrive mid-pass are not missed. Never throws.
   */
  afterSync(account: string): Promise<void> {
    if (this.closed) return Promise.resolve();

    if (this.running) {
      this.pending = account;

      return this.running;
    }

    this.running = this.pass(account)
      .catch(() => undefined)
      .finally(() => {
        this.running = null;

        const next = this.pending;

        this.pending = null;
        if (next) void this.afterSync(next);
      });

    return this.running;
  }

  /** After settings are saved: record the waiting backlog at once, so it is never reviewed. */
  settingsSaved(account: string): void {
    const status = this.sync.status;

    if (account !== status.account?.login) return;
    if (!status.lastCompletedAt && !status.lastSuccessfulSync) return;

    this.prime(account);
  }

  /** Announces a finished automatic review. */
  finished(row: AiRunRow): void {
    if (row.trigger !== 'auto' || row.task !== 'full_review') return;
    if (row.status !== 'done' && row.status !== 'failed') return;

    const pr = this.sync.detail(row.prId)?.snapshot;

    if (!pr) return;

    const notification: ReviewNotification = {
      key: `ai:${row.id}`,
      kind: 'ai_review_ready',
      prId: row.prId,
      title: `${pr.repository.split('/')[1]}#${pr.number} · ${pr.title}`,
      body: readyCopy(row),
      path: `/inbox/attention/${pr.repository}/${pr.number}`,
    };

    void this.notifier.announce(row.account, [notification]).catch(() => undefined);
  }

  /**
   * Records every current request as handled when automatic review was just turned on, or first
   * runs for this account. Returns true when it primed.
   */
  private prime(account: string): boolean {
    const { enabled, since } = this.runner.settings().autoReview;

    if (!enabled || !since) return false;
    if (this.sync.store.getSetting<string>(primedKey(account)) === since) return false;

    const keys = autoReviewCandidates(this.sync.list().items);
    const updatedAt = new Date().toISOString();

    this.sync.store.transaction(() => {
      for (const batch of batches(keys)) {
        this.db
          .insert(autoReviewLog)
          .values(
            batch.map(({ key, item }) => ({
              account,
              key,
              prId: item.id,
              status: 'primed' as const,
              updatedAt,
            })),
          )
          .onConflictDoNothing()
          .run();

        // Failures from an earlier period are backlog too: do not retry them.
        this.db
          .update(autoReviewLog)
          .set({ status: 'primed', updatedAt })
          .where(
            and(
              eq(autoReviewLog.account, account),
              eq(autoReviewLog.status, 'failed'),
              inArray(
                autoReviewLog.key,
                batch.map(({ key }) => key),
              ),
            ),
          )
          .run();
      }

      this.sync.store.setSetting(primedKey(account), since);
    });

    return true;
  }

  private log(account: string): Map<string, LogRow> {
    const rows = this.db
      .select()
      .from(autoReviewLog)
      .where(eq(autoReviewLog.account, account))
      .all();

    return new Map(rows.map((row) => [row.key, row]));
  }

  private record(
    account: string,
    candidate: AutoReviewCandidate,
    entry: Pick<LogRow, 'status'> & Partial<Pick<LogRow, 'runId' | 'attempts' | 'error'>>,
  ): void {
    const values = {
      runId: entry.runId ?? null,
      attempts: entry.attempts ?? 0,
      error: entry.error ?? null,
      status: entry.status,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .insert(autoReviewLog)
      .values({ account, key: candidate.key, prId: candidate.item.id, ...values })
      .onConflictDoUpdate({ target: [autoReviewLog.account, autoReviewLog.key], set: values })
      .run();
  }

  /** Codex is installed and the ChatGPT plan has room; otherwise wait for a later sync. */
  private async codexReady(): Promise<boolean> {
    const [providers, plan] = await Promise.all([
      this.runner.providerStatuses(),
      this.runner.codexStatus(),
    ]);

    return (
      providers.some((provider) => provider.id === 'codex' && provider.available) &&
      !codexBlocked(plan)
    );
  }

  /**
   * When the request was made: GitHub's request event, or for an assignment, which has no event,
   * the PR's last update, since assigning someone moves it forward. A PR you added yourself was
   * "requested" when you added it.
   */
  private requestedAt(account: string, candidate: AutoReviewCandidate): string {
    if (addedByHand(candidate.item))
      return this.sync.store.manualAddedAt(account, candidate.item.id) ?? candidate.item.updatedAt;

    const eventId = candidate.reasonKey.slice(candidate.reasonKey.indexOf(':') + 1);
    const event = this.sync.store
      .snapshot(account, candidate.item.id)
      ?.requestEvents.find((request) => request.id === eventId);

    return event?.createdAt ?? candidate.item.updatedAt;
  }

  /** Still running for this account, and not turned off (or off and on again) since `since`. */
  private current(account: string, since?: string): boolean {
    const settings = this.runner.settings().autoReview;

    return (
      !this.closed &&
      settings.enabled &&
      (since === undefined || settings.since === since) &&
      account === this.sync.status.account?.login
    );
  }

  private async pass(account: string): Promise<void> {
    if (!this.current(account)) return;

    // Just primed: everything waiting is backlog.
    if (this.prime(account)) return;

    const since = this.runner.settings().autoReview.since;

    if (!since) return;

    const log = this.log(account);
    const due = autoReviewCandidates(this.sync.list().items)
      .filter(({ item, key }) => stillDue(item, key))
      .filter(({ key }) => {
        const entry = log.get(key);

        return !entry || (entry.status === 'failed' && entry.attempts < MAX_ATTEMPTS);
      })
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

    for (const candidate of due) {
      // Requests made before it was turned on are backlog, even when they are only found now.
      if (Date.parse(this.requestedAt(account, candidate)) < Date.parse(since)) {
        this.record(account, candidate, { status: 'primed' });
        continue;
      }

      if (!this.current(account, since) || !(await this.codexReady())) return;

      // Never replace a run in progress or one you paused; start() would cancel a paused run.
      const active = this.runner.activeRun(account, candidate.item.id, 'full_review');

      if (active) {
        this.record(account, candidate, { status: 'skipped', runId: active.id });
        continue;
      }

      try {
        const run = await this.runner.start(account, candidate.item.id, 'full_review', {
          trigger: 'auto',
          // start() refreshes the PR and checks the plan first. Meanwhile automatic review may
          // have been turned off, the PR may have become a draft, or you may have started a run.
          admit: (detail) =>
            this.current(account, since) &&
            stillDue(detail.item, candidate.key) &&
            !this.runner.activeRun(account, candidate.item.id, 'full_review'),
        });

        this.record(account, candidate, { status: 'started', runId: run.id });
      } catch (error) {
        // Not wanted now. Unrecorded, so a PR that is a draft again is reviewed once ready.
        if (error instanceof ReviewError && error.code === 'NOT_ADMITTED') {
          if (!this.current(account, since)) return;

          continue;
        }

        if (error instanceof ReviewError && error.code === 'HEAD_MOVED') continue;
        if (error instanceof ReviewError && STOP_CODES.has(error.code)) return;
        if (error instanceof GitHubError && STOP_OUTCOMES.has(error.outcome)) return;

        this.record(account, candidate, {
          status: 'failed',
          attempts: (log.get(candidate.key)?.attempts ?? 0) + 1,
          error: safeError(error),
        });
      }
    }
  }
}
