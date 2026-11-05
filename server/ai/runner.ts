import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultAiSettings,
  type AiProvider,
  type AiProviderStatus,
  type AiResult,
  type AiRun,
  type AiSettings,
  type AiTask,
  type DraftCommentsResult,
} from '../../shared/ai.js';
import { commentableLines } from '../../shared/diff.js';
import type { DraftComment } from '../../shared/review.js';
import type { PullRequestDetail } from '../../shared/types.js';
import type { DiffService } from '../diff/service.js';
import type { EventBus } from '../events.js';
import { redact, safeError } from '../github/errors.js';
import { ReviewError, type ReviewService } from '../review/service.js';
import type { SyncService } from '../sync/service.js';
import {
  authorFeedbackInput,
  briefInput,
  draftCommentsInput,
  draftSummaryInput,
  sinceReviewInput,
} from './context.js';
import type { AgentProvider } from './provider.js';
import { instructions, jsonSchemaFor, promptVersions, taskSchemas, timeouts } from './tasks.js';

const MAX_CONCURRENT = 2;
const PROBE_TTL_MS = 5 * 60_000;
const SETTINGS_KEY = 'ai-settings';

interface RunRow {
  id: string;
  account: string;
  pr_id: string;
  task: AiTask;
  provider: AiProvider;
  model: string | null;
  effort: AiRun['effort'];
  head_oid: string;
  cache_key: string;
  status: AiRun['status'];
  progress: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/**
 * Runs AI tasks through local agent CLIs: one queue, at most two runs at once and one per
 * provider, results cached by exact input so a PR head is only analysed once per task.
 */
export class AiRunner {
  private readonly queue: string[] = [];
  private readonly inputs = new Map<string, string>();
  private readonly active = new Map<
    string,
    { controller: AbortController; provider: AiProvider }
  >();
  private probes: { at: number; statuses: AiProviderStatus[] } | null = null;

  constructor(
    private readonly sync: SyncService,
    private readonly diffs: DiffService,
    private readonly reviews: ReviewService,
    private readonly events: EventBus,
    readonly providers: Record<AiProvider, AgentProvider>,
    private readonly workRoot: string,
  ) {
    // Runs cut short by a restart cannot resume; say so instead of leaving them spinning.
    this.db
      .prepare(
        "UPDATE ai_runs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued', 'running')",
      )
      .run(new Date().toISOString());
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
    };
  }

  saveSettings(settings: AiSettings): AiSettings {
    this.sync.store.setSetting(SETTINGS_KEY, settings);

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
  ): Promise<string> {
    const pr = detail.snapshot;

    if (task === 'brief') return briefInput(pr, await this.diffs.manifest(pr, 'full', null));
    if (task === 'draft_comments')
      return draftCommentsInput(pr, await this.diffs.manifest(pr, 'full', null));
    if (task === 'author_feedback') return authorFeedbackInput(pr);

    if (task === 'draft_summary') {
      const draft = this.reviews.draft(account, pr.id);

      return draftSummaryInput(pr, draft.event, draft.comments);
    }

    const reviewOid = detail.item.latestReview?.commitOid;

    if (!reviewOid) throw new ReviewError('NO_REVIEW', 422, 'You have not reviewed this PR yet.');

    return sinceReviewInput(pr, await this.diffs.manifest(pr, 'since-review', reviewOid), account);
  }

  private toRun(row: RunRow, currentHead?: string): AiRun {
    return {
      id: row.id,
      prId: row.pr_id,
      task: row.task,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      headOid: row.head_oid,
      status: row.status,
      progress: row.progress,
      result: row.result ? (JSON.parse(row.result) as AiResult) : null,
      error: row.error,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      stale: Boolean(currentHead && currentHead !== row.head_oid),
    };
  }

  private row(id: string): RunRow | null {
    return (
      (this.db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(id) as RunRow | undefined) ?? null
    );
  }

  private update(
    id: string,
    changes: Partial<
      Pick<RunRow, 'status' | 'progress' | 'result' | 'error' | 'model' | 'finished_at'>
    > & { usage?: string | null },
  ) {
    const entries = Object.entries(changes);

    if (entries.length === 0) return;

    this.db
      .prepare(`UPDATE ai_runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => (value ?? null) as string | null), id);
  }

  private emit(row: Pick<RunRow, 'pr_id' | 'id'>) {
    this.events.emit({ type: 'ai.updated', prId: row.pr_id, runId: row.id });
  }

  async start(
    account: string,
    prId: string,
    task: AiTask,
    options: { provider?: AiProvider; force?: boolean } = {},
  ): Promise<AiRun> {
    const detail = this.detail(account, prId);
    const settings = this.settings();
    const taskSettings = settings.tasks[task];
    const provider = options.provider ?? taskSettings.provider ?? settings.defaultProvider;
    const input = await this.buildInput(task, detail, account);
    const head = detail.snapshot.headOid;
    const key = createHash('sha256')
      .update(
        [
          task,
          provider,
          taskSettings.model ?? '',
          taskSettings.effort,
          promptVersions[task],
          head,
          input,
        ].join('\u0000'),
      )
      .digest('hex');
    const existing = this.db
      .prepare(
        "SELECT * FROM ai_runs WHERE account = ? AND cache_key = ? AND status IN ('queued', 'running', 'done') ORDER BY created_at DESC LIMIT 1",
      )
      .get(account, key) as RunRow | undefined;

    if (existing && (existing.status !== 'done' || !options.force))
      return this.toRun(existing, head);

    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO ai_runs (id, account, pr_id, task, provider, model, effort, head_oid, prompt_version, cache_key, status, progress, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'Waiting to start…', ?)`,
      )
      .run(
        id,
        account,
        prId,
        task,
        provider,
        taskSettings.model,
        taskSettings.effort,
        head,
        promptVersions[task],
        key,
        new Date().toISOString(),
      );
    this.inputs.set(id, input);
    this.queue.push(id);
    this.emit({ id, pr_id: prId });
    this.pump();

    return this.toRun(this.row(id)!, head);
  }

