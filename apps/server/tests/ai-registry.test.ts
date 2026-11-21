import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiTaskLabels, type AiTask } from '@review-desk/shared/ai';
import type { DiffManifest } from '@review-desk/shared/diff';
import type { ReviewDraft } from '@review-desk/shared/review';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import { FixtureProvider } from '@/ai/fixture.js';
import { AiRunner } from '@/ai/runner.js';
import { jsonSchemaFor, TASKS, type Evidence, type TaskDefinition } from '@/ai/tasks.js';
import type { RepositoryExporter } from '@/ai/workspace.js';
import { aiRuns } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { ReviewService } from '@/review/service.js';
import { SyncService } from '@/sync/service.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tasks = Object.keys(TASKS) as AiTask[];

/** Every object in a JSON Schema, nested ones included. */
function objects(schema: unknown): Record<string, unknown>[] {
  if (Array.isArray(schema)) return schema.flatMap(objects);
  if (!schema || typeof schema !== 'object') return [];

  const node = schema as Record<string, unknown>;
  const own = node.type === 'object' ? [node] : [];

  return [...own, ...Object.values(node).flatMap(objects)];
}

/** Evidence that lets the task read only what it declares: anything else throws. */
function declaredOnly(definition: TaskDefinition): Evidence {
  // The scenario's own snapshot, as the sync would save it.
  const pr = defaultScenario(Date.parse('2026-11-05T10:00:00Z')).world.pulls[0]
    .snapshot as unknown as PullRequestSnapshot;
  const all: Evidence = {
    pr,
    diff: {
      prId: pr.id,
      kind: 'full',
      fromOid: pr.baseOid,
      toOid: pr.headOid,
      files: [],
    } as unknown as DiffManifest,
    draft: {
      prId: pr.id,
      body: '',
      event: 'COMMENT',
      comments: [],
      updatedAt: null,
    } as unknown as ReviewDraft,
    completedReview: { id: 'review-1', result: null },
    login: 'you',
  };
  const declared: Record<keyof Evidence, boolean> = {
    pr: true,
    diff: definition.evidence.diff !== null,
    draft: definition.evidence.draft === true,
    completedReview: definition.evidence.completedReview === true,
    login: definition.evidence.login === true,
  };

  return new Proxy(all, {
    get(target, key: keyof Evidence) {
      if (!declared[key]) throw new Error(`reads ${String(key)}, which it does not declare`);

      return target[key];
    },
  });
}

describe('the AI task registry', () => {
  it('defines every public task, and nothing else', () => {
    expect(tasks.sort()).toEqual(Object.keys(aiTaskLabels).sort());
  });

  it.each(tasks)('gives %s a strict wire schema: every property required, no extras', (task) => {
    const found = objects(jsonSchemaFor(task));

    expect(found.length).toBeGreaterThan(0);

    for (const node of found) {
      expect(node.additionalProperties).toBe(false);
      expect([...((node.required as string[]) ?? [])].sort()).toEqual(
        Object.keys((node.properties as object) ?? {}).sort(),
      );
    }
  });

  it.each(tasks)('builds the %s prompt from only the evidence it declares', (task) => {
    const definition = TASKS[task];

    expect(() => definition.input(declaredOnly(definition))).not.toThrow();
    expect(definition.input(declaredOnly(definition))).toContain('<untrusted_pr_content>');
  });

  it.each(tasks)('declares the evidence its %s context records', (task) => {
    const { context, evidence } = TASKS[task];

    if (context.length > 0) expect(context[0]).toBe('review');
    if (context.includes('draft')) expect(evidence.draft).toBe(true);
    if (context.includes('fullReviewId')) expect(evidence.completedReview).toBe(true);
    // A review is checked against the PR as refreshed for it.
    if (context.length > 0) expect(TASKS[task].refreshFirst).toBe(true);
  });

  it('runs a task on a workspace only on the one provider that can', () => {
    for (const task of tasks)
      if (TASKS[task].execution === 'workspace') expect(TASKS[task].provider).toBe('codex');
  });
});

async function setup() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events);
  const diffs = new DiffService(github);
  const reviews = new ReviewService(sync, github, diffs, events);
  const providers = { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') };
  const root = mkdtempSync(join(tmpdir(), 'review-desk-registry-'));

  providers.codex.delayMs = 5;
  providers.claude.delayMs = 5;
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await sync.sync();

  const exportRepository: RepositoryExporter = async (repository, oid, directory, signal) => {
    for (const [path, content] of Object.entries(
      github.scenario.world.repos.files(repository, oid),
    )) {
      signal.throwIfAborted();

      const target = join(directory, path);

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }

    return [];
  };
  const runner = new AiRunner(sync, diffs, reviews, events, providers, root, exportRepository);

  runner.open();
  cleanups.push(() => runner.close());

  const pr = (number: number) => sync.list().items.find((item) => item.number === number)!;
  const finished = async (run: { id: string; prId: string }) => {
    await vi.waitFor(
      () =>
        expect(runner.runs('you', run.prId).find((other) => other.id === run.id)?.status).toBe(
          'done',
        ),
      { timeout: 5000 },
    );

    return runner.runs('you', run.prId).find((other) => other.id === run.id)!;
  };

  return { store, github, sync, diffs, reviews, runner, providers, pr, finished };
}

