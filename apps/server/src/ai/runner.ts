import { performance } from 'node:perf_hooks';
import type { WriteFence } from '@/db/versions.js';
import { render, say, type Wording } from '@/messages.js';
import { isoNow, type Clock } from '@/clock.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  codexBlocked,
  defaultAiSettings,
  hasBlockingFindings,
  type AiProvider,
  type AiProviderStatus,
  type AiResult,
  type AiReviewStatus,
  type AiRun,
  type AiRunContext,
  type AiRunStatus,
  type AiRunTrigger,
  type AiSettings,
  type AiTask,
  type CodexAccountStatus,
  type DraftCommentsResult,
  type FullReviewResult,
  type ReviewInputs,
} from '@review-desk/shared/ai';
import type { DiffManifest } from '@review-desk/shared/diff';
import type { DraftComment, PrepareReviewOptions, ReviewDraft } from '@review-desk/shared/review';
import type { PullRequestDetail, PullRequestSnapshot } from '@review-desk/shared/types';
import type { AiRunRow } from '@/db/ai-runs.js';
import type { DiffService } from '@/diff/service.js';
import type { EventBus } from '@/events.js';
import { bindForge } from '@/forge/bind.js';
import { redact, safeError } from '@/github/errors.js';
import { ReviewError, type ReviewService } from '@/review/service.js';
import { accountNotActive } from '@/review/errors.js';
import type { SyncService } from '@/sync/service.js';
import { agentExited, agentRunning, removeWorkspace, type AgentProvider } from '@/ai/provider.js';
import { log } from '@/log.js';
import { evidence, revalidated, type PreparedContext } from '@/ai/inputs.js';
import { draftFingerprint, reviewFingerprint } from '@/ai/freshness.js';
import { draftChanged, planPreparation, preparationRevision } from '@/ai/preparation.js';
import { jsonSchemaFor, TASKS, type ContextKey, type TaskDefinition } from '@/ai/tasks.js';
import {
  archiveAccess,
  downloadRepository,
  prepareReviewWorkspace,
  type RepositoryExporter,
} from '@/ai/workspace.js';
import { AI_SETTINGS } from '@/db/settings.js';
import type { GitHubApi } from '@/github/api.js';

const MAX_CONCURRENT = 2;
const PROBE_TTL_MS = 5 * 60_000;
const ACCOUNT_TTL_MS = 60_000;

/** The credits a Codex run measured itself spending, from its recorded usage. */
function creditsUsed(usage: string | null): number | null {
  if (!usage) return null;

  try {
    const value = (JSON.parse(usage) as { credits_used?: unknown }).credits_used;

    return typeof value === 'number' && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Runs AI tasks through local agent CLIs: one queue, at most two runs at once across providers,
 * results cached by exact input so a PR head is only analysed once per task.
 */
/** A run's workspace is named by its id. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Thrown out of a sweep's inventory once the runner is closing. */
class SweepStopped extends Error {}

/**
 * Bytes under `directory`, by `lstat`, never following a symlink. Checks `stopped` at every entry,
 * so a shutdown never waits for the inventory of a large workspace.
 */
async function sizeOf(directory: string, stopped: () => boolean): Promise<number> {
  let bytes = 0;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (stopped()) throw new SweepStopped();

    const path = join(directory, entry.name);

    if (entry.isDirectory()) bytes += await sizeOf(path, stopped);
    else bytes += (await lstat(path).catch(() => null))?.size ?? 0;
  }

  return bytes;
}

/** The same, at once: for the last check before a removal, with nothing running in between. */
function directoryIdentitySync(path: string): string | null {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });

    return stats?.isDirectory() && !stats.isSymbolicLink() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
}

/** A real directory's identity, or null for anything else (a symlink included). */
async function directoryIdentity(path: string): Promise<string | null> {
  const stats = await lstat(path).catch(() => null);

  return stats?.isDirectory() && !stats.isSymbolicLink() ? `${stats.dev}:${stats.ino}` : null;
}

function logWorkspaces(
  counts: Partial<
    Record<'kept' | 'keptBytes' | 'removed' | 'removedBytes' | 'deferred' | 'failed', number>
  >,
): void {
  const record = {
    kept: 0,
    keptBytes: 0,
    removed: 0,
    removedBytes: 0,
    deferred: 0,
    failed: 0,
    ...counts,
  };

  log.event(record.failed > 0 || record.deferred > 0 ? 'warn' : 'info', 'ai.workspaces', record);
}

export interface AiRunnerOptions {
  /**
   * Removes abandoned workspaces at start-up. Only for a work root inside the locked data folder:
   * a shared one (the system's temporary folder) may hold other processes' runs.
   */
  sweepWorkspaces?: boolean;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** `work`'s outcome, never rejecting, for the caller to check in its own turn. */
const settled = <T>(work: Promise<T>): Promise<Settled<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** A suggestion made for an older head: its lines are not this head's. */
const headMoved = () => new ReviewError('HEAD_MOVED', 409, say('review.suggestion-outdated'));

export class AiRunner {
  private readonly queue: string[] = [];
  /** Workspace removals in progress; `close()` and `cleanedUp()` wait for them. */
  private readonly removals = new Set<Promise<void>>();
  private sweeping: Promise<void> | null = null;
  private readonly executions = new Map<string, Promise<void>>();
  private opened = false;
  private closing = false;
  private readonly active = new Map<string, AbortController>();
  private probes: { at: number; statuses: AiProviderStatus[] } | null = null;
  private codexAccount: { at: number; status: Promise<CodexAccountStatus | null> } | null = null;

  /** Called once a run settles (done, failed, cancelled or paused), after its row is written. */
  onFinished?: (row: AiRunRow) => void;

  /**
   * Called inside the transaction that records a run as done or failed, so state that depends on
   * the outcome is saved with it. Synchronous; a throw is ignored.
   */
  onSettled?: (row: AiRunRow) => void;

  /**
   * Called in the same transaction for a done run, with the snapshot it reviewed, to decide and
   * queue what is posted. A throw rolls the settlement back: the run fails, keeping its checkpoint
   * where the provider can resume, so nothing is saved done without its decision.
   */
  onPublish?: (row: AiRunRow, reviewed: PullRequestSnapshot) => void;