  private pump(): void {
    while (this.active.size < MAX_CONCURRENT) {
      const busy = new Set([...this.active.values()].map((run) => run.provider));
      const index = this.queue.findIndex((id) => !busy.has(this.row(id)?.provider as AiProvider));

      if (index === -1) return;

      const [id] = this.queue.splice(index, 1);

      void this.execute(id);
    }
  }

  private async execute(id: string): Promise<void> {
    const row = this.row(id);
    const input = this.inputs.get(id);

    if (!row || !input) return;

    const controller = new AbortController();
    const workDir = join(this.workRoot, id);
    let lastEmit = 0;

    this.active.set(id, { controller, provider: row.provider });
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    this.update(id, { status: 'running', progress: 'Starting…' });
    this.emit(row);

    try {
      const result = await this.providers[row.provider].run(
        {
          instructions: instructions[row.task],
          input,
          schema: jsonSchemaFor(row.task),
          effort: row.effort,
          model: row.model,
          workDir,
          timeoutMs: timeouts[row.task],
        },
        controller.signal,
        (progress) => {
          this.update(id, { progress });

          if (Date.now() - lastEmit > 400) {
            lastEmit = Date.now();
            this.emit(row);
          }
        },
      );
      const parsed = taskSchemas[row.task].safeParse(result.output);

      if (!parsed.success) throw new Error('The agent returned an answer in an unexpected shape.');

      const output =
        row.task === 'draft_comments'
          ? await this.anchor(row, parsed.data as DraftCommentsResult)
          : parsed.data;

      this.update(id, {
        status: 'done',
        progress: null,
        model: result.model,
        result: redact(JSON.stringify(output)),
        usage: result.usage ? JSON.stringify(result.usage) : null,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      this.update(id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        progress: null,
        error: controller.signal.aborted ? null : safeError(error),
        finished_at: new Date().toISOString(),
      });
    } finally {
      this.active.delete(id);
      this.inputs.delete(id);
      rmSync(workDir, { recursive: true, force: true });
      this.emit(row);
      this.pump();
    }
  }

  /** Keeps only anchors GitHub would accept; the rest stay as unanchored suggestions. */
  private async anchor(row: RunRow, result: DraftCommentsResult): Promise<DraftCommentsResult> {
    const detail = this.sync.detail(row.pr_id);

    if (!detail) return result;

    const full = await this.diffs.manifest(detail.snapshot, 'full', null);

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
      active.controller.abort();
      return;
    }

    const queued = this.queue.indexOf(id);

    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.inputs.delete(id);
      this.update(id, {
        status: 'cancelled',
        progress: null,
        finished_at: new Date().toISOString(),
      });
      this.emit(row);
    }
  }

  /** The latest run for each task on a PR, flagged stale when the head has moved since. */
  runs(account: string, prId: string): AiRun[] {
    const head = this.sync.detail(prId)?.snapshot.headOid;
    const rows = this.db
      .prepare('SELECT * FROM ai_runs WHERE account = ? AND pr_id = ? ORDER BY created_at DESC')
      .all(account, prId) as unknown as RunRow[];
    const latest = new Map<AiTask, RunRow>();

    for (const row of rows) if (!latest.has(row.task)) latest.set(row.task, row);

    return [...latest.values()].map((row) => this.toRun(row, head));
  }

  /** Copies one suggested comment into the user's draft review; nothing is posted. */
  async accept(account: string, id: string, index: number, body?: string): Promise<DraftComment> {
    const row = this.row(id);

    if (!row || row.account !== account || row.task !== 'draft_comments' || !row.result) {
      throw new ReviewError('NOT_FOUND', 404, 'That suggestion no longer exists.');
    }

    const suggestion = (JSON.parse(row.result) as DraftCommentsResult).comments[index];

    if (!suggestion) throw new ReviewError('NOT_FOUND', 404, 'That suggestion no longer exists.');

    return this.reviews.addComment(row.pr_id, {
      account,
      path: suggestion.path,
      line: suggestion.line,
      side: suggestion.side,
      body: body ?? suggestion.body,
      origin: 'ai',
    });
  }
}