describe('the runner, from the registry', () => {
  it('refuses a full review whose base moved while it was prepared, though its head did not', async () => {
    const { github, sync, diffs, runner, pr } = await setup();
    const id = pr(2041).id;
    const manifest = diffs.manifest.bind(diffs);

    vi.spyOn(diffs, 'manifest').mockImplementationOnce(async (...args) => {
      const snapshot = github.scenario.world.pulls.find(
        (pull) => pull.snapshot.id === id,
      )!.snapshot;

      // Only the base moves, as a retarget does.
      snapshot.baseOid = 'a'.repeat(40);
      snapshot.updatedAt = new Date(Date.parse(snapshot.updatedAt) + 1000).toISOString();

      return manifest(...args);
    });

    await expect(runner.start('you', id, 'full_review')).rejects.toMatchObject({
      code: 'HEAD_MOVED',
    });
    expect(sync.detail(id)!.snapshot.baseOid).toBe('a'.repeat(40));
  });

  it('refuses a since-review brief with no review of yours, before reading any diff', async () => {
    const { diffs, runner, pr, sync } = await setup();
    const unreviewed = sync.list().items.find((item) => !item.latestReview)!;
    const manifest = vi.spyOn(diffs, 'manifest');

    void pr;
    await expect(runner.start('you', unreviewed.id, 'since_review')).rejects.toMatchObject({
      code: 'NO_REVIEW',
    });
    expect(manifest).not.toHaveBeenCalled();
  });

  it('saves a run context in the order its cache key has always read it', async () => {
    const { store, runner, pr, finished } = await setup();
    const summary = await finished(await runner.start('you', pr(1839).id, 'draft_summary'));
    const row = store.aiRuns.get(summary.id)!;

    // Part of the cache key: another order would miss every answer cached before.
    expect(Object.keys(row.context!)).toEqual(['review', 'draft', 'fullReviewId']);
  });

  it('saves a task that runs on one provider only with that provider', async () => {
    const { runner } = await setup();
    const settings = runner.settings();

    runner.saveSettings({
      ...settings,
      tasks: {
        ...settings.tasks,
        full_review: { ...settings.tasks.full_review, provider: 'claude' },
      },
    });

    expect(runner.settings().tasks.full_review.provider).toBe('codex');
  });

  it('shows what a run was given, and whether it was posted, only for a task that reports them', async () => {
    const { runner, pr, finished } = await setup();
    const review = await finished(await runner.start('you', pr(2041).id, 'full_review'));
    const brief = await finished(await runner.start('you', pr(2041).id, 'brief'));

    expect(review).toHaveProperty('inputs');
    expect(review).toHaveProperty('publication');
    expect(brief).not.toHaveProperty('inputs');
    expect(brief).not.toHaveProperty('publication');
  });

  it('never resumes a run whose prompt has changed since it stopped', async () => {
    const { store, runner, providers, pr } = await setup();

    providers.codex.delayMs = 5_000;

    const run = await runner.start('you', pr(2041).id, 'brief', { provider: 'codex' });

    await vi.waitFor(() =>
      expect(runner.runs('you', run.prId).find((other) => other.id === run.id)?.status).toBe(
        'running',
      ),
    );
    runner.pause('you', run.id);
    await vi.waitFor(() =>
      expect(runner.runs('you', run.prId).find((other) => other.id === run.id)?.status).toBe(
        'paused',
      ),
    );
    // Saved under an older version of the task's prompt.
    store.db.update(aiRuns).set({ promptVersion: 0 }).where(eq(aiRuns.id, run.id)).run();

    await expect(runner.resume('you', run.id)).rejects.toThrow('instructions changed');
  });

  it('gives the first reason in order when a summary is stale on more than one', async () => {
    const { reviews, runner, pr, finished } = await setup();
    const id = pr(1839).id;
    const summary = await finished(await runner.start('you', id, 'draft_summary'));

    // Both a newer full review and another verdict: the newer review is the reason given.
    await finished(await runner.start('you', id, 'full_review'));
    await reviews.saveDraft('you', id, { event: 'REQUEST_CHANGES' });

    expect(runner.runs('you', id).find((run) => run.id === summary.id)).toMatchObject({
      stale: true,
      staleReason: expect.stringContaining('newer full review'),
    });
  });
});