  constructor(
    private readonly sync: SyncService,
    private readonly diffs: DiffService,
    private readonly reviews: ReviewService,
    private readonly events: EventBus,
    readonly providers: Record<AiProvider, AgentProvider>,
    private readonly workRoot: string,
    private readonly exportRepository: RepositoryExporter = downloadRepository,
    private readonly options: AiRunnerOptions = {},
  ) {}

  /** The app's clock, shared with the sync. */
  private get clock(): Clock {
    return this.sync.clock;
  }

  /**
   * Settles runs a previous process left queued or running: resumable ones wait for `recover()`,
   * the rest are marked interrupted. Called once this process owns the data directory, never from
   * the constructor, so a second launch cannot rewrite the runs of the process still running.
   */
  open(): void {
    if (this.opened || this.closing) return;

    this.opened = true;

    const unfinished = this.aiRuns
      .unfinished()
      // Runs queued by this process before it opened are its own, not left over.
      .filter((row) => !this.queue.includes(row.id));

    for (const row of unfinished) {
      const resumable = Boolean(row.request && this.providers[row.provider].supportsResume);

      this.aiRuns.update(
        row.id,
        resumable
          ? {
              status: 'paused',
              pauseReason: 'restart',
              progress: 'Saved after a server restart.',
              finishedAt: null,
            }
          : {
              status: 'interrupted',
              progress: null,
              finishedAt: isoNow(this.clock),
            },
      );
    }

    this.pump();

    // In the background, once the previous process's runs are settled: start-up never waits.
    if (this.options.sweepWorkspaces) this.sweeping = this.sweep().catch(() => undefined);
  }

  /**
   * Resolves once every workspace removal started so far has finished. Removals never throw: a
   * failure is logged and the workspace is left for the next start's sweep.
   */
  async cleanedUp(): Promise<void> {
    await this.sweeping;

    while (this.removals.size > 0) await Promise.allSettled([...this.removals]);
  }

  /** Removes a run's workspace under its agent lock, in the background but tracked. */
  private removeLater(id: string): void {
    const removal = removeWorkspace(join(this.workRoot, id), { waitMs: this.agentExitWaitMs })
      .then((outcome) => {
        if (outcome === 'busy') logWorkspaces({ deferred: 1 });
      })
      .catch(() => logWorkspaces({ failed: 1 }))
      .finally(() => this.removals.delete(removal));

    this.removals.add(removal);
  }

  /** True while this process is running, has queued or is unwinding the run. */
  private inProcess(id: string): boolean {
    return this.active.has(id) || this.executions.has(id) || this.queue.includes(id);
  }

  /**
   * True for a run nothing can use: none recorded, done, cancelled, or failed or interrupted
   * without both a saved request and a provider that resumes. Every paused run is kept.
   */
  private abandoned(id: string): boolean {
    if (this.inProcess(id)) return false;

    const row = this.row(id);

    if (!row) return true;
    if (row.status === 'done' || row.status === 'cancelled') return true;
    if (row.status !== 'failed' && row.status !== 'interrupted') return false;

    return !(row.request && this.providers[row.provider]?.supportsResume);
  }

  /**
   * Removes the workspaces of abandoned runs that a previous process left. Only directories named
   * by a run id are considered, never through a symlink. Each run is checked again just before its
   * removal, and an agent still holding its lock defers it to the next start.
   */
  private async sweep(): Promise<void> {
    const root = await directoryIdentity(this.workRoot);

    if (!root) return;

    const totals = { kept: 0, keptBytes: 0, removed: 0, removedBytes: 0, deferred: 0, failed: 0 };
    const entries = await readdir(this.workRoot, { withFileTypes: true }).catch(() => null);

    if (!entries) {
      logWorkspaces({ failed: 1 });
      return;
    }

    for (const entry of entries) {
      if (this.closing) return;
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;

      const directory = join(this.workRoot, entry.name);

      try {
        const identity = await directoryIdentity(directory);

        // Not a real directory by the time it is looked at: never followed, never removed.
        if (!identity) continue;

        const bytes = await sizeOf(directory, () => this.closing);

        if (!this.abandoned(entry.name)) {
          totals.kept += 1;
          totals.keptBytes += bytes;
          continue;
        }

        // Checked again under the run's lock, just before removing: still abandoned, not closing,
        // and the root and the workspace are the very directories inventoried, never ones
        // swapped in meanwhile. (Node cannot remove relative to an open directory, so a swap in
        // the instant after this check is not caught; only a process of the same user could make
        // one, and it could remove the files itself.)
        const outcome = await removeWorkspace(directory, {
          waitMs: 0,
          // Synchronous, with the removal started in the same JavaScript turn: nothing in this
          // process runs in between, so a shutdown or a run that began is always seen. A root or
          // workspace that another process swaps between these calls, or during `rm`'s walk, is not.
          stillAbandoned: () =>
            directoryIdentitySync(this.workRoot) === root &&
            directoryIdentitySync(directory) === identity &&
            !this.closing &&
            this.abandoned(entry.name),
        });

        if (outcome === 'busy') totals.deferred += 1;
        else if (outcome === 'kept') {
          totals.kept += 1;
          totals.keptBytes += bytes;
        } else {
          totals.removed += 1;
          totals.removedBytes += bytes;
        }
      } catch (error) {
        if (error instanceof SweepStopped) return;

        totals.failed += 1;
      }
    }

    logWorkspaces(totals);
  }

  /** The runs, as saved (`db/ai-runs.ts`). */
  private get aiRuns() {
    return this.sync.store.aiRuns;
  }

  /** How long a resume waits for the run's previous agent to have exited before refusing. */
  agentExitWaitMs = 6_000;

  settings(): AiSettings {
    // Saved settings over the defaults, each field on its own. Posting used to approve and resolve
    // threads, so a choice saved then keeps doing so (see `AI_SETTINGS`).
    return this.sync.store.settings.get(AI_SETTINGS) ?? defaultAiSettings();
  }

