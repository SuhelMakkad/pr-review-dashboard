import { pullPath, shortRef } from '@review-desk/shared/accounts';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  AUTO_REVIEW_QUIET_MS,
  codexBlocked,
  hasBlockingFindings,
  type FullReviewResult,
} from '@review-desk/shared/ai';
import { addedByHand } from '@review-desk/shared/attention';
import type { ReviewNotification } from '@review-desk/shared/notify';
import type {
  AttentionReason,
  PullRequestItem,
  PullRequestSnapshot,
} from '@review-desk/shared/types';
import type { AiRunner } from '@/ai/runner.js';
import { aiRuns, autoReviewLog, type AiRunRow } from '@/db/schema.js';
import { batches } from '@/db/store.js';
import { asAccount } from '@/github/credentials.js';
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
 * here can reach GitHub: posting the report is FindingsPublisher's job, and only when Settings asks
 * for it. FindingsPublisher decides whether the result warrants an approval or a comment.
 *
 * New commits stop an automatic review of an older head, including commits that only show up once
 * it has finished. A fresh review starts once the PR has had no new commits for
 * `AUTO_REVIEW_QUIET_MS`; each push during the wait starts the wait over, and a review you start
 * during the wait takes its place.
 */
export class AutoReviewer {
  private running: Promise<void> | null = null;
  private pending: string | null = null;
  private closed = false;
  /** Finished runs being checked against GitHub right now; passes leave them alone. */
  private readonly verifying = new Set<string>();
  /** Work started when a run finishes (its check and announcement), which shutdown waits for. */
  private readonly completions = new Set<Promise<void>>();

  constructor(
    private readonly sync: SyncService,
    private readonly runner: AiRunner,
    private readonly notifier: Notifier,
  ) {}

  private get db() {
    return this.sync.store.db;
  }

  /**
   * Starts no further passes or completion work, and waits for what is in progress, so none of it
   * outlives shutdown. A run that finishes from now on is checked on the next start: `settled`
   * saved that check with its outcome.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.pending = null;

    await Promise.all([this.running, ...this.completions]);
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
    if (!this.runner.settings().autoReview.enabled) this.dropRestarts();

    const status = this.sync.status;

    if (account !== status.account?.login) return;
    if (!status.lastCompletedAt && !status.lastSuccessfulSync) return;

    this.prime(account);
  }

  /**
   * Called with the run's outcome, in the same transaction: a finished automatic review must be
   * checked for commits made while it ran. Saving that with the outcome means a failed request,
   * an account switch or a restart can delay the check but never lose it.
   */
  settled(row: AiRunRow): void {
    if (row.trigger !== 'auto' || row.task !== 'full_review') return;
    if (!this.runner.settings().autoReview.enabled) return;

    // A newer request that found this run in progress is waiting on it too.
    const entries = this.db
      .select()
      .from(autoReviewLog)
      .where(
        and(
          eq(autoReviewLog.account, row.account),
          eq(autoReviewLog.runId, row.id),
          inArray(autoReviewLog.status, ['started', 'skipped']),
        ),
      )
      .all();

    for (const entry of entries)
      this.record(row.account, entry, {
        status: 'checking',
        runId: entry.runId,
        attempts: entry.attempts,
      });
  }

  /**
   * Announces a finished automatic review, unless commits made while it ran are on the PR: then a
   * fresh review follows, and announcing the outdated one would only be noise.
   */
  finished(row: AiRunRow): void {
    if (this.closed) return;
    if (row.trigger !== 'auto' || row.task !== 'full_review') return;
    if (row.status !== 'done' && row.status !== 'failed') return;

    const completion = (async () => {
      if (this.current(row.account) && (await this.verify(row.account, row, true))) return;
      // Shutdown began during the check, which then could not tell; the next start finishes it.
      if (this.closed) return;

      await this.announce(row);
    })().catch(() => undefined);

    this.completions.add(completion);
    void completion.finally(() => this.completions.delete(completion));
  }

