import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  codexBlocked,
  defaultAiSettings,
  type AiProvider,
  type AiProviderStatus,
  type AiResult,
  type AiReviewStatus,
  type AiRun,
  type AiRunContext,
  type AiRunTrigger,
  type AiSettings,
  type AiTask,
  type CodexAccountStatus,
  type DraftCommentsResult,
  type FullReviewResult,
} from '@review-desk/shared/ai';
import { commentableLines } from '@review-desk/shared/diff';
import type { DraftComment, PrepareReviewOptions, ReviewDraft } from '@review-desk/shared/review';
import type { PullRequestDetail } from '@review-desk/shared/types';
import { aiRuns, type AiRunRow } from '@/db/schema.js';
import type { DiffService } from '@/diff/service.js';
import type { EventBus } from '@/events.js';
import { asAccount } from '@/github/credentials.js';
import { redact, safeError } from '@/github/errors.js';
import { ReviewError, type ReviewService } from '@/review/service.js';
import type { SyncService } from '@/sync/service.js';
import {
  authorFeedbackInput,
  briefInput,
  draftCommentsInput,
  draftSummaryInput,
  fullReviewInput,
  sinceReviewInput,
} from '@/ai/context.js';
import type { AgentProvider } from '@/ai/provider.js';
import { draftFingerprint, reviewFingerprint } from '@/ai/freshness.js';
import {
  draftChanged,
  planPreparation,
  preparationRevision,
  preparedCommentFingerprint,
} from '@/ai/preparation.js';
import { instructions, jsonSchemaFor, promptVersions, taskSchemas, timeouts } from '@/ai/tasks.js';
import {
  downloadRepository,
  prepareReviewWorkspace,
  type RepositoryExporter,
} from '@/ai/workspace.js';

const MAX_CONCURRENT = 2;
const PROBE_TTL_MS = 5 * 60_000;
const ACCOUNT_TTL_MS = 60_000;
const SETTINGS_KEY = 'ai-settings';

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
export class AiRunner {
  private readonly queue: string[] = [];
  private readonly executions = new Map<string, Promise<void>>();
  private closing = false;
  private readonly active = new Map<string, AbortController>();
  private probes: { at: number; statuses: AiProviderStatus[] } | null = null;
  private codexAccount: { at: number; status: Promise<CodexAccountStatus | null> } | null = null;

  /** Called once a run settles (done, failed, cancelled or paused), after its row is written. */
  onFinished?: (row: AiRunRow) => void;