  /**
   * Saves settings. `autoReview.since` is the server's: set when turned on, cleared when off.
   * Settings left out keep their saved value.
   */
  saveSettings(
    settings: Omit<
      AiSettings,
      'autoReview' | 'postFindings' | 'approveFindings' | 'resolveThreads'
    > & {
      autoReview?: { enabled: boolean };
      postFindings?: boolean;
      approveFindings?: boolean;
      resolveThreads?: boolean;
    },
  ): AiSettings {
    const current = this.settings();
    const previous = current.autoReview;
    const enabled = settings.autoReview?.enabled ?? previous.enabled;
    const since = !enabled
      ? null
      : previous.enabled && previous.since
        ? previous.since
        : isoNow(this.clock);

    // A task that runs on one provider only is always saved with it.
    const tasks = { ...settings.tasks };

    for (const task of Object.keys(TASKS) as AiTask[]) {
      const only = TASKS[task].provider;

      if (only) tasks[task] = { ...tasks[task], provider: only };
    }

    this.sync.store.settings.set(AI_SETTINGS, {
      ...settings,
      tasks,
      autoReview: { enabled, since },
      postFindings: settings.postFindings ?? current.postFindings,
      approveFindings: settings.approveFindings ?? current.approveFindings,
      resolveThreads: settings.resolveThreads ?? current.resolveThreads,
    });

    return this.settings();
  }

  /** Saves only the automation and posting switches given; the rest keep their saved value. */
  saveAutomation(changes: {
    autoReview?: boolean;
    postFindings?: boolean;
    approveFindings?: boolean;
    resolveThreads?: boolean;
  }): AiSettings {
    const { autoReview, ...posting } = changes;
    const { defaultProvider, tasks } = this.settings();

    return this.saveSettings({
      defaultProvider,
      tasks,
      ...posting,
      ...(autoReview === undefined ? {} : { autoReview: { enabled: autoReview } }),
    });
  }

  async providerStatuses(): Promise<AiProviderStatus[]> {
    if (this.probes && this.clock.now() - this.probes.at < PROBE_TTL_MS)
      return this.probes.statuses;

    const statuses = await Promise.all(
      Object.values(this.providers).map(async (provider) => ({
        id: provider.id,
        label: provider.label,
        demo: provider.demo,
        ...(await provider.probe()),
      })),
    );

    this.probes = { at: this.clock.now(), statuses };

    return statuses;
  }

  /** The Codex sign-in and plan usage, read through app-server at most once a minute. */
  codexStatus(): Promise<CodexAccountStatus | null> {
    const provider = this.providers.codex;

    if (!provider.status) return Promise.resolve(null);
    if (this.codexAccount && this.clock.now() - this.codexAccount.at < ACCOUNT_TTL_MS)
      return this.codexAccount.status;

    const status = provider.status().catch((error: unknown): CodexAccountStatus => ({
      type: null,
      plan: null,
      windows: [],
      limitReached: false,
      resetsAt: null,
      models: [],
      problem: `Could not read the Codex sign-in: ${safeError(error)}`,
    }));

    this.codexAccount = { at: this.clock.now(), status };

    return status;
  }

  /** Refuses new work, or a draft write, for an account other than the one in use. */
  private assertSelected(account: string): void {
    const selected = this.sync.status.account?.login ?? null;

    if (account !== selected) throw accountNotActive(account, selected);
  }

  /**
   * What `work` came to, the account checked first: called in the caller's own turn after its await
   * (`this.selected(account, await settled(work))`), so an outcome reached after a switch, a result,
   * a cached run or an error, is never reported as the account's, and nothing runs on from it.
   */
  private selected<T>(account: string, outcome: Settled<T>): T {
    this.assertSelected(account);

    if (outcome.ok) return outcome.value;

    throw outcome.error;
  }

  /** The PR as the account in use has it. */
  private detail(account: string, prId: string): PullRequestDetail {
    this.assertSelected(account);

    return this.lookup(account, prId);
  }

  /** The PR as `account` has it, in use or not. */
  private lookup(account: string, prId: string): PullRequestDetail {
    const detail = this.sync.detailFor(account, prId);

    if (!detail) throw new ReviewError('NOT_FOUND', 404, say('pull.untracked'));

    return detail;
  }

  /**
   * The task's prompt, from the evidence it declares: the diff gathered now, as the account, and
   * the draft and completed review captured before (the same ones its context records).
   */
  private async buildInput(
    definition: TaskDefinition,
    detail: PullRequestDetail,
    account: string,
    captured: { draft: ReviewDraft | null; completedReview: AiRunRow | null },
  ): Promise<string> {
    const pr = detail.snapshot;
    let diff: DiffManifest | null = null;

    if (definition.evidence.diff === 'since-review') {
      const reviewOid = detail.item.latestReview?.commitOid;

      // Refused before any diff is read.
      if (!reviewOid) throw new ReviewError('NO_REVIEW', 422, say('ai.not-reviewed'));

      diff = await this.diffs.manifest(pr, 'since-review', reviewOid, account);
    } else if (definition.evidence.diff === 'full') {
      diff = await this.diffs.manifest(pr, 'full', null, account);
    }

    const review = captured.completedReview;

    // Only what the task declares is gathered; its definition reads nothing else.
    return definition.input({
      pr,
      diff: diff!,
      draft: captured.draft!,
      completedReview: review
        ? {
            id: review.id,
            result: review.result ? (JSON.parse(review.result) as FullReviewResult) : null,
          }
        : null,
      login: account,
    });
  }

  /** What the run's freshness is compared on, as the task declares, in the order it is saved. */
  private contextOf(
    definition: TaskDefinition,
    pr: PullRequestDetail['snapshot'],
    account: string,
    captured: { draft: ReviewDraft | null; completedReview: AiRunRow | null },
  ): AiRunContext | null {
    if (definition.context.length === 0) return null;

    const has = (key: ContextKey) => definition.context.includes(key);

    return {
      review: reviewFingerprint(pr, account),
      ...(has('draft') ? { draft: draftFingerprint(captured.draft!) } : {}),
      ...(has('fullReviewId') ? { fullReviewId: captured.completedReview?.id ?? null } : {}),
    };
  }