  /**
   * PRs whose automatic review new commits stopped, with when a fresh one starts. A restart that
   * is no longer coming, because the request is not due or you started a review, is left out.
   */
  restarts(account: string): Map<string, string> {
    const restarts = new Map<string, string>();

    if (!this.current(account)) return restarts;

    const waiting = this.db
      .select()
      .from(autoReviewLog)
      .where(and(eq(autoReviewLog.account, account), eq(autoReviewLog.status, 'waiting')))
      .all();

    for (const entry of waiting) {
      const item = this.sync.detail(entry.prId)?.item;

      if (!entry.restartAt || !item || !stillDue(item, entry.key)) continue;
      if (this.runner.activeRun(account, entry.prId, 'full_review')) continue;
      if (this.replacement(account, entry)) continue;

      const previous = restarts.get(entry.prId);

      if (!previous || entry.restartAt > previous) restarts.set(entry.prId, entry.restartAt);
    }

    return restarts;
  }

  private async announce(row: AiRunRow): Promise<void> {
    const pr = this.sync.detail(row.prId)?.snapshot;

    if (!pr) return;

    const notification: ReviewNotification = {
      key: `ai:${row.id}`,
      kind: 'ai_review_ready',
      prId: row.prId,
      title: `${shortRef(pr)} · ${pr.title}`,
      body: readyCopy(row),
      path: pullPath('inbox/attention', pr),
    };

    await this.notifier.announce(row.account, [notification]).catch(() => undefined);
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

        // Failures and restarts from an earlier period are backlog too: do not retry them.
        this.db
          .update(autoReviewLog)
          .set({ status: 'primed', updatedAt, headOid: null, restartAt: null })
          .where(
            and(
              eq(autoReviewLog.account, account),
              inArray(autoReviewLog.status, ['failed', 'waiting']),
              inArray(
                autoReviewLog.key,
                batch.map(({ key }) => key),
              ),
            ),
          )
          .run();
      }