  constructor(
    private readonly sync: SyncService,
    private readonly diffs: DiffService,
    private readonly reviews: ReviewService,
    private readonly events: EventBus,
    readonly providers: Record<AiProvider, AgentProvider>,
    private readonly workRoot: string,
    private readonly exportRepository: RepositoryExporter = downloadRepository,
  ) {
    const unfinished = this.db
      .select()
      .from(aiRuns)
      .where(inArray(aiRuns.status, ['queued', 'running']))
      .all();

    for (const row of unfinished) {
      const resumable = Boolean(row.request && this.providers[row.provider].supportsResume);

      this.db
        .update(aiRuns)
        .set(
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
                finishedAt: new Date().toISOString(),
              },
        )
        .where(eq(aiRuns.id, row.id))
        .run();
    }
  }

  private get db() {
    return this.sync.store.db;
  }

  settings(): AiSettings {
    const saved = this.sync.store.getSetting<Partial<AiSettings>>(SETTINGS_KEY);
    const defaults = defaultAiSettings();

    return {
      defaultProvider: saved?.defaultProvider ?? defaults.defaultProvider,
      tasks: Object.fromEntries(
        Object.entries(defaults.tasks).map(([task, value]) => [
          task,
          { ...value, ...saved?.tasks?.[task as AiTask] },
        ]),
      ) as AiSettings['tasks'],
      autoReview: { ...defaults.autoReview, ...saved?.autoReview },
      postFindings: saved?.postFindings ?? defaults.postFindings,
    };
  }

  /**
   * Saves settings. `autoReview.since` is the server's: set when turned on, cleared when off.
   * Settings left out keep their saved value.
   */
  saveSettings(
    settings: Omit<AiSettings, 'autoReview' | 'postFindings'> & {
      autoReview?: { enabled: boolean };
      postFindings?: boolean;
    },
  ): AiSettings {
    const current = this.settings();
    const previous = current.autoReview;
    const enabled = settings.autoReview?.enabled ?? previous.enabled;
    const since = !enabled
      ? null
      : previous.enabled && previous.since
        ? previous.since
        : new Date().toISOString();

    this.sync.store.setSetting(SETTINGS_KEY, {
      ...settings,
      tasks: {
        ...settings.tasks,
        full_review: { ...settings.tasks.full_review, provider: 'codex' },
      },
      autoReview: { enabled, since },
      postFindings: settings.postFindings ?? current.postFindings,
    });

    return this.settings();
  }

  async providerStatuses(): Promise<AiProviderStatus[]> {
    if (this.probes && Date.now() - this.probes.at < PROBE_TTL_MS) return this.probes.statuses;

    const statuses = await Promise.all(
      Object.values(this.providers).map(async (provider) => ({
        id: provider.id,
        label: provider.label,
        demo: provider.demo,
        ...(await provider.probe()),
      })),
    );

    this.probes = { at: Date.now(), statuses };

    return statuses;
  }

  /** The Codex sign-in and plan usage, read through app-server at most once a minute. */
  codexStatus(): Promise<CodexAccountStatus | null> {
    const provider = this.providers.codex;

    if (!provider.status) return Promise.resolve(null);
    if (this.codexAccount && Date.now() - this.codexAccount.at < ACCOUNT_TTL_MS)
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

    this.codexAccount = { at: Date.now(), status };

    return status;
  }

  private detail(account: string, prId: string): PullRequestDetail {
    if (account !== this.sync.status.account?.login) {
      throw new ReviewError('ACCOUNT_CHANGED', 409, 'GitHub account changed. Refresh first.');
    }

    const detail = this.sync.detail(prId);

    if (!detail) throw new ReviewError('NOT_FOUND', 404, 'This PR is no longer tracked.');

    return detail;
  }

  private async buildInput(
    task: AiTask,
    detail: PullRequestDetail,
    account: string,
    completedReview: AiRunRow | null,
  ): Promise<string> {
    const pr = detail.snapshot;

    if (task === 'full_review')
      return fullReviewInput(pr, await this.diffs.manifest(pr, 'full', null));
    if (task === 'brief') return briefInput(pr, await this.diffs.manifest(pr, 'full', null));
    if (task === 'draft_comments')
      return draftCommentsInput(pr, await this.diffs.manifest(pr, 'full', null));
    if (task === 'author_feedback') return authorFeedbackInput(pr);

    if (task === 'draft_summary') {
      const draft = this.reviews.draft(account, pr.id);
      return draftSummaryInput(
        pr,
        await this.diffs.manifest(pr, 'full', null),
        draft,
        completedReview?.result ? (JSON.parse(completedReview.result) as FullReviewResult) : null,
      );
    }

    const reviewOid = detail.item.latestReview?.commitOid;

    if (!reviewOid) throw new ReviewError('NO_REVIEW', 422, 'You have not reviewed this PR yet.');

    return sinceReviewInput(pr, await this.diffs.manifest(pr, 'since-review', reviewOid), account);
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
      staleReason,
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
    };
  }

  private resumeProblem(row: AiRunRow): string | null {
    if (row.promptVersion !== promptVersions[row.task])
      return 'Review instructions changed. Generate a new review.';

    const pr = this.sync.detail(row.prId)?.snapshot;

    if (!pr) return 'This PR is no longer tracked.';
    if (!row.request) return 'This run has no saved checkpoint. Generate a new review.';
    if (reviewFingerprint(pr, row.account) !== reviewFingerprint(row.request.snapshot, row.account))
      return 'The PR or its review discussion changed while this run was stopped. Generate a new review.';

    return this.staleReason(row);
  }

  private staleReason(row: AiRunRow, currentHead?: string): string | null {
    const pr = this.sync.detail(row.prId)?.snapshot;

    if ((currentHead ?? pr?.headOid) && (currentHead ?? pr?.headOid) !== row.headOid)
      return 'New commits arrived after this was generated.';

    if (!pr || !['full_review', 'draft_summary'].includes(row.task)) return null;
    if (!row.context) return 'Generate a new review to verify that it covers the current PR.';
    if (row.context.review !== reviewFingerprint(pr, row.account))
      return 'The PR or its review discussion changed after this was generated.';

    if (row.task === 'draft_summary') {
      if (row.context.fullReviewId !== (this.completedReview(row.account, row.prId)?.id ?? null))
        return 'A newer full review is available. Generate a new summary to include it.';
      if (row.context.draft !== draftFingerprint(this.reviews.draft(row.account, row.prId)))
        return 'Your verdict or draft comments changed after this summary was generated.';
    }

    return null;
  }

  private completedReview(account: string, prId: string): AiRunRow | null {
    const rows = this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.account, account),
          eq(aiRuns.prId, prId),
          eq(aiRuns.task, 'full_review'),
          eq(aiRuns.status, 'done'),
        ),
      )
      .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
      .all();

    return rows.find((row) => !this.staleReason(row)) ?? null;
  }

  private row(id: string): AiRunRow | null {
    return this.db.select().from(aiRuns).where(eq(aiRuns.id, id)).get() ?? null;
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
      >
    >,
  ) {
    if (Object.keys(changes).length === 0) return;

    this.db.update(aiRuns).set(changes).where(eq(aiRuns.id, id)).run();
  }

  private emit(row: Pick<AiRunRow, 'prId' | 'id'>) {
    this.events.emit({ type: 'ai.updated', prId: row.prId, runId: row.id });
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
    } = {},
  ): Promise<AiRun> {
    this.detail(account, prId);

    if (task === 'full_review' || task === 'draft_summary') await this.sync.refresh(prId);

    const detail = this.detail(account, prId);
    const settings = this.settings();
    const taskSettings = settings.tasks[task];
    const provider =
      task === 'full_review'
        ? 'codex'
        : (options.provider ?? taskSettings.provider ?? settings.defaultProvider);
    // Model ids are Codex's; another agent gets its own default.
    const model = provider === 'codex' ? taskSettings.model : null;

    const completedReview = task === 'draft_summary' ? this.completedReview(account, prId) : null;
    const context: AiRunContext | null = ['full_review', 'draft_summary'].includes(task)
      ? {
          review: reviewFingerprint(detail.snapshot, account),
          ...(task === 'draft_summary'
            ? {
                draft: draftFingerprint(this.reviews.draft(account, prId)),
                fullReviewId: completedReview?.id ?? null,
              }
            : {}),
        }
      : null;
    const input = await this.buildInput(task, detail, account, completedReview);
    const head = detail.snapshot.headOid;

    if (task === 'full_review') {
      await this.sync.refresh(prId);

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
          promptVersions[task],
          head,
          input,
          JSON.stringify(context),
        ].join('\u0000'),
      )
      .digest('hex');
    const findExisting = () =>
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.account, account),
            eq(aiRuns.cacheKey, key),
            inArray(aiRuns.status, ['queued', 'running', 'paused', 'done']),
          ),
        )
        .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get();
    const existing = findExisting();

    if (existing && (!options.force || ['queued', 'running'].includes(existing.status)))
      return this.toRun(existing, head);

    // A cached answer costs nothing; a new Codex run must fit in the plan.
    if (provider === 'codex') {
      const status = await this.codexStatus();

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
      return this.toRun(concurrent, head);

    const id = randomUUID();

    if (this.closing)
      throw new ReviewError('SHUTTING_DOWN', 503, 'The server is restarting. Try again shortly.');
    if (options.admit && !options.admit(this.detail(account, prId)))
      throw new ReviewError('NOT_ADMITTED', 409, 'This run is no longer wanted.');

    this.db
      .insert(aiRuns)
      .values({
        id,
        account,
        prId,
        task,
        provider,
        model,
        effort: taskSettings.effort,
        headOid: head,
        promptVersion: promptVersions[task],
        cacheKey: key,
        context,
        request: {
          input,
          snapshot: structuredClone(detail.snapshot),
          instructions: instructions[task],
          schema: jsonSchemaFor(task),
        },
        status: 'queued',
        progress: 'Waiting to start…',
        trigger: options.trigger ?? 'manual',
        createdAt: new Date().toISOString(),
      })
      .run();
    const superseded = this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.account, account),
          eq(aiRuns.prId, prId),
          eq(aiRuns.task, task),
          inArray(aiRuns.status, ['paused', 'failed', 'interrupted']),
        ),
      )
      .all();

    for (const previous of superseded) this.cancel(account, previous.id);
    this.queue.push(id);
    this.emit({ id, prId });
    this.pump();

    return this.toRun(this.row(id)!, head);
  }

  private pump(): void {
    while (!this.closing && this.active.size < MAX_CONCURRENT) {
      const id = this.queue.shift();

      if (!id) return;

      // A run keeps its own account's GitHub access if you switch accounts while it runs.
      const account = this.row(id)?.account;
      const execution = account ? asAccount(account, () => this.execute(id)) : this.execute(id);

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
  }

  private async execute(id: string): Promise<void> {
    const row = this.row(id);
    const saved = row?.request;

    if (!row || !saved) return;

    const controller = new AbortController();
    const workDir = join(this.workRoot, id);
    let lastEmit = 0;
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

      let prepared = false;

      try {
        const context = JSON.parse(readFileSync(join(workDir, 'review.json'), 'utf8'));

        prepared =
          context.headOid === row.headOid && context.repository === saved.snapshot.repository;
      } catch {
        // A missing or incomplete workspace is rebuilt at the original commits.
      }

      if (row.task === 'full_review' && !prepared) {
        this.update(id, { progress: 'Preparing review…' });
        this.emit(row);

        const snapshot = saved.snapshot;
        const diff = await this.diffs.manifest(snapshot, 'full', null);

        for (const path of ['before', 'after', 'review.json'])
          rmSync(join(workDir, path), { recursive: true, force: true });

        await prepareReviewWorkspace(
          this.sync.github,
          snapshot,
          diff,
          workDir,
          controller.signal,
          this.exportRepository,
        );
      }

      const result = await this.providers[row.provider].run(
        {
          instructions: saved.instructions,
          input: saved.input,
          schema: saved.schema,
          effort: row.effort,
          model: row.model,
          workDir,
          timeoutMs: timeouts[row.task],
          threadId: row.threadId,
          onThread: (threadId, model) => this.update(id, { threadId, model }),
        },
        controller.signal,
        (progress) => {
          if (controller.signal.aborted) return;

          this.update(id, { progress });

          if (Date.now() - lastEmit > 400) {
            lastEmit = Date.now();
            this.emit(row);
          }
        },
      );
      controller.signal.throwIfAborted();
      const parsed = taskSchemas[row.task].safeParse(result.output);

      if (!parsed.success) {
        validCheckpoint = false;
        throw new Error('The agent returned an answer in an unexpected shape.');
      }

      const output =
        row.task === 'draft_comments' || row.task === 'full_review'
          ? await this.anchor(row, parsed.data as DraftCommentsResult)
          : parsed.data;
      controller.signal.throwIfAborted();

      this.update(id, {
        status: 'done',
        progress: null,
        model: result.model,
        result: redact(JSON.stringify(output)),
        usage: result.usage ? JSON.stringify(result.usage) : null,
        finishedAt: new Date().toISOString(),
        request: null,
      });
    } catch (error) {
      if (this.row(id)?.status !== 'paused')
        this.update(id, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          progress: null,
          error: controller.signal.aborted ? null : safeError(error),
          finishedAt: new Date().toISOString(),
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

      if (!keepWorkspace) rmSync(workDir, { recursive: true, force: true });
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

  /** Keeps only anchors GitHub would accept; the rest stay as unanchored suggestions. */
  private async anchor(row: AiRunRow, result: DraftCommentsResult): Promise<DraftCommentsResult> {
    // The run's own snapshot, since the active account may have changed while it ran.
    const snapshot = row.request?.snapshot ?? this.sync.detail(row.prId)?.snapshot;

    if (!snapshot) return result;

    const full = await this.diffs.manifest(snapshot, 'full', null);

    return {
      ...result,
      comments: result.comments.map((comment) => {
        const file = full.files.find((candidate) => candidate.path === comment.path);
        const lines = commentableLines(file?.patch);
        const visible = comment.side === 'LEFT' ? lines.left : lines.right;

        return file && comment.line !== null && visible.has(comment.line)
          ? comment
          : { ...comment, line: null };
      }),
    };
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
        finishedAt: new Date().toISOString(),
      });
      active.abort();
      this.emit(row);
      return;
    }

    const queued = this.queue.indexOf(id);

    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.update(id, {
        status: 'cancelled',
        request: null,
        progress: null,
        finishedAt: new Date().toISOString(),
      });
      rmSync(join(this.workRoot, id), { recursive: true, force: true });
      this.emit(row);
    }

    if (['paused', 'failed', 'interrupted'].includes(row.status)) {
      this.update(id, {
        status: 'cancelled',
        request: null,
        pauseReason: null,
        error: null,
        progress: null,
        finishedAt: new Date().toISOString(),
      });
      rmSync(join(this.workRoot, id), { recursive: true, force: true });
      this.emit(row);
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
    if (this.active.has(id)) await this.executions.get(id);

    await this.sync.refresh(row.prId);
    const problem = this.resumeProblem(row);

    if (problem) throw new ReviewError('STALE_REVIEW', 409, problem);
    if (row.provider === 'codex') {
      const status = await this.codexStatus();

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

    const rows = this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.account, account),
          eq(aiRuns.status, 'paused'),
          eq(aiRuns.pauseReason, 'restart'),
        ),
      )
      .orderBy(aiRuns.createdAt)
      .all();

    for (const row of rows) {
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
    return (
      this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.account, account),
            eq(aiRuns.prId, prId),
            eq(aiRuns.task, task),
            inArray(aiRuns.status, ['queued', 'running', 'paused']),
          ),
        )
        .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
        .limit(1)
        .get() ?? null
    );
  }

  /** The latest full review of each tracked PR, for list badges. */
  reviewStatuses(account: string): AiReviewStatus[] {
    const rows = this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.account, account), eq(aiRuns.task, 'full_review')))
      .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
      .all();
    const latest = new Map<string, AiRunRow>();

    for (const row of rows) if (!latest.has(row.prId)) latest.set(row.prId, row);

    return [...latest.values()]
      .filter((row) => this.sync.detail(row.prId))
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
    const head = this.sync.detail(prId)?.snapshot.headOid;
    const rows = this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.account, account), eq(aiRuns.prId, prId)))
      .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
      .all();
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
  async accept(account: string, id: string, index: number, body?: string): Promise<DraftComment> {
    const row = this.row(id);

    if (!row || row.account !== account || row.task !== 'draft_comments' || !row.result) {
      throw new ReviewError('NOT_FOUND', 404, 'That suggestion no longer exists.');
    }

    const suggestion = (JSON.parse(row.result) as DraftCommentsResult).comments[index];

    if (!suggestion) throw new ReviewError('NOT_FOUND', 404, 'That suggestion no longer exists.');

    return this.reviews.addComment(row.prId, {
      account,
      path: suggestion.path,
      line: suggestion.line,
      side: suggestion.side,
      body: body ?? suggestion.body,
      origin: 'ai',
    });
  }

  /** Stage selected findings locally. Posting still happens only through ReviewService.submit. */
  async prepareReview(
    account: string,
    id: string,
    indices: number[],
    options: PrepareReviewOptions = {},
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

    await this.sync.refresh(row.prId);

    const detail = this.detail(account, row.prId);

    const staleReason = this.staleReason(row);

    if (staleReason) {
      throw new ReviewError(
        'HEAD_MOVED',
        409,
        `This review is out of date. ${staleReason} Regenerate it before preparing a GitHub review.`,
      );
    }

    const result = JSON.parse(row.result) as FullReviewResult;
    const selected = [...new Set(indices)].map((index) => result.comments[index]);

    if (selected.some((comment) => !comment)) {
      throw new ReviewError('NOT_FOUND', 404, 'One of the selected findings is unavailable.');
    }

    const changedPaths = new Set(detail.snapshot.files.map((file) => file.path));
    const draft = this.reviews.draft(account, row.prId);
    const indicesKey = (values: number[]) => [...new Set(values)].sort((a, b) => a - b).join(',');

    if (
      draft.preparedReview?.runId === id &&
      indicesKey(draft.preparedReview.indices) === indicesKey(indices)
    )
      return draft;

    const general = selected.filter((comment) => !changedPaths.has(comment.path));
    const summary = [
      result.overall,
      ...general.map((comment) => `### ${comment.path}\n${comment.body}`),
    ].join('\n\n');
    if (selected.some((comment) => comment.body.length > 65_536 || !comment.body.trim())) {
      throw new ReviewError(
        'INVALID_REVIEW',
        422,
        'This review is too large to post. Select fewer findings.',
      );
    }

    const full = await this.diffs.manifest(detail.snapshot, 'full', null);
    const latest = this.detail(account, row.prId).snapshot;

    if (latest.headOid !== row.headOid || this.staleReason(row)) {
      throw new ReviewError(
        'HEAD_MOVED',
        409,
        'New commits arrived. Regenerate this review before preparing a GitHub review.',
      );
    }

    const comments = selected
      .filter((comment) => changedPaths.has(comment.path))
      .map((comment) => {
        const file = full.files.find((candidate) => candidate.path === comment.path);
        const lines = commentableLines(file?.patch);
        const visible = comment.side === 'LEFT' ? lines.left : lines.right;

        return {
          ...comment,
          line: comment.line !== null && visible.has(comment.line) ? comment.line : null,
        };
      });

    // One synchronous transaction avoids partial drafts or duplicate comments on retries.
    this.sync.store.transaction(() => {
      this.reviews.drafts.assertEditable(account, row.prId);

      const current = this.reviews.draft(account, row.prId);

      if (
        current.preparedReview?.runId === id &&
        indicesKey(current.preparedReview.indices) === indicesKey(indices)
      )
        return;

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

      const remaining = current.comments.filter((comment) => !removeIds.includes(comment.id));
      const ownedComments: { id: string; fingerprint: string }[] = [];

      for (const comment of comments) {
        const exists = remaining.some(
          (existing) =>
            existing.origin === 'ai' &&
            existing.anchorOid === row.headOid &&
            existing.path === comment.path &&
            existing.line === comment.line &&
            existing.side === comment.side &&
            existing.body === comment.body,
        );

        if (exists) continue;

        const added = this.reviews.drafts.addComment(account, row.prId, {
          ...comment,
          startLine: null,
          startSide: null,
          subjectType: comment.line === null ? 'FILE' : 'LINE',
          origin: 'ai',
          anchorOid: row.headOid,
        });

        remaining.push(added);
        ownedComments.push({ id: added.id, fingerprint: preparedCommentFingerprint(added) });
      }

      this.reviews.drafts.saveMeta(account, row.prId, {
        body,
        preparedReview: {
          runId: id,
          preparedAt: new Date().toISOString(),
          indices: [...new Set(indices)].sort((a, b) => a - b),
          content: { summary, comments: ownedComments },
          ...(previousDrafts.length ? { previousDrafts } : {}),
        },
      });
    });
    this.events.emit({ type: 'draft.updated', id: row.prId });

    return this.reviews.draft(account, row.prId);
  }

  /** Apply an explicitly selected summary only after checking its evidence against live GitHub. */
  async applySummary(account: string, id: string): Promise<ReviewDraft> {
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
    await this.sync.refresh(row.prId);
    this.detail(account, row.prId);

    const reason = this.staleReason(row);

    if (reason)
      throw new ReviewError(
        'STALE_REVIEW',
        409,
        `${reason} Generate a new summary before using it.`,
      );

    this.reviews.drafts.saveMeta(account, row.prId, {
      body: (JSON.parse(row.result) as { body: string }).body,
    });
    this.events.emit({ type: 'draft.updated', id: row.prId });

    return this.reviews.draft(account, row.prId);
  }
}