  private toRun(row: AiRunRow, currentHead?: string): AiRun {
    const staleReason =
      this.staleReason(row, currentHead) ??
      (row.status === 'paused' && row.request ? this.resumeProblem(row) : null);

    return {
      id: row.id,
      prId: row.prId,
      task: row.task,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      headOid: row.headOid,
      status: row.status,
      progress: row.progress,
      result: row.result ? (JSON.parse(row.result) as AiResult) : null,
      error: row.error,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      stale: Boolean(staleReason),
      staleReason: staleReason && render(staleReason, row.account),
      resumable: Boolean(
        row.request &&
        this.providers[row.provider].supportsResume &&
        ['paused', 'failed', 'interrupted'].includes(row.status) &&
        !this.resumeProblem(row),
      ),
      canPause: Boolean(
        row.request &&
        this.providers[row.provider].supportsResume &&
        ['queued', 'running'].includes(row.status),
      ),
      pauseReason: row.pauseReason,
      creditsUsed: creditsUsed(row.usage),
      trigger: row.trigger,
      ...(TASKS[row.task].reportsInputs
        ? { inputs: row.inputs ?? null, publication: row.publication ?? null }
        : {}),
    };
  }

  private resumeProblem(row: AiRunRow): Wording | null {
    if (row.promptVersion !== TASKS[row.task].promptVersion)
      return 'Review instructions changed. Generate a new review.';

    const pr = this.sync.detailFor(row.account, row.prId)?.snapshot;

    if (!pr) return say('pull.untracked');
    if (!row.request) return 'This run has no saved checkpoint. Generate a new review.';
    if (reviewFingerprint(pr, row.account) !== reviewFingerprint(row.request.snapshot, row.account))
      return say('ai.changed-while-stopped');

    return this.staleReason(row);
  }

  private staleReason(row: AiRunRow, currentHead?: string): Wording | null {
    const pr = this.sync.detailFor(row.account, row.prId)?.snapshot;

    if ((currentHead ?? pr?.headOid) && (currentHead ?? pr?.headOid) !== row.headOid)
      return 'New commits arrived after this was generated.';

    const keys = TASKS[row.task].context;

    if (!pr || keys.length === 0) return null;
    if (!row.context) return say('ai.unverified-coverage');

    // In the task's order: the first that changed is the reason given.
    for (const key of keys) {
      const reason = this.changedSince(row, row.context, key, pr);

      if (reason) return reason;
    }

    return null;
  }

  /** Why the run is stale on `key`, or null while it still holds. */
  private changedSince(
    row: AiRunRow,
    context: AiRunContext,
    key: ContextKey,
    pr: PullRequestDetail['snapshot'],
  ): Wording | null {
    if (key === 'review')
      return context.review !== reviewFingerprint(pr, row.account) ? say('ai.changed-since') : null;

    // Read only once the keys before it held.
    if (key === 'fullReviewId')
      return context.fullReviewId !== (this.completedReview(row.account, row.prId)?.id ?? null)
        ? 'A newer full review is available. Generate a new summary to include it.'
        : null;

    return context.draft !== draftFingerprint(this.reviews.draft(row.account, row.prId))
      ? 'Your verdict or draft comments changed after this summary was generated.'
      : null;
  }

  private completedReview(account: string, prId: string): AiRunRow | null {
    return this.aiRuns.doneReviews(account, prId).find((row) => !this.staleReason(row)) ?? null;
  }

  private row(id: string): AiRunRow | null {
    return this.aiRuns.get(id);
  }

  private update(
    id: string,
    changes: Partial<
      Pick<
        AiRunRow,
        | 'status'
        | 'progress'
        | 'result'
        | 'error'
        | 'model'
        | 'usage'
        | 'finishedAt'
        | 'request'
        | 'threadId'
        | 'pauseReason'
        | 'inputs'
        | 'publication'
      >
    >,
  ) {
    this.aiRuns.update(id, changes);
  }

  private emit(row: Pick<AiRunRow, 'account' | 'prId' | 'id'>) {
    this.events.emit({ type: 'ai.updated', account: row.account, prId: row.prId, runId: row.id });
  }

