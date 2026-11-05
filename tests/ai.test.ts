import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { c } from 'tar';
import { ClaudeProvider, claudeProgress } from '../server/ai/claude';
import { CodexProvider, codexProgress } from '../server/ai/codex';
import { annotatePatch } from '../server/ai/context';
import { FixtureProvider } from '../server/ai/fixture';
import { AiRunner } from '../server/ai/runner';
import { jsonSchemaFor } from '../server/ai/tasks';
import {
  extractRepository,
  prepareReviewWorkspace,
  type RepositoryExporter,
} from '../server/ai/workspace';
import { Store } from '../server/db/store';
import { FixtureGitHub } from '../server/demo/fixture-github';
import { defaultScenario } from '../server/demo/scenario';
import { DiffService } from '../server/diff/service';
import { EventBus } from '../server/events';
import { ReviewService } from '../server/review/service';
import { SyncService } from '../server/sync';
import {
  defaultAiSettings,
  type AiRun,
  type BriefResult,
  type DraftCommentsResult,
  type FullReviewResult,
  type SinceReviewResult,
} from '../shared/ai';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  delete process.env.GH_TOKEN;
});

const fixturesDir = new URL('./fixtures/ai/', import.meta.url).pathname;

function workDir() {
  const directory = mkdtempSync(join(tmpdir(), 'review-desk-ai-test-'));

  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}

const request = (directory: string) => ({
  instructions: 'Test instructions',
  input: '<untrusted_pr_content>fake</untrusted_pr_content>',
  schema: jsonSchemaFor('brief'),
  effort: 'low' as const,
  model: null,
  workDir: directory,
  timeoutMs: 20_000,
});