      // Reviews that finished while it was off stand as they are.
      this.db
        .update(autoReviewLog)
        .set({ status: 'started', updatedAt })
        .where(and(eq(autoReviewLog.account, account), eq(autoReviewLog.status, 'checking')))
        .run();

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
    candidate: Pick<LogRow, 'key' | 'prId'>,
    entry: Pick<LogRow, 'status'> &
      Partial<
        Pick<LogRow, 'runId' | 'attempts' | 'error' | 'headOid' | 'restartAt' | 'waitingSince'>
      >,
  ): void {
    const values = {
      runId: entry.runId ?? null,
      attempts: entry.attempts ?? 0,
      error: entry.error ?? null,
      status: entry.status,
      headOid: entry.headOid ?? null,
      restartAt: entry.restartAt ?? null,
      waitingSince: entry.waitingSince ?? null,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .insert(autoReviewLog)
      .values({ account, key: candidate.key, prId: candidate.prId, ...values })
      .onConflictDoUpdate({ target: [autoReviewLog.account, autoReviewLog.key], set: values })
      .run();
  }

  private run(id: string | null): AiRunRow | null {
    return id ? (this.db.select().from(aiRuns).where(eq(aiRuns.id, id)).get() ?? null) : null;
  }

  /** Lets open pages show the restart, or that it is no longer coming. */
  private changed(prId: string, runId: string | null): void {
    this.sync.events.emit({ type: 'ai.updated', prId, ...(runId ? { runId } : {}) });
  }

  /**
   * Waits for the PR to go quiet at `headOid` before starting a fresh review. Keeps the stopped
   * run for reference and the failed attempts to start, so a PR that cannot be reviewed stops. A
   * push during the wait starts the quiet period over, but not the wait: it began at `began`, or
   * now.
   */
  private wait(
    account: string,
    entry: Pick<LogRow, 'key' | 'prId'> &
      Partial<Pick<LogRow, 'runId' | 'attempts' | 'status' | 'waitingSince'>>,
    headOid: string,
    began?: string | null,
  ): void {
    const now = Date.now();

    this.record(account, entry, {
      status: 'waiting',
      runId: entry.runId,
      attempts: entry.attempts,
      headOid,
      restartAt: new Date(now + AUTO_REVIEW_QUIET_MS).toISOString(),
      waitingSince:
        (entry.status === 'waiting' ? entry.waitingSince : null) ??
        began ??
        new Date(now).toISOString(),
    });
    this.changed(entry.prId, entry.runId ?? null);
  }

  /**
   * Ends the PR's other waits once one of its requests is settled, or a newer request took over
   * the wait. They belong to requests it replaced, so they must never restart or be joined.
   */
  private closeWaits(account: string, prId: string, key: string): void {
    this.db
      .update(autoReviewLog)
      .set({
        status: 'skipped',
        headOid: null,
        restartAt: null,
        waitingSince: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(autoReviewLog.account, account),
          eq(autoReviewLog.prId, prId),
          eq(autoReviewLog.status, 'waiting'),
          ne(autoReviewLog.key, key),
        ),
      )
      .run();
  }

  /** A wait on the PR whose quiet period has not ended, which a newly found request joins. */
  private pendingWait(account: string, prId: string): LogRow | null {
    const now = Date.now();

    return (
      this.db
        .select()
        .from(autoReviewLog)
        .where(
          and(
            eq(autoReviewLog.account, account),
            eq(autoReviewLog.prId, prId),
            eq(autoReviewLog.status, 'waiting'),
          ),
        )
        .all()
        .find(
          (entry) => Date.parse(entry.restartAt ?? '') > now && !this.replacement(account, entry),
        ) ?? null
    );
  }

  /**
   * A review of the PR started since the wait began, which takes the restart's place: one you
   * started, even if you stopped it since, or one for a newer request.
   */
  private replacement(account: string, entry: LogRow): AiRunRow | null {
    return this.startedSince(
      account,
      entry.prId,
      entry.waitingSince ?? entry.updatedAt,
      entry.runId,
    );
  }

  /** The latest full review of the PR started at or after `since`, other than `except`. */
  private startedSince(
    account: string,
    prId: string,
    since: string,
    except: string | null,
  ): AiRunRow | null {
    return (
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.account, account),
            eq(aiRuns.prId, prId),
            eq(aiRuns.task, 'full_review'),
            ne(aiRuns.id, except ?? ''),
            gte(aiRuns.createdAt, since),
          ),
        )
        .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get() ?? null
    );
  }

  /** The PR's previous automatic review finished and is still being checked for new commits. */
  private checkingPr(account: string, prId: string): boolean {
    return Boolean(
      this.db
        .select()
        .from(autoReviewLog)
        .where(
          and(
            eq(autoReviewLog.account, account),
            eq(autoReviewLog.prId, prId),
            eq(autoReviewLog.status, 'checking'),
          ),
        )
        .get(),
    );
  }

  /**
   * An automatic review this account can stop for new commits: queued, running, or saved by a
   * server restart. A review you paused stays paused.
   */
  private stoppable(run: AiRunRow): boolean {
    return (
      run.status === 'queued' ||
      run.status === 'running' ||
      (run.status === 'paused' && run.pauseReason === 'restart')
    );
  }

  private checking(account: string, runId: string): LogRow[] {
    return this.db
      .select()
      .from(autoReviewLog)
      .where(
        and(
          eq(autoReviewLog.account, account),
          eq(autoReviewLog.runId, runId),
          eq(autoReviewLog.status, 'checking'),
        ),
      )
      .all();
  }

  /**
   * Checks a finished review against the PR as GitHub has it now. True when a fresh review waits.
   * When GitHub cannot be asked, the check stays saved and the next pass tries again. `asItFinished`
   * when this is the check made the moment the review finished.
   */
  private async verify(account: string, run: AiRunRow, asItFinished = false): Promise<boolean> {
    if (this.verifying.has(run.id) || this.checking(account, run.id).length === 0) return false;

    this.verifying.add(run.id);

    try {
      // A read started now: an older read still in flight can no longer be saved over it.
      const pr = (await this.sync.refresh(run.prId, account))?.snapshot ?? null;
      const outdated = pr ? await this.changedWhileRunning(account, run, pr, asItFinished) : false;

      if (!this.current(account)) return false;

      return this.settle(account, run, outdated ? pr : null);
    } catch {
      return false;
    } finally {
      this.verifying.delete(run.id);
    }
  }

  /**
   * The PR changed while the review ran. Checked as it finishes, GitHub shows what was pushed
   * meanwhile, so any new head counts. Checked later, pushes made since must be told apart by
   * their commit dates: a commit beyond the reviewed head made before the review finished counts
   * (a rebase or amend renews the date, so a rebase during the review counts too), later ones are
   * new work left for you, and unknown history counts. A committer clock that runs ahead can hide
   * a push from a later check.
   */
  private async changedWhileRunning(
    account: string,
    run: AiRunRow,
    pr: PullRequestSnapshot,
    asItFinished: boolean,
  ): Promise<boolean> {
    if (pr.headOid === run.headOid) return false;
    if (asItFinished) return true;

    const finished = Date.parse(run.finishedAt ?? '');

    if (Date.parse(pr.headCommittedAt) <= finished) return true;

    // The newest commit came later; an earlier one may have been made while it ran.
    const compare = await asAccount(account, () =>
      this.sync.github.compare(pr.repository, run.headOid, pr.headOid),
    );

    return (
      !compare ||
      compare.commits.some(
        (commit) => commit.committedAt === null || Date.parse(commit.committedAt) <= finished,
      )
    );
  }

  /**
   * Ends the check of a finished review: a fresh review waits for `outdated` to go quiet, or the
   * review stands when it is null. True when a fresh review waits.
   */
  private settle(account: string, run: AiRunRow, changed: PullRequestSnapshot | null): boolean {
    const entries = this.checking(account, run.id);
    // A review started since this one finished already covers the new commits.
    const outdated =
      changed && !this.startedSince(account, run.prId, run.finishedAt ?? run.createdAt, run.id)
        ? changed
        : null;

    this.sync.store.transaction(() => {
      for (const entry of entries) {
        if (outdated) this.wait(account, entry, outdated.headOid, run.finishedAt);
        else
          this.record(account, entry, {
            status: 'started',
            runId: entry.runId,
            attempts: entry.attempts,
          });
      }
    });

    return outdated !== null && entries.length > 0;
  }

  /** Completes checks of finished reviews that could not ask GitHub when they finished. */
  private async verifyPending(account: string): Promise<void> {
    const runIds = new Set(
      this.db
        .select()
        .from(autoReviewLog)
        .where(and(eq(autoReviewLog.account, account), eq(autoReviewLog.status, 'checking')))
        .all()
        .map((entry) => entry.runId),
    );

    for (const runId of runIds) {
      const run = this.run(runId);

      if (!this.current(account)) return;

      // Nothing left to check against; never hold the PR's requests back for it.
      if (!run) {
        this.db
          .update(autoReviewLog)
          .set({ status: 'started', updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(autoReviewLog.account, account),
              eq(autoReviewLog.runId, runId ?? ''),
              eq(autoReviewLog.status, 'checking'),
            ),
          )
          .run();
        continue;
      }

      await this.verify(account, run);
    }
  }

  /**
   * Turning automatic review off drops restarts it promised and checks it still owed, for every
   * account, so turning it on again never restarts anything from before.
   */
  private dropRestarts(): void {
    const pending = this.db
      .select()
      .from(autoReviewLog)
      .where(inArray(autoReviewLog.status, ['waiting', 'checking']))
      .all();

    if (pending.length === 0) return;

    const updatedAt = new Date().toISOString();

    this.sync.store.transaction(() => {
      this.db
        .update(autoReviewLog)
        .set({ status: 'primed', headOid: null, restartAt: null, waitingSince: null, updatedAt })
        .where(eq(autoReviewLog.status, 'waiting'))
        .run();
      this.db
        .update(autoReviewLog)
        .set({ status: 'started', updatedAt })
        .where(eq(autoReviewLog.status, 'checking'))
        .run();
    });

    for (const entry of pending) this.changed(entry.prId, entry.runId);
  }

  /**
   * Stops automatic reviews whose PR has new commits and waits for it to go quiet; a push during
   * the wait starts it over. Uses the PRs as the last sync saw them.
   */
  private followPushes(account: string): void {
    const stoppable = new Map(
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.account, account),
            eq(aiRuns.task, 'full_review'),
            eq(aiRuns.trigger, 'auto'),
            inArray(aiRuns.status, ['queued', 'running', 'paused']),
          ),
        )
        .all()
        .filter((run) => this.stoppable(run))
        .map((run) => [run.id, run]),
    );
    // Every request ever reviewed is `started`; only those with a run to stop matter here. A
    // newer request that found the run in progress is `skipped` and waits on it too.
    const entries = this.db
      .select()
      .from(autoReviewLog)
      .where(
        and(
          eq(autoReviewLog.account, account),
          inArray(autoReviewLog.status, ['started', 'skipped', 'waiting']),
        ),
      )
      .all()
      .filter((entry) => entry.status === 'waiting' || stoppable.has(entry.runId ?? ''));

    for (const entry of entries) {
      const pr = this.sync.detail(entry.prId)?.snapshot;

      if (!pr) continue;

      if (entry.status === 'waiting') {
        if (pr.headOid !== entry.headOid) this.wait(account, entry, pr.headOid);
        continue;
      }

      const run = stoppable.get(entry.runId ?? '')!;

      if (run.headOid === pr.headOid) continue;

      // One transaction, so the stopped run is never left without its restart.
      this.sync.store.transaction(() => {
        if (this.run(run.id)?.status !== 'cancelled') this.runner.cancel(account, run.id);

        this.wait(account, entry, pr.headOid);
      });
    }
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

    this.followPushes(account);
    await this.verifyPending(account);

    if (!this.current(account, since)) return;

    const log = this.log(account);
    const now = Date.now();
    const due = autoReviewCandidates(this.sync.list().items)
      .filter(({ item, key }) => stillDue(item, key))
      .filter(({ key }) => {
        const entry = log.get(key);

        return (
          !entry ||
          (entry.status === 'failed' && entry.attempts < MAX_ATTEMPTS) ||
          (entry.status === 'waiting' && Date.parse(entry.restartAt ?? '') <= now)
        );
      })
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

    for (const candidate of due) {
      const previous = log.get(candidate.key);
      const waiting = previous?.status === 'waiting' ? previous : null;

      try {
        if (!(await this.review(account, since, candidate, previous, waiting))) return;
      } finally {
        const settled = this.log(account).get(candidate.key);

        if (settled && settled.status !== 'waiting')
          this.closeWaits(account, candidate.item.id, candidate.key);

        // Open pages stop showing the restart, whatever became of it.
        if (waiting) this.changed(candidate.item.id, waiting.runId);
      }
    }
  }

  /** Starts or records one due request. False when the pass must stop. */
  private async review(
    account: string,
    since: string,
    candidate: AutoReviewCandidate,
    previous: LogRow | undefined,
    waiting: LogRow | null,
  ): Promise<boolean> {
    const entry = { key: candidate.key, prId: candidate.item.id };

    // Requests made before it was turned on are backlog, even when they are only found now. A
    // restart continues a review that was already admitted, so it is not backlog.
    if (!waiting && Date.parse(this.requestedAt(account, candidate)) < Date.parse(since)) {
      this.record(account, entry, { status: 'primed' });

      return true;
    }

    // The PR's previous review is still being checked for new commits: decide once it is.
    if (!waiting && this.checkingPr(account, candidate.item.id)) return true;

    // Found while the PR waits to go quiet for another request: wait with it.
    const pending = previous ? null : this.pendingWait(account, candidate.item.id);

    if (pending) {
      this.sync.store.transaction(() => {
        this.record(account, entry, {
          status: 'waiting',
          runId: pending.runId,
          headOid: pending.headOid,
          restartAt: pending.restartAt,
          waitingSince: pending.waitingSince,
        });
        this.closeWaits(account, entry.prId, entry.key);
      });
      this.changed(entry.prId, pending.runId);

      return true;
    }

    // A review started during the wait takes the restart's place.
    const replacement = waiting && this.replacement(account, waiting);

    if (replacement) {
      this.record(account, entry, { status: 'skipped', runId: replacement.id });

      return true;
    }

    if (!this.current(account, since) || !(await this.codexReady())) return false;

    // Never replace a run in progress or one you paused; start() would cancel a paused run.
    const active = this.runner.activeRun(account, candidate.item.id, 'full_review');

    if (active) {
      this.record(account, entry, { status: 'skipped', runId: active.id });

      return true;
    }

    // The head start() found when it was refused because of another push during the wait.
    let pushed = null as string | null;

    try {
      const run = await this.runner.start(account, candidate.item.id, 'full_review', {
        trigger: 'auto',
        // start() refreshes the PR and checks the plan first. Meanwhile automatic review may
        // have been turned off, the PR may have become a draft, you may have started a run, the
        // PR may have new commits since the wait began, or the previous review may have ended.
        admit: (detail) => {
          pushed =
            waiting && detail.snapshot.headOid !== waiting.headOid ? detail.snapshot.headOid : null;

          return (
            !pushed &&
            this.current(account, since) &&
            stillDue(detail.item, candidate.key) &&
            !this.runner.activeRun(account, candidate.item.id, 'full_review') &&
            !(waiting && this.replacement(account, waiting)) &&
            // The previous review may have finished meanwhile: its check, or the wait it began,
            // comes first. The next pass joins the wait.
            !this.checkingPr(account, candidate.item.id) &&
            (waiting !== null || !this.pendingWait(account, candidate.item.id))
          );
        },
      });

      // A saved review returned without asking `admit`: the PR moved to a head reviewed before,
      // which is a push during the wait like any other.
      if (waiting && run.headOid !== waiting.headOid) {
        if (this.current(account, since)) this.wait(account, waiting, run.headOid);

        return true;
      }

      this.record(account, entry, { status: 'started', runId: run.id });
    } catch (error) {
      // Not wanted now. Unrecorded, so a PR that is a draft again is reviewed once ready.
      if (error instanceof ReviewError && error.code === 'NOT_ADMITTED') {
        if (!this.current(account, since)) return false;
        if (waiting && pushed) this.wait(account, waiting, pushed);

        return true;
      }

      // New commits arrived while the review was being prepared: wait for the PR to go quiet.
      if (error instanceof ReviewError && error.code === 'HEAD_MOVED') {
        const head = this.sync.detail(candidate.item.id)?.snapshot.headOid;

        if (head && this.current(account, since))
          this.wait(
            account,
            waiting ?? { ...entry, runId: previous?.runId, attempts: previous?.attempts },
            head,
          );

        return true;
      }

      if (error instanceof ReviewError && STOP_CODES.has(error.code)) return false;
      if (error instanceof GitHubError && STOP_OUTCOMES.has(error.outcome)) return false;

      // Turned off, or off and on again, while it started: what it decided then no longer holds.
      if (!this.current(account, since)) return false;

      const attempts = (previous?.attempts ?? 0) + 1;

      // A restart tries again once the PR has been quiet again, until it runs out of attempts.
      if (waiting && attempts < MAX_ATTEMPTS) {
        const head = this.sync.detail(candidate.item.id)?.snapshot.headOid ?? waiting.headOid;

        if (head) this.wait(account, { ...waiting, attempts }, head);

        return true;
      }

      this.record(account, entry, {
        status: 'failed',
        runId: waiting?.runId,
        attempts,
        error: safeError(error),
      });
    }

    return true;
  }
}