  async start(
    account: string,
    prId: string,
    task: AiTask,
    options: {
      provider?: AiProvider;
      force?: boolean;
      trigger?: AiRunTrigger;
      /**
       * Asked with the refreshed PR after every await, right before a new run is queued; false
       * refuses the run with NOT_ADMITTED. Cached results are returned without asking.
       */
      admit?: (detail: PullRequestDetail) => boolean;
      /**
       * A start from the web: checked against the draft it saw after every await, and recorded with
       * the run it started or joined, on every admission path, a cached run's included.
       */
      fence?: WriteFence;
    } = {},
  ): Promise<AiRun> {
    // A cached or running run, joined: admitted as a new one is, against the draft it saw.
    const joined = (run: AiRun) => {
      if (options.fence)
        this.sync.store.transaction(() => {
          options.fence!.check();
          options.fence!.committed(run);
        });

      return run;
    };

    const definition = TASKS[task];

    this.detail(account, prId);

    if (definition.refreshFirst)
      this.selected(account, await settled(this.sync.refresh(prId, account)));

    const detail = this.detail(account, prId);
    const settings = this.settings();
    const taskSettings = settings.tasks[task];
    const provider =
      definition.provider ?? options.provider ?? taskSettings.provider ?? settings.defaultProvider;
    // Model ids are Codex's; another agent gets its own default.
    const model = provider === 'codex' ? taskSettings.model : null;

    // Captured once, before the diff is read: the prompt and its context are built from the same.
    const captured = {
      draft: definition.evidence.draft ? this.reviews.draft(account, prId) : null,
      completedReview: definition.evidence.completedReview
        ? this.completedReview(account, prId)
        : null,
    };
    const context = this.contextOf(definition, detail.snapshot, account, captured);
    const input = this.selected(
      account,
      await settled(this.buildInput(definition, detail, account, captured)),
    );
    const head = detail.snapshot.headOid;

    if (definition.recheckRevision) {
      this.selected(account, await settled(this.sync.refresh(prId, account)));

      const latest = this.detail(account, prId).snapshot;

      if (latest.headOid !== head || latest.baseOid !== detail.snapshot.baseOid) {
        throw new ReviewError(
          'HEAD_MOVED',
          409,
          'New commits arrived while preparing the review. Run it again.',
        );
      }
    }
    const key = createHash('sha256')
      .update(
        [
          task,
          provider,
          model ?? '',
          taskSettings.effort,
          definition.promptVersion,
          head,
          input,
          JSON.stringify(context),
        ].join('\u0000'),
      )
      .digest('hex');
    const findExisting = () => this.aiRuns.latestByKey(account, key);
    const existing = findExisting();

    if (existing && (!options.force || ['queued', 'running'].includes(existing.status)))
      return joined(this.toRun(existing, head));

    // A cached answer costs nothing; a new Codex run must fit in the plan.
    if (provider === 'codex') {
      const status = this.selected(account, await settled(this.codexStatus()));

      if (codexBlocked(status)) {
        throw new ReviewError(
          'PLAN_LIMIT',
          409,
          status?.problem ?? 'Codex cannot run on your ChatGPT plan right now.',
        );
      }
    }

    // Concurrent requests can both pass the first lookup while checking the shared plan status.
    const concurrent = findExisting();

    if (concurrent && (!options.force || ['queued', 'running'].includes(concurrent.status)))
      return joined(this.toRun(concurrent, head));

    const id = randomUUID();

    if (this.closing)
      throw new ReviewError('SHUTTING_DOWN', 503, 'The server is restarting. Try again shortly.');

    // In the insert's turn: the account is still in use, and (for an automatic review) the run is
    // still wanted.
    this.assertSelected(account);

    if (options.admit && !options.admit(this.detail(account, prId)))
      throw new ReviewError('NOT_ADMITTED', 409, 'This run is no longer wanted.');

    // Created in one transaction with its fence: checked against the draft the start saw, and
    // recorded with the run.
    this.sync.store.transaction(() => {
      options.fence?.check();
      this.aiRuns.insert({
        id,
        account,
        prId,
        task,
        provider,
        model,
        effort: taskSettings.effort,
        headOid: head,
        promptVersion: definition.promptVersion,
        cacheKey: key,
        context,
        request: {
          input,
          snapshot: structuredClone(detail.snapshot),
          instructions: definition.instructions,
          schema: jsonSchemaFor(task),
        },
        status: 'queued',
        progress: 'Waiting to start…',
        trigger: options.trigger ?? 'manual',
        createdAt: isoNow(this.clock),
      });
      options.fence?.committed(this.toRun(this.row(id)!, head));
    });
    const superseded = this.aiRuns.withStatus(account, prId, task, [
      'paused',
      'failed',
      'interrupted',
    ]);

    for (const previous of superseded) this.cancel(account, previous.id);
    this.queue.push(id);
    this.emit({ id, account, prId });
    this.pump();

    return this.toRun(this.row(id)!, head);
  }

  /** Starts queued runs up to the limit; none start before `open()` has settled old ones. */
  private pump(): void {
    while (this.opened && !this.closing && this.active.size < MAX_CONCURRENT) {
      const id = this.queue.shift();

      if (!id) return;

      // A run keeps its own account's GitHub access if you switch accounts while it runs: it
      // binds to that account as it starts (`execute`).
      const execution = this.execute(id);

      this.executions.set(id, execution);
      void execution.finally(() => this.executions.delete(id));
    }
  }

  async close(): Promise<void> {
    this.closing = true;

    for (const id of [...this.queue, ...this.active.keys()]) {
      const row = this.row(id);

      if (!row) continue;
      if (row.request && this.providers[row.provider].supportsResume)
        this.pause(row.account, id, 'restart');
      else this.cancel(row.account, id);
    }

    await Promise.allSettled(this.executions.values());
    await this.cleanedUp();
  }