describe('agent CLIs', () => {
  it('maps captured Codex and Claude events to progress labels', () => {
    const codex = readFileSync(join(fixturesDir, 'codex-exec.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => codexProgress(JSON.parse(line)));
    const claude = readFileSync(join(fixturesDir, 'claude-stream.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => claudeProgress(JSON.parse(line)));

    expect(codex.filter(Boolean)).toEqual(['Thinking…', 'Writing the answer…']);
    expect(claude.filter(Boolean)).toContain('Writing the answer…');
    expect(claude.some((label) => label?.startsWith('Thinking (~'))).toBe(true);
  });

  it('runs Codex headless, read-only, without connectors or GitHub credentials', async () => {
    process.env.GH_TOKEN = 'ghp_should_not_leak';

    const progress: string[] = [];
    const result = await new CodexProvider(join(fixturesDir, 'fake-codex.mjs')).run(
      request(workDir()),
      new AbortController().signal,
      (label) => progress.push(label),
    );
    const answer = result.output as BriefResult;
    const args = answer.questions[1];

    expect(answer.summary).toBe('Fake codex answer');
    expect(answer.questions[0]).toBe('GH_TOKEN=unset');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('-s read-only');
    expect(args).toContain('--disable apps');
    expect(args).toContain('--disable plugins');
    expect(args).toContain('mcp_servers={}');
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).not.toContain(' -m ');
    expect(progress).toContain('Writing the answer…');
  });

  it('runs Claude headless with no tools and returns the structured output', async () => {
    const result = await new ClaudeProvider(join(fixturesDir, 'fake-claude.mjs')).run(
      request(workDir()),
      new AbortController().signal,
      () => {},
    );
    const answer = result.output as BriefResult;

    expect(answer.summary).toBe('Fake claude answer');
    expect(answer.riskReasons).toEqual(['tools=none']);
    expect(answer.questions).toEqual(['GH_CONFIG_DIR set: true']);
    expect(result.model).toMatch(/claude/);
  });

  it('produces strict JSON schemas that both CLIs accept', () => {
    const schema = jsonSchemaFor('draft_comments') as {
      required: string[];
      additionalProperties: boolean;
      properties: { comments: { items: { required: string[]; additionalProperties: boolean } } };
    };

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['overall', 'comments']);
    expect(schema.properties.comments.items.additionalProperties).toBe(false);
    expect(schema.properties.comments.items.required).toEqual([
      'path',
      'line',
      'side',
      'severity',
      'body',
    ]);
  });

  it('labels every diff line with GitHub coordinates', () => {
    expect(annotatePatch('@@ -1,2 +1,2 @@\n context\n-old\n+new')).toBe(
      '@@ -1,2 +1,2 @@\nR1   context\nL2 - old\nR2 + new',
    );
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

  providers.codex.delayMs = 5;
  providers.claude.delayMs = 5;
  cleanups.push(() => store.close());
  await sync.sync();

  const exported: { oid: string; directory: string }[] = [];
  const exportRepository: RepositoryExporter = async (repository, oid, directory, signal) => {
    exported.push({ oid, directory });

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
  const root = workDir();
  const runner = new AiRunner(sync, diffs, reviews, events, providers, root, exportRepository);
  const pr = (number: number) =>
    [...sync.list().items, ...sync.mine().items].find((item) => item.number === number)!;
  const finished = async (run: AiRun) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = runner.runs('you', run.prId).find((candidate) => candidate.id === run.id);

      if (current && !['queued', 'running'].includes(current.status)) return current;

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('run did not finish');
  };

  return {
    store,
    github,
    sync,
    reviews,
    runner,
    providers,
    pr,
    finished,
    diffs,
    exported,
    exportRepository,
    root,
  };
}

describe('AI runner', () => {
  it('runs a full Codex review against both repository snapshots and keeps the report off GitHub', async () => {
    const { runner, pr, finished, github, reviews, exported, root, sync } = await setup();
    const settings = defaultAiSettings();

    settings.defaultProvider = 'claude';
    runner.saveSettings(settings);

    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const result = run.result as FullReviewResult;

    expect(run).toMatchObject({ provider: 'codex', status: 'done', effort: 'high' });
    expect(result.assessment).toBe('no_blocking_findings');
    expect(result.coverage).toHaveLength(1);
    expect(result.comments[0].line).not.toBeNull();
    expect(exported.map((item) => item.oid)).toEqual([
      sync.detail(run.prId)!.snapshot.baseOid,
      run.headOid,
    ]);
    expect(existsSync(join(root, run.id))).toBe(false);
    expect(reviews.draft('you', run.prId).comments).toEqual([]);
    expect(github.writes).toEqual([]);

    const cached = await runner.start('you', run.prId, 'full_review');

    expect(cached.id).toBe(run.id);
  });

  it('stages only selected findings, preserves existing drafts, and posts only on explicit submit', async () => {
    const { runner, pr, finished, github, reviews, store } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));

    await reviews.saveDraft('you', run.prId, { body: 'My existing summary.' });

    const summaryOnly = await runner.prepareReview('you', run.id, []);

    expect(summaryOnly.comments).toEqual([]);
    expect(summaryOnly.body).toContain('My existing summary.');
    expect(summaryOnly.body).toContain('## Codex review');

    await expect(runner.prepareReview('someone-else', run.id, [0])).rejects.toThrow('unavailable');
    await expect(runner.prepareReview('you', run.id, [999])).rejects.toThrow('unavailable');

    const draft = await runner.prepareReview('you', run.id, [0, 0]);
    const retried = await runner.prepareReview('you', run.id, [0]);

    expect(draft.comments).toHaveLength(1);
    expect(draft.comments[0]).toMatchObject({ origin: 'ai', anchorOid: run.headOid });
    expect(retried.comments).toHaveLength(1);
    expect(retried.body).toBe(draft.body);
    expect(github.writes).toEqual([]);

    const posted = await reviews.submit(run.prId, {
      account: 'you',
      event: 'COMMENT',
      body: draft.body,
      expectedHeadOid: run.headOid,
    });

    expect(posted.submittedComments).toBe(1);
    expect(github.writes.map((write) => write.op)).toEqual([
      'AddPendingReview',
      'AddReviewThread',
      'SubmitReview',
    ]);
    expect(
      (
        store.db.prepare('SELECT status FROM ai_runs WHERE id = ?').get(run.id) as {
          status: string;
        }
      ).status,
    ).toBe('done');
  });

  it('refuses to prepare a full review after the PR head moves, even before the next background sync', async () => {
    const { runner, pr, finished, github, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));

    github.scenario.world.pulls.find((pull) => pull.snapshot.id === run.prId)!.snapshot.headOid =
      'f'.repeat(40);

    await expect(runner.prepareReview('you', run.id, [0])).rejects.toThrow('out of date');
    expect(reviews.draft('you', run.prId).comments).toEqual([]);
    expect(github.writes).toEqual([]);
  });

  it('provides full repository content beyond the prompt and reports omitted archive entries', async () => {
    const { pr, sync, diffs, github, exportRepository } = await setup();
    const snapshot = sync.detail(pr(1839).id)!.snapshot;
    const directory = workDir();
    const diff = await diffs.manifest(snapshot, 'full', null);
    const exporter: RepositoryExporter = async (...args) => {
      await exportRepository(...args);

      return ['external-link'];
    };

    await prepareReviewWorkspace(
      github,
      snapshot,
      diff,
      directory,
      new AbortController().signal,
      exporter,
    );

    const context = JSON.parse(readFileSync(join(directory, 'review.json'), 'utf8'));

    expect(context).toMatchObject({
      baseOid: snapshot.baseOid,
      headOid: snapshot.headOid,
      omittedAfter: ['external-link'],
    });
    expect(context.files).toHaveLength(snapshot.changedFiles);
    expect(readFileSync(join(directory, 'after', diff.files[0].path), 'utf8')).toBe(
      github.scenario.world.repos.files(snapshot.repository, snapshot.headOid)[diff.files[0].path],
    );
  });

  it('stops repository preparation and cleans up the workspace when the server shuts down', async () => {
    const { sync, diffs, reviews, providers, pr, finished, github } = await setup();
    const root = workDir();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const runner = new AiRunner(
      sync,
      diffs,
      reviews,
      sync.events,
      providers,
      root,
      async (_repository, _oid, _directory, signal) => {
        notifyStarted();

        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true });
        });
      },
    );
    const run = await runner.start('you', pr(1839).id, 'full_review');

    await started;
    await runner.close();

    expect((await finished(run)).status).toBe('cancelled');
    expect(existsSync(join(root, run.id))).toBe(false);
    expect(github.writes).toEqual([]);
  });

  it('writes a brief with Codex by default and reuses it until the input changes', async () => {
    const { runner, pr, finished } = await setup();
    const first = await finished(await runner.start('you', pr(2041).id, 'brief'));

    expect(first.provider).toBe('codex');
    expect(first.status).toBe('done');
    expect((first.result as BriefResult).focusFiles.length).toBeGreaterThan(0);

    const again = await runner.start('you', pr(2041).id, 'brief');

    expect(again.id).toBe(first.id);

    const forced = await finished(await runner.start('you', pr(2041).id, 'brief', { force: true }));
    const claude = await finished(
      await runner.start('you', pr(2041).id, 'brief', { provider: 'claude' }),
    );

    expect(forced.id).not.toBe(first.id);
    expect(claude.provider).toBe('claude');
    expect(claude.model).toBe('Claude Code (demo)');
  });

  it('judges each of your threads since your review', async () => {
    const { runner, pr, finished } = await setup();
    const run = await finished(await runner.start('you', pr(2041).id, 'since_review'));
    const result = run.result as SinceReviewResult;

    expect(result.threads.map((thread) => thread.threadId)).toEqual(['t-2041-1', 't-2041-2']);
    await expect(runner.start('you', pr(1839).id, 'since_review')).rejects.toThrow('not reviewed');
  });

  it('keeps only anchors GitHub accepts and turns accepted suggestions into drafts', async () => {
    const { runner, reviews, pr, finished, github } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'draft_comments'));
    const comments = (run.result as DraftCommentsResult).comments;

    expect(comments[0].line).not.toBeNull();
    expect(comments[1].line).toBeNull();

    const draft = await runner.accept('you', run.id, 0);

    expect(draft).toMatchObject({ origin: 'ai', line: comments[0].line, status: 'draft' });
    expect(reviews.draft('you', pr(1839).id).comments).toHaveLength(1);
    expect(github.writes).toEqual([]);
  });

  it('records failures and cancellations, and marks results stale when the head moves', async () => {
    const { runner, providers, pr, finished, github, sync } = await setup();

    providers.codex.failNext = 'Agent unavailable';

    const failed = await finished(await runner.start('you', pr(1839).id, 'brief'));

    expect(failed).toMatchObject({ status: 'failed', error: 'Agent unavailable' });

    providers.codex.delayMs = 200;

    const slow = await runner.start('you', pr(2050).id, 'brief');

    runner.cancel('you', slow.id);
    expect((await finished(slow)).status).toBe('cancelled');

    providers.codex.delayMs = 5;

    const done = await finished(await runner.start('you', pr(870).id, 'brief'));

    github.scenario.world.pulls.find((pull) => pull.snapshot.id === done.prId)!.snapshot.headOid =
      'f'.repeat(40);
    await sync.sync();

    expect(runner.runs('you', done.prId).find((run) => run.task === 'brief')?.stale).toBe(true);
  });

  it('marks runs interrupted by a restart', async () => {
    const { store, sync, reviews, providers, pr } = await setup();
    const runner = new AiRunner(
      sync,
      new DiffService(sync.github),
      reviews,
      sync.events,
      providers,
      workDir(),
    );

    providers.codex.delayMs = 10_000;

    const run = await runner.start('you', pr(2041).id, 'brief');
    const restarted = new AiRunner(
      sync,
      new DiffService(sync.github),
      reviews,
      sync.events,
      providers,
      workDir(),
    );

    expect(restarted.runs('you', run.prId)[0].status).toBe('interrupted');
    runner.cancel('you', run.id);
    expect(store).toBeDefined();
  });
});

describe('review archives', () => {
  it('extracts source files while excluding symlinks that could expose files outside the workspace', async () => {
    const directory = workDir();
    const source = join(directory, 'source');
    const archive = join(directory, 'repo.tar.gz');
    const destination = join(directory, 'checkout');

    mkdirSync(join(source, 'repository'), { recursive: true });
    writeFileSync(join(source, 'repository', 'app.ts'), 'export const ready = true;');
    symlinkSync('/etc/passwd', join(source, 'repository', 'outside'));
    await c({ cwd: source, file: archive, gzip: true }, ['repository']);

    const omitted = await extractRepository(archive, destination, new AbortController().signal);

    expect(readFileSync(join(destination, 'app.ts'), 'utf8')).toContain('ready = true');
    expect(existsSync(join(destination, 'outside'))).toBe(false);
    expect(omitted).toContain('repository/outside');
  });
});