  private async execute(id: string): Promise<void> {
    const row = this.row(id);
    const saved = row?.request;

    if (!row || !saved) return;

    // Bound as the run starts, and kept to its end whatever is selected meanwhile.
    const forge = row.account ? bindForge(this.sync.github, row.account) : this.sync.github;
    // The archives share the run's credentials: the same source, not a second binding.
    const access = archiveAccess(row.account, forge);
    const controller = new AbortController();
    const workDir = join(this.workRoot, id);
    /** When progress was last sent to the app, on the monotonic clock; null before the first. */
    let lastEmit: number | null = null;
    let validCheckpoint = true;

    this.active.set(id, controller);
    this.update(id, {
      status: 'running',
      progress: row.threadId ? 'Resuming saved review…' : 'Starting…',
      pauseReason: null,
    });
    this.emit(row);

    try {
      mkdirSync(workDir, { recursive: true, mode: 0o700 });

      let context: PreparedContext | null = null;

      try {
        context = JSON.parse(readFileSync(join(workDir, 'review.json'), 'utf8'));
      } catch {
        // A missing or incomplete workspace is rebuilt at the original commits.
      }

      const prepared =
        context?.headOid === row.headOid && context.repository === saved.snapshot.repository;

      if (TASKS[row.task].execution === 'workspace') {
        let measured: ReviewInputs | null;

        if (prepared && context) {
          measured = await revalidated(
            workDir,
            context,
            saved.snapshot,
            this.row(id)?.inputs ?? null,
          );
        } else {
          this.update(id, { progress: 'Preparing review…' });
          this.emit(row);

          const snapshot = saved.snapshot;
          const diff = await this.diffs.manifest(snapshot, 'full', null, row.account, forge);

          for (const path of ['before', 'after', 'review.json'])
            await rm(join(workDir, path), { recursive: true, force: true });

          measured = await prepareReviewWorkspace(
            forge,
            snapshot,
            diff,
            workDir,
            controller.signal,
            this.exportRepository,
            access,
          );
        }

        // Saved before the agent's turn, for the answer that turn gives (see `evidence`).
        this.update(id, { inputs: evidence(this.row(id), measured, saved.snapshot) });
      }

      // Stopped or paused while the workspace was prepared: never start the agent.
      controller.signal.throwIfAborted();

      const result = await this.providers[row.provider].run(
        {
          instructions: saved.instructions,
          input: saved.input,
          schema: saved.schema,
          effort: row.effort,
          model: row.model,
          workDir,
          timeoutMs: TASKS[row.task].timeoutMs,
          task: row.task,
          threadId: row.threadId,
          onThread: (threadId, model) => this.update(id, { threadId, model }),
        },
        controller.signal,
        (progress) => {
          if (controller.signal.aborted) return;

          this.update(id, { progress });

          // Paced by elapsed time: a wall-clock change cannot hold progress back.
          if (lastEmit === null || performance.now() - lastEmit > 400) {
            lastEmit = performance.now();
            this.emit(row);
          }
        },
      );
      controller.signal.throwIfAborted();
      const parsed = TASKS[row.task].schema.safeParse(result.output);

      if (!parsed.success) {
        validCheckpoint = false;
        throw new Error('The agent returned an answer in an unexpected shape.');
      }

      const definition = TASKS[row.task];
      const output = definition.anchor
        ? await this.anchor(row, definition, parsed.data, forge)
        : parsed.data;
      controller.signal.throwIfAborted();

      this.settle(
        id,
        {
          status: 'done',
          progress: null,
          model: result.model,
          result: redact(JSON.stringify(output)),
          usage: result.usage ? JSON.stringify(result.usage) : null,
          finishedAt: isoNow(this.clock),
          request: null,
        },
        saved.snapshot,
      );
    } catch (error) {
      if (this.row(id)?.status !== 'paused')
        this.settle(id, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          progress: null,
          error: controller.signal.aborted ? null : safeError(error),
          finishedAt: isoNow(this.clock),
          ...(controller.signal.aborted ||
          !validCheckpoint ||
          !this.providers[row.provider].supportsResume
            ? { request: null }
            : {}),
        });
    } finally {
      // A Codex run changes the plan's usage; read it afresh next time.
      if (row.provider === 'codex') this.codexAccount = null;

      this.active.delete(id);
      const current = this.row(id);
      const keepWorkspace =
        current?.status === 'paused' ||
        (current?.status === 'failed' &&
          current.request &&
          this.providers[row.provider].supportsResume);

      if (!keepWorkspace) this.removeLater(id);
      this.emit(row);
      this.pump();

      if (current) {
        try {
          this.onFinished?.(current);
        } catch {
          // A listener must never break the queue.
        }
      }
    }
  }

  /**
   * Records how a run ended, together with what `onSettled` saves about a done or failed run and,
   * for a done run, what `onPublish` decides to post about the snapshot it reviewed.
   */
  private settle(
    id: string,
    changes: Parameters<AiRunner['update']>[1],
    reviewed?: PullRequestSnapshot,
  ): void {
    this.sync.store.transaction(() => {
      this.update(id, changes);

      const row = this.row(id);

      if (row?.status !== 'done' && row?.status !== 'failed') return;

      try {
        this.onSettled?.(row);
      } catch {
        // A listener must never lose the run's outcome.
      }

      // Outside that catch: a decision that cannot be saved takes the outcome back with it.
      if (row.status === 'done' && reviewed) this.onPublish?.(row, reviewed);
    });
  }

  /** Saves whether a settling run is posted; called by `onPublish`, inside its transaction. */
  recordPublication(id: string, publication: NonNullable<AiRunRow['publication']>): void {
    this.update(id, { publication });
  }

  /**
   * The answer, anchored by its task to the full diff of the run's own snapshot, read with the
   * run's own binding: as the account the run started as, whatever is in use now.
   */
  private async anchor(
    row: AiRunRow,
    definition: TaskDefinition,
    result: unknown,
    forge: GitHubApi,
  ): Promise<unknown> {
    const snapshot = row.request?.snapshot ?? this.sync.detailFor(row.account, row.prId)?.snapshot;

    if (!snapshot) return result;

    const full = await this.diffs.manifest(snapshot, 'full', null, row.account, forge);

    return definition.anchor!(result, full);
  }

  cancel(account: string, id: string): void {
    const row = this.row(id);

    if (!row || row.account !== account)
      throw new ReviewError('NOT_FOUND', 404, 'That run no longer exists.');

    const active = this.active.get(id);

    if (active) {
      this.update(id, {
        status: 'cancelled',
        request: null,
        pauseReason: null,
        progress: null,
        error: null,
        finishedAt: isoNow(this.clock),
      });
      // The run's own end removes its workspace, once preparation and the agent have unwound.
      this.sync.store.afterCommit(() => {
        active.abort();
        this.emit(row);
      });
      return;
    }

    if (this.queue.includes(id)) {
      this.update(id, {
        status: 'cancelled',
        request: null,
        progress: null,
        finishedAt: isoNow(this.clock),
      });
      this.sync.store.afterCommit(() => {
        const queued = this.queue.indexOf(id);

        if (queued !== -1) this.queue.splice(queued, 1);
        this.emit(row);
        this.removeLater(id);
      });
    }

    if (['paused', 'failed', 'interrupted'].includes(row.status)) {
      this.update(id, {
        status: 'cancelled',
        request: null,
        pauseReason: null,
        error: null,
        progress: null,
        finishedAt: isoNow(this.clock),
      });
      this.sync.store.afterCommit(() => {
        this.emit(row);
        this.removeLater(id);
      });
    }
  }

  pause(account: string, id: string, reason: 'user' | 'restart' = 'user'): void {
    const row = this.row(id);

    if (!row || row.account !== account)
      throw new ReviewError('NOT_FOUND', 404, 'That run no longer exists.');
    if (!['queued', 'running'].includes(row.status)) return;
    if (!row.request || !this.providers[row.provider].supportsResume)
      throw new ReviewError('CANNOT_PAUSE', 409, 'This agent does not support pausing.');

    const queued = this.queue.indexOf(id);

    if (queued !== -1) this.queue.splice(queued, 1);
    this.update(id, {
      status: 'paused',
      pauseReason: reason,
      progress:
        reason === 'restart' ? 'Saved for recovery after restart.' : 'Paused. Progress is saved.',
      error: null,
      finishedAt: null,
    });
    this.active.get(id)?.abort();
    this.emit(row);
  }

  async resume(account: string, id: string): Promise<AiRun> {
    let row = this.row(id);

    if (!row || row.account !== account)
      throw new ReviewError('NOT_FOUND', 404, 'That run no longer exists.');
    this.detail(account, row.prId);

    if (['queued', 'running'].includes(row.status)) return this.toRun(row);
    if (
      !row.request ||
      !this.providers[row.provider].supportsResume ||
      !['paused', 'failed', 'interrupted'].includes(row.status)
    )
      throw new ReviewError(
        'CANNOT_RESUME',
        409,
        'This run cannot be resumed. Generate a new review.',
      );

    // A pause may still be waiting for the old process to flush and exit. Never overlap turns.
    if (this.active.has(id))
      this.selected(account, await settled(Promise.resolve(this.executions.get(id))));

    // Nor with the run's previous agent, which a stop has signalled but which may not have exited
    // yet, or which a server that was killed outright left behind: its lock says until it has.
    if (
      !this.selected(
        account,
        await settled(agentExited(join(this.workRoot, id), this.agentExitWaitMs)),
      )
    )
      throw new ReviewError(
        'AGENT_STILL_RUNNING',
        409,
        'The previous AI agent for this review is still stopping. Try again shortly.',
      );

    this.selected(account, await settled(this.sync.refresh(row.prId, row.account)));
    const problem = this.resumeProblem(row);

    if (problem) throw new ReviewError('STALE_REVIEW', 409, problem);
    if (row.provider === 'codex') {
      const status = this.selected(account, await settled(this.codexStatus()));

      if (codexBlocked(status))
        throw new ReviewError(
          'PLAN_LIMIT',
          409,
          status?.problem ?? 'Codex is paused until your plan has usage available.',
        );
    }

    row = this.row(id)!;

    if (['queued', 'running'].includes(row.status)) return this.toRun(row);
    if (this.closing)
      throw new ReviewError('SHUTTING_DOWN', 503, 'The server is restarting. Try again shortly.');
    if (!row.request || !['paused', 'failed', 'interrupted'].includes(row.status))
      throw new ReviewError('CANNOT_RESUME', 409, 'This run is no longer resumable.');
    const changed = this.resumeProblem(row);

    if (changed) throw new ReviewError('STALE_REVIEW', 409, changed);

    // In the turn that queues it: the account is still in use.
    this.assertSelected(account);
    this.update(id, {
      status: 'queued',
      pauseReason: null,
      progress: 'Waiting to resume…',
      error: null,
      finishedAt: null,
    });
    this.queue.push(id);
    this.emit(row);
    this.pump();

    return this.toRun(this.row(id)!);
  }

  async recover(account: string): Promise<void> {
    if (this.closing) return;

    const rows = this.aiRuns.pausedByRestart(account);

    for (const row of rows) {
      // Its previous agent is still running (a server killed outright left it, and it has not
      // ended yet): left paused, and the next sync tries again.
      if (agentRunning(join(this.workRoot, row.id))) continue;

      try {
        await this.resume(account, row.id);
      } catch (error) {
        this.update(row.id, { error: safeError(error) });
        this.emit(row);
      }
    }
  }

  /** A run of the task on this PR that is queued, running or paused, if there is one. */
  activeRun(account: string, prId: string, task: AiTask): AiRunRow | null {
    return this.aiRuns.active(account, prId, task);
  }

  /** The latest full review of each tracked PR, for list badges. Restarts are AutoReviewer's. */
  reviewStatuses(
    account: string,
  ): (Omit<AiReviewStatus, 'restartAt'> & { runId: string; status: AiRunStatus })[] {
    const rows = this.aiRuns.reviews(account);
    const latest = new Map<string, AiRunRow>();

    for (const row of rows) if (!latest.has(row.prId)) latest.set(row.prId, row);

    return [...latest.values()]
      .filter((row) => this.sync.detailFor(account, row.prId))
      .map((row) => ({
        prId: row.prId,
        runId: row.id,
        status: row.status,
        stale: Boolean(this.staleReason(row)),
        trigger: row.trigger,
      }));
  }

  /** Keep the latest attempt and latest completed result so a failed retry never loses a review. */
  runs(account: string, prId: string): AiRun[] {
    const head = this.sync.detailFor(account, prId)?.snapshot.headOid;
    const rows = this.aiRuns.forPull(account, prId);
    const latest = new Map<AiTask, AiRunRow>();
    const completed = new Map<AiTask, AiRunRow>();

    for (const row of rows) {
      if (!latest.has(row.task)) latest.set(row.task, row);
      if (row.status === 'done' && !completed.has(row.task)) completed.set(row.task, row);
    }
    const ids = new Set([...latest.values(), ...completed.values()].map((row) => row.id));

    return rows.filter((row) => ids.has(row.id)).map((row) => this.toRun(row, head));
  }

  /** Copies one suggested comment into the user's draft review; nothing is posted. */
  async accept(
    account: string,
    id: string,
    index: number,
    body?: string,
    fence?: WriteFence,
  ): Promise<DraftComment> {
    const row = this.row(id);

    if (!row || row.account !== account || row.task !== 'draft_comments' || !row.result) {
      throw new ReviewError('NOT_FOUND', 404, 'That suggestion no longer exists.');
    }

    const suggestion = (JSON.parse(row.result) as DraftCommentsResult).comments[index];

    if (!suggestion) throw new ReviewError('NOT_FOUND', 404, 'That suggestion no longer exists.');

    // Made for the head it read: on another head its lines are other lines. Checked here, and again
    // where the comment is written, after the diff check's read.
    if (this.detail(account, row.prId).snapshot.headOid !== row.headOid) throw headMoved();

    return this.reviews.addComment(
      row.prId,
      {
        account,
        path: suggestion.path,
        line: suggestion.line,
        side: suggestion.side,
        body: body ?? suggestion.body,
        origin: 'ai',
      },
      { expectedHeadOid: row.headOid, fence },
    );
  }

  /** Prepare a summary with selected findings, without creating inline review comments. */
  async prepareReview(
    account: string,
    id: string,
    indices: number[],
    options: PrepareReviewOptions = {},
    fence?: WriteFence,
  ): Promise<ReviewDraft> {
    const row = this.row(id);

    if (
      !row ||
      row.account !== account ||
      row.task !== 'full_review' ||
      row.status !== 'done' ||
      !row.result
    ) {
      throw new ReviewError('NOT_FOUND', 404, 'That completed review is unavailable.');
    }

    this.detail(account, row.prId);
    this.reviews.drafts.assertEditable(account, row.prId);

    const initialRevision = preparationRevision(this.reviews.draft(account, row.prId));

    this.selected(account, await settled(this.sync.refresh(row.prId, row.account)));

    const staleReason = this.staleReason(row);

    if (staleReason) {
      throw new ReviewError('HEAD_MOVED', 409, say('ai.outdated', { reason: staleReason }));
    }

    const result = JSON.parse(row.result) as FullReviewResult;
    const selected = [...new Set(indices)].map((index) => result.comments[index]);

    if (selected.some((comment) => !comment)) {
      throw new ReviewError('NOT_FOUND', 404, 'One of the selected findings is unavailable.');
    }

    const draft = this.reviews.draft(account, row.prId);
    const indicesKey = (values: number[]) => [...new Set(values)].sort((a, b) => a - b).join(',');

    if (
      draft.preparedReview?.runId === id &&
      indicesKey(draft.preparedReview.indices) === indicesKey(indices) &&
      draft.preparedReview.content?.comments.length === 0
    )
      return this.unchanged(fence, account, row.prId);

    const summary = [
      result.overall,
      ...selected.map(
        (comment) =>
          `### ${comment.severity}: ${comment.path}${comment.line === null ? '' : `:${comment.line}`}\n${comment.body}`,
      ),
    ].join('\n\n');

    if (selected.some((comment) => comment.body.length > 65_536 || !comment.body.trim())) {
      throw new ReviewError(
        'INVALID_REVIEW',
        422,
        'This review is too large to post. Select fewer findings.',
      );
    }

    const latest = this.detail(account, row.prId).snapshot;

    if (latest.headOid !== row.headOid || this.staleReason(row)) {
      throw new ReviewError('HEAD_MOVED', 409, say('ai.new-commits'));
    }

    // One synchronous transaction avoids partial drafts or duplicate comments on retries. Its
    // fence is checked first, and records the draft it leaves.
    const prepared = this.sync.store.transaction(() => {
      fence?.check();
      this.reviews.drafts.assertEditable(account, row.prId);

      const current = this.reviews.draft(account, row.prId);

      if (
        current.preparedReview?.runId === id &&
        indicesKey(current.preparedReview.indices) === indicesKey(indices) &&
        current.preparedReview.content?.comments.length === 0
      ) {
        fence?.committed(current);

        return current;
      }

      if (preparationRevision(current) !== initialRevision) throw draftChanged();

      const previousRun = current.preparedReview && this.row(current.preparedReview.runId);

      if (previousRun && previousRun.createdAt > row.createdAt) throw draftChanged();

      const { body, removeIds, previousDrafts } = planPreparation(current, summary, options);

      if (body.length > 65_536)
        throw new ReviewError(
          'INVALID_REVIEW',
          422,
          'This review is too large to post. Select fewer findings.',
        );

      for (const commentId of removeIds) this.reviews.drafts.deleteComment(account, commentId);

      this.reviews.drafts.saveMeta(account, row.prId, {
        body,
        event: hasBlockingFindings(result) ? 'COMMENT' : 'APPROVE',
        preparedReview: {
          runId: id,
          preparedAt: isoNow(this.clock),
          indices: [...new Set(indices)].sort((a, b) => a - b),
          content: { summary, comments: [] },
          ...(previousDrafts.length ? { previousDrafts } : {}),
        },
      });

      const left = this.reviews.draft(account, row.prId);

      fence?.committed(left);

      return left;
    });
    this.events.emit({ type: 'draft.updated', account: row.account, id: row.prId });

    return prepared;
  }

  /**
   * A draft write that finds nothing to change: still admitted against the draft it saw, and
   * recorded with the draft as it is.
   */
  private unchanged(fence: WriteFence | undefined, account: string, prId: string): ReviewDraft {
    return this.sync.store.transaction(() => {
      fence?.check();

      const draft = this.reviews.draft(account, prId);

      fence?.committed(draft);

      return draft;
    });
  }

  /** The PR a run of `account`'s is about, or null when there is no such run. */
  runPr(account: string, id: string): string | null {
    const row = this.row(id);

    return row && row.account === account ? row.prId : null;
  }

  /** `account`'s draft of `prId`, as draft answers give it. */
  draftOf(account: string, prId: string): ReviewDraft {
    return this.reviews.draft(account, prId);
  }

  /** Apply an explicitly selected summary only after checking its evidence against live GitHub. */
  async applySummary(account: string, id: string, fence?: WriteFence): Promise<ReviewDraft> {
    const row = this.row(id);

    if (
      !row ||
      row.account !== account ||
      row.task !== 'draft_summary' ||
      row.status !== 'done' ||
      !row.result
    )
      throw new ReviewError('NOT_FOUND', 404, 'That generated summary is unavailable.');

    this.detail(account, row.prId);
    this.reviews.drafts.assertEditable(account, row.prId);
    this.selected(account, await settled(this.sync.refresh(row.prId, row.account)));
    this.detail(account, row.prId);

    const reason = this.staleReason(row);

    if (reason) throw new ReviewError('STALE_REVIEW', 409, say('ai.stale-summary', { reason }));

    // Applied in one transaction with its fence, which records the draft it leaves.
    const applied = this.sync.store.transaction(() => {
      fence?.check();
      this.reviews.drafts.saveMeta(account, row.prId, {
        body: (JSON.parse(row.result!) as { body: string }).body,
      });

      const left = this.reviews.draft(account, row.prId);

      fence?.committed(left);

      return left;
    });

    this.events.emit({ type: 'draft.updated', account: row.account, id: row.prId });

    return applied;
  }
}
