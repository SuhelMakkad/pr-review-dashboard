import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { DatabaseSync } from 'node:sqlite';
import { c } from 'tar';
import { ClaudeProvider, claudeProgress } from '@/ai/claude.js';
import { CodexProvider, codexProgress, withDefault } from '@/ai/codex.js';
import { mergeSnapshot, summariseUsage, type RateLimitSnapshot } from '@/ai/codex-usage.js';
import { annotatePatch } from '@/ai/context.js';
import { FixtureProvider } from '@/ai/fixture.js';
import { agentLockPath, spawnAgentProcess } from '@/ai/provider.js';
import { AiRunner } from '@/ai/runner.js';
import { preparedCommentFingerprint } from '@/ai/preparation.js';
import { jsonSchemaFor } from '@/ai/tasks.js';
import {
  extractRepository,
  prepareReviewWorkspace,
  type RepositoryExporter,
} from '@/ai/workspace.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { ReviewService } from '@/review/service.js';
import { ReviewError } from '@/review/errors.js';
import { SyncService } from '@/sync/index.js';
import { observeInputs } from '@/ai/inputs.js';
import type { CompareResult, RemoteFile } from '@/github/api.js';
import type { DiffManifest } from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import {
  defaultAiSettings,
  type AiRun,
  type BriefResult,
  type DraftCommentsResult,
  type FullReviewResult,
  type SinceReviewResult,
} from '@review-desk/shared/ai';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FAKE_CODEX_')) delete process.env[key];
  }

  delete process.env.GH_TOKEN;
  delete process.env.CODEX_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

const fixturesDir = new URL('../../../tests/fixtures/ai/', import.meta.url).pathname;

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

const fakeCodex = () => new CodexProvider(join(fixturesDir, 'fake-codex.mjs'));
const run = (provider: CodexProvider, directory = workDir(), model: string | null = null) =>
  provider.run({ ...request(directory), model }, new AbortController().signal, () => {});

describe('agent CLIs', () => {
  it('maps captured Codex and Claude events to progress labels', () => {
    const codex = readFileSync(join(fixturesDir, 'codex-app-server.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => codexProgress(JSON.parse(line)));
    const claude = readFileSync(join(fixturesDir, 'claude-stream.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => claudeProgress(JSON.parse(line)));

    expect(codex.filter(Boolean)).toEqual([
      'Thinking…',
      'Reading code…',
      'Thinking…',
      'Writing the answer…',
    ]);
    expect(claude.filter(Boolean)).toContain('Writing the answer…');
    expect(claude.some((label) => label?.startsWith('Thinking (~'))).toBe(true);
  });

  it('runs Codex through app-server on the ChatGPT plan, read-only, with no connectors or credentials', async () => {
    process.env.GH_TOKEN = 'ghp_should_not_leak';
    process.env.CODEX_API_KEY = 'sk-should-not-leak-000000000000000000';
    process.env.OPENAI_API_KEY = 'sk-should-not-leak-111111111111111111';

    const progress: string[] = [];
    const result = await fakeCodex().run(
      request(workDir()),
      new AbortController().signal,
      (label) => progress.push(label),
    );
    const answer = result.output as BriefResult;
    const [ghToken, codexKey, openaiKey, args, client, thread, turn, declined, originator] =
      answer.questions;

    expect(answer.summary).toBe('Fake codex answer');
    expect([ghToken, codexKey, openaiKey]).toEqual([
      'GH_TOKEN=unset',
      'CODEX_API_KEY=unset',
      'OPENAI_API_KEY=unset',
    ]);
    expect(args).toMatch(/^args=app-server /);
    expect(args).toContain('--disable apps');
    expect(args).toContain('--disable plugins');
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain('notify=[]');
    expect(client).toBe('client=review_desk');
    expect(originator).toBe('originator=review_desk');
    // The account's default model, not the one pinned in the user's Codex config; standard speed;
    // the user's MCP servers off.
    expect(JSON.parse(thread.slice('thread='.length))).toMatchObject({
      model: 'gpt-fake',
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      serviceTier: null,
      config: { 'mcp_servers.linear.enabled': false },
    });
    expect(JSON.parse(turn.slice('turn='.length))).toMatchObject({
      effort: 'low',
      serviceTierForTurn: 'default',
      outputSchema: jsonSchemaFor('brief'),
    });
    expect(declined).toBe('declined=true');
    expect(result.model).toBe('gpt-fake');
    expect(result.usage).toMatchObject({ input_tokens: 10819, output_tokens: 21, credits_used: 0 });
    expect(progress).toEqual(['Thinking…', 'Reading code…', 'Thinking…', 'Writing the answer…']);
  });

  it("uses the task's Codex model and measures credits the run spent", async () => {
    process.env.FAKE_CODEX_CREDITS = '97.5';

    const result = await run(fakeCodex(), workDir(), 'gpt-fake-mini');

    expect(result.model).toBe('gpt-fake-mini');
    expect(result.usage).toMatchObject({ credits_used: 2.5 });
  });

  it('prefers GPT-6.1-Sol as the default once the account offers it', async () => {
    const offered = await fakeCodex().status();

    expect(offered.models.find((model) => model.isDefault)?.id).toBe('gpt-fake');

    process.env.FAKE_CODEX_SOL = '1';

    const status = await fakeCodex().status();
    const result = await run(fakeCodex());

    expect(status.models.filter((model) => model.isDefault).map((model) => model.id)).toEqual([
      'gpt-6.1-sol',
    ]);
    expect(result.model).toBe('gpt-6.1-sol');
    expect((await run(fakeCodex(), workDir(), 'gpt-fake-mini')).model).toBe('gpt-fake-mini');
    // A task model the account no longer offers runs on the default instead of failing.
    expect((await run(fakeCodex(), workDir(), 'gpt-retired')).model).toBe('gpt-6.1-sol');
  });

  it("follows t3code's preferred order when GPT-6.1-Sol is not offered", () => {
    const models = [
      { id: 'gpt-5.6-luna', displayName: 'Luna', isDefault: true },
      { id: 'gpt-5.6-sol', displayName: 'Sol', isDefault: false },
      { id: 'gpt-6-astra', displayName: 'Astra', isDefault: false },
    ];

    expect(withDefault(models).find((model) => model.isDefault)?.id).toBe('gpt-6-astra');
    expect(withDefault(models.slice(0, 1)).find((model) => model.isDefault)?.id).toBe(
      'gpt-5.6-luna',
    );
  });

  it('refuses a Codex sign-in that would not bill the ChatGPT plan', async () => {
    process.env.FAKE_CODEX_ACCOUNT = 'apiKey';
    await expect(run(fakeCodex())).rejects.toThrow('signed in with an API key');

    process.env.FAKE_CODEX_ACCOUNT = 'none';
    await expect(run(fakeCodex())).rejects.toThrow('Codex is not signed in');
  });

  it('does not start a run once the plan limit is used up', async () => {
    process.env.FAKE_CODEX_LIMIT = 'reached';

    await expect(run(fakeCodex())).rejects.toThrow(/limit is used up.*no credits are spent/);
  });

  it('interrupts a run when the plan limit runs out midway', async () => {
    process.env.FAKE_CODEX_LIMIT = 'midrun';

    const directory = workDir();

    await expect(run(fakeCodex(), directory)).rejects.toThrow('ran out during this run');
    expect(existsSync(join(directory, 'interrupted'))).toBe(true);
  });

  it('keeps a finished answer when the run uses the last of the plan', async () => {
    process.env.FAKE_CODEX_LIMIT = 'afteranswer';

    const result = await run(fakeCodex());

    expect((result.output as BriefResult).summary).toBe('Fake codex answer');
  });

  it('saves and resumes the same Codex thread after an interrupted turn with the same restrictions', async () => {
    const directory = workDir();
    const provider = fakeCodex();
    const controller = new AbortController();
    const checkpoint = vi.fn();

    process.env.FAKE_CODEX_STALL = '1';
    const pending = provider.run(
      { ...request(directory), onThread: checkpoint },
      controller.signal,
      () => {},
    );
    const stopped = expect(pending).rejects.toThrow(/stopped|Cancelled/);

    await vi.waitFor(() => expect(existsSync(join(directory, '.fake-turn-started'))).toBe(true));
    controller.abort();
    await stopped;
    expect(checkpoint).toHaveBeenCalledWith('thread-1', 'gpt-fake');
    expect(
      JSON.parse(readFileSync(join(directory, '.fake-codex-history.json'), 'utf8')).turn.status,
    ).toBe('interrupted');

    delete process.env.FAKE_CODEX_STALL;
    const resumed = await provider.run(
      { ...request(directory), threadId: 'thread-1', onThread: checkpoint },
      new AbortController().signal,
      () => {},
    );
    const thread = (resumed.output as BriefResult).questions.find((value) =>
      value.startsWith('thread='),
    )!;
    const history = JSON.parse(readFileSync(join(directory, '.fake-codex-history.json'), 'utf8'));

    expect(JSON.parse(thread.slice('thread='.length))).toMatchObject({
      threadId: 'thread-1',
      resumed: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      serviceTier: null,
      config: { 'mcp_servers.linear.enabled': false },
    });
    expect(history.options.ephemeral).toBe(false);
    expect(history.turnStarts).toBe(2);
    expect(history.turn.input[0].text).toContain('saved review progress');
    expect((resumed.output as BriefResult).summary).toBe('Fake codex answer');
  });

  it('recovers an already completed thread answer without starting another turn', async () => {
    const directory = workDir();
    const provider = fakeCodex();
    const checkpoint = vi.fn();
    const first = await provider.run(
      { ...request(directory), onThread: checkpoint },
      new AbortController().signal,
      () => {},
    );
    const recovered = await provider.run(
      { ...request(directory), threadId: 'thread-1', onThread: checkpoint },
      new AbortController().signal,
      () => {},
    );

    expect(recovered.output).toEqual(first.output);
    expect(
      JSON.parse(readFileSync(join(directory, '.fake-codex-history.json'), 'utf8')).turnStarts,
    ).toBe(1);
  });

  it('reports a missing saved Codex thread without silently starting a new one', async () => {
    const directory = workDir();

    await expect(
      fakeCodex().run(
        { ...request(directory), threadId: 'missing-thread', onThread: () => {} },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('Saved thread not found');
    expect(existsSync(join(directory, '.fake-turn-started'))).toBe(false);
  });

  it('stops a turn that goes silent instead of waiting out the whole timeout', async () => {
    process.env.FAKE_CODEX_STALL = '1';

    const directory = workDir();
    const started = Date.now();

    await expect(
      run(new CodexProvider(join(fixturesDir, 'fake-codex.mjs'), 300), directory),
    ).rejects.toThrow('Codex stopped responding');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(join(directory, 'interrupted'))).toBe(true);
  });

  it('settles soon after an agent exits even if a detached helper keeps its output open', async () => {
    // The helper inherits stdout in its own process group, as Codex's code-mode host does.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const helper = spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      'console.log(helper.pid);',
      'helper.unref();',
    ].join('\n');
    const lines: string[] = [];
    const started = Date.now();
    const agent = spawnAgentProcess(process.execPath, ['-e', script], {
      cwd: workDir(),
      env: process.env,
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      onLine: (line) => lines.push(line),
    });

    agent.stdin.end();
    await agent.done;

    expect(Date.now() - started).toBeLessThan(6_000);
    process.kill(Number(lines[0]), 'SIGKILL');
  });

  it('stops before the turn when one of the user’s MCP servers starts anyway', async () => {
    process.env.FAKE_CODEX_MCP = 'stuck';

    await expect(run(fakeCodex())).rejects.toThrow('MCP server "linear"');
  });

  it('reports the plan, its usage and the models the account offers', async () => {
    const status = await fakeCodex().status();

    expect(status).toMatchObject({
      type: 'chatgpt',
      plan: 'ChatGPT Plus',
      limitReached: false,
      problem: null,
    });
    expect(status.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ['5-hour', 40],
      ['Weekly', 20],
    ]);
    expect(status.models.map((model) => model.id)).toEqual(['gpt-fake', 'gpt-fake-mini']);

    process.env.FAKE_CODEX_LIMIT = 'reached';
    expect(await fakeCodex().status()).toMatchObject({
      limitReached: true,
      problem: expect.stringContaining('used up'),
    });

    process.env.FAKE_CODEX_ACCOUNT = 'apiKey';
    expect(await fakeCodex().status()).toMatchObject({
      type: 'apiKey',
      problem: expect.stringContaining('API key'),
    });
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
  runner.open();
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

/** Reproduce drafts made before full-review findings moved into the summary. */
async function legacyPreparedReview(runner: AiRunner, reviews: ReviewService, run: AiRun) {
  const prepared = await runner.prepareReview('you', run.id, [0]);
  const finding = (run.result as FullReviewResult).comments[0];
  const summary = (run.result as FullReviewResult).overall;
  const comment = await reviews.addComment(run.prId, { ...finding, account: 'you', origin: 'ai' });

  reviews.drafts.saveMeta('you', run.prId, {
    body: summary,
    event: 'COMMENT',
    preparedReview: {
      ...prepared.preparedReview!,
      content: {
        summary,
        comments: [{ id: comment.id, fingerprint: preparedCommentFingerprint(comment) }],
      },
    },
  });

  return reviews.draft('you', run.prId);
}

function holdRuns(provider: FixtureProvider) {
  const run = provider.run.bind(provider);
  const controls = new Map<string, { complete: () => void; fail: (error: Error) => void }>();

  vi.spyOn(provider, 'run').mockImplementation(async (request, signal, onProgress) => {
    request.onThread?.(request.threadId ?? `thread-${request.workDir}`, 'gpt-demo');
    const onAbort = () => controls.get(request.workDir)?.fail(new Error('Cancelled.'));

    try {
      await new Promise<void>((resolve, reject) => {
        controls.set(request.workDir, { complete: resolve, fail: reject });
        signal.addEventListener('abort', onAbort, { once: true });

        if (signal.aborted) onAbort();
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    return run(request, signal, onProgress);
  });

  return controls;
}

describe('Codex plan usage', () => {
  const snapshot = (overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({
    limitId: 'codex',
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_900_000_000 },
    secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_900_500_000 },
    credits: { hasCredits: true, unlimited: false, balance: '12.5' },
    spendControlReached: false,
    planType: 'pro',
    rateLimitReachedType: null,
    ...overrides,
  });

  it('labels windows by length and keeps the credit balance', () => {
    expect(summariseUsage(snapshot())).toEqual({
      plan: 'ChatGPT Pro',
      windows: [
        { label: '5-hour', usedPercent: 40, resetsAt: new Date(1_900_000_000_000).toISOString() },
        { label: 'Weekly', usedPercent: 20, resetsAt: new Date(1_900_500_000_000).toISOString() },
      ],
      limitReached: false,
      resetsAt: null,
      credits: 12.5,
    });
    expect(
      summariseUsage(snapshot({ credits: { hasCredits: true, unlimited: true, balance: null } }))
        .credits,
    ).toBeNull();
  });

  it('treats any exhausted window, reached limit or spend control as the limit', () => {
    const full = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 };
    const fullWeek = { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_900_500_000 };

    expect(summariseUsage(snapshot({ primary: full }))).toMatchObject({
      limitReached: true,
      resetsAt: new Date(1_900_000_000_000).toISOString(),
    });
    // Usage resumes only when the last exhausted window resets.
    expect(summariseUsage(snapshot({ primary: full, secondary: fullWeek })).resetsAt).toBe(
      new Date(1_900_500_000_000).toISOString(),
    );
    expect(
      summariseUsage(snapshot({ rateLimitReachedType: 'rate_limit_reached' })).limitReached,
    ).toBe(true);
    expect(summariseUsage(snapshot({ spendControlReached: true })).limitReached).toBe(true);
    expect(summariseUsage(snapshot(), false).limitReached).toBe(true);
  });

  it('applies sparse updates for the Codex bucket only', () => {
    const last = snapshot();
    const full = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 };

    expect(mergeSnapshot(last, { primary: full, secondary: null })).toMatchObject({
      primary: full,
      secondary: last.secondary,
    });
    expect(mergeSnapshot(last, { limitId: 'other', primary: full })).toBe(last);
  });
});

describe('AI runner', () => {
  it('runs two full reviews in isolated workspaces and queues another until a slot is free', async () => {
    const { runner, providers, pr, finished, root, sync, github } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const first = await runner.start('you', pr(1839).id, 'full_review');
      const second = await runner.start('you', pr(2041).id, 'full_review');
      const queued = await runner.start('you', pr(2050).id, 'full_review');

      expect([first.status, second.status, queued.status]).toEqual([
        'running',
        'running',
        'queued',
      ]);
      await vi.waitFor(() => expect(controls.size).toBe(2));

      for (const run of [first, second]) {
        const directory = join(root, run.id);
        const context = JSON.parse(readFileSync(join(directory, 'review.json'), 'utf8'));
        const snapshot = sync.detail(run.prId)!.snapshot;

        expect(context).toMatchObject({
          repository: snapshot.repository,
          number: snapshot.number,
          headOid: run.headOid,
        });
        expect(existsSync(join(directory, 'before'))).toBe(true);
        expect(existsSync(join(directory, 'after'))).toBe(true);
      }

      expect(existsSync(join(root, queued.id))).toBe(false);
      expect((await runner.start('you', second.prId, 'full_review')).id).toBe(second.id);

      controls.get(join(root, first.id))!.complete();
      expect((await finished(first)).status).toBe('done');
      await vi.waitFor(() => expect(controls.has(join(root, queued.id))).toBe(true));
      // A finished run's workspace goes in the background, once its agent has let go.
      await runner.cleanedUp();

      expect(existsSync(join(root, first.id))).toBe(false);
      expect(runner.runs('you', second.prId)[0].status).toBe('running');
      expect(existsSync(join(root, second.id, 'review.json'))).toBe(true);

      controls.get(join(root, second.id))!.complete();
      controls.get(join(root, queued.id))!.complete();

      const completed = await Promise.all([finished(second), finished(queued)]);

      expect(completed.map((run) => run.status)).toEqual(['done', 'done']);
      await runner.cleanedUp();
      expect(completed.every((run) => !existsSync(join(root, run.id)))).toBe(true);
      expect(github.writes).toEqual([]);
    } finally {
      await runner.close();
    }
  });

  it('cancels running and queued reviews independently and shares the limit with Claude', async () => {
    const { runner, providers, pr, finished, root } = await setup();
    const codex = holdRuns(providers.codex);
    const claude = holdRuns(providers.claude);

    try {
      const first = await runner.start('you', pr(1839).id, 'full_review');
      const second = await runner.start('you', pr(2041).id, 'full_review');
      const queued = await runner.start('you', pr(2050).id, 'full_review');
      const brief = await runner.start('you', pr(870).id, 'brief', { provider: 'claude' });

      await vi.waitFor(() => expect(codex.size).toBe(2));
      expect(brief.status).toBe('queued');
      expect(claude.size).toBe(0);

      runner.cancel('you', queued.id);
      runner.cancel('you', first.id);

      expect((await finished(queued)).status).toBe('cancelled');
      expect((await finished(first)).status).toBe('cancelled');
      await vi.waitFor(() => expect(claude.has(join(root, brief.id))).toBe(true));

      expect(codex.size).toBe(2);
      // Removed in the background, once each run's agent has let go of its workspace.
      await runner.cleanedUp();
      expect(existsSync(join(root, queued.id))).toBe(false);
      expect(existsSync(join(root, first.id))).toBe(false);
      expect(runner.runs('you', second.prId)[0].status).toBe('running');

      codex.get(join(root, second.id))!.complete();
      claude.get(join(root, brief.id))!.complete();

      const completed = await Promise.all([finished(second), finished(brief)]);

      expect(completed.map((run) => run.status)).toEqual(['done', 'done']);
    } finally {
      await runner.close();
    }
  });

  it('starts the next queued task after a review fails while another review keeps running', async () => {
    const { runner, providers, pr, finished, root } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const first = await runner.start('you', pr(1839).id, 'full_review');
      const second = await runner.start('you', pr(2041).id, 'full_review');
      const queued = await runner.start('you', pr(2050).id, 'brief');

      await vi.waitFor(() => expect(controls.size).toBe(2));
      controls.get(join(root, first.id))!.fail(new Error('Agent unavailable'));

      expect(await finished(first)).toMatchObject({ status: 'failed', error: 'Agent unavailable' });
      await vi.waitFor(() => expect(controls.has(join(root, queued.id))).toBe(true));

      expect(existsSync(join(root, first.id))).toBe(true);
      expect(runner.runs('you', first.prId)[0].resumable).toBe(true);
      expect(runner.runs('you', second.prId)[0].status).toBe('running');

      controls.get(join(root, second.id))!.complete();
      controls.get(join(root, queued.id))!.complete();

      const completed = await Promise.all([finished(second), finished(queued)]);

      expect(completed.map((run) => run.status)).toEqual(['done', 'done']);
    } finally {
      await runner.close();
    }
  });

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
    await runner.cleanedUp();
    expect(existsSync(join(root, run.id))).toBe(false);
    expect(reviews.draft('you', run.prId).comments).toEqual([]);
    expect(github.writes).toEqual([]);

    const cached = await runner.start('you', run.prId, 'full_review');

    expect(cached.id).toBe(run.id);
  });

  it('puts selected findings in the summary, preserves existing drafts, and never posts them inline', async () => {
    const { runner, pr, finished, github, reviews, store } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));

    await reviews.saveDraft('you', run.prId, { body: 'My existing summary.' });

    const summaryOnly = await runner.prepareReview('you', run.id, []);

    expect(summaryOnly.comments).toEqual([]);
    expect(summaryOnly.body).toBe(
      `My existing summary.\n\n${(run.result as FullReviewResult).overall}`,
    );

    await expect(runner.prepareReview('someone-else', run.id, [0])).rejects.toThrow('unavailable');
    await expect(runner.prepareReview('you', run.id, [999])).rejects.toThrow('unavailable');

    const draft = await runner.prepareReview('you', run.id, [0, 0]);
    const retried = await runner.prepareReview('you', run.id, [0]);

    expect(draft.comments).toEqual([]);
    expect(draft.body).toContain((run.result as FullReviewResult).comments[0].body);
    expect(draft.event).toBe('APPROVE');
    expect(retried.comments).toEqual([]);
    expect(retried.body).toBe(draft.body);
    expect(github.writes).toEqual([]);

    const posted = await reviews.submit(run.prId, {
      account: 'you',
      event: 'COMMENT',
      body: draft.body,
      expectedHeadOid: run.headOid,
    });

    expect(posted.submittedComments).toBe(0);
    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview', 'SubmitReview']);
    expect(
      (
        store.db.$client.prepare('SELECT status FROM ai_runs WHERE id = ?').get(run.id) as {
          status: string;
        }
      ).status,
    ).toBe('done');
  });

  it('includes the checks and correct behavior in a GitHub review with no requested changes', async () => {
    const { runner, providers, pr, finished, reviews, github } = await setup();
    const overall =
      'I checked the arithmetic changes in `src/scheduling/CalendarTabs.tsx`: the updated helpers apply the new offset after multiplication and retain numeric parameters. No changes are needed in that scope. Tests were not run.';

    vi.spyOn(providers.codex, 'run').mockResolvedValueOnce({
      output: {
        overall,
        assessment: 'no_blocking_findings',
        comments: [],
        coverage: ['Compared the changed exports with the previous implementation.'],
      },
      model: 'test',
      usage: null,
    });

    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const draft = await runner.prepareReview('you', run.id, []);

    expect(draft.body).toBe(overall);
    expect(draft.comments).toEqual([]);
    expect(draft.event).toBe('APPROVE');
    expect(github.writes).toEqual([]);

    await reviews.submit(run.prId, {
      account: 'you',
      event: 'COMMENT',
      body: draft.body,
      expectedHeadOid: run.headOid,
    });

    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview', 'SubmitReview']);
    expect(github.writes[1].details).toMatchObject({ body: overall, comments: 0 });
  });

  it('replaces an earlier prepared review when a later run has no findings', async () => {
    const { runner, providers, pr, finished, reviews, github } = await setup();
    const first = await finished(await runner.start('you', pr(1839).id, 'full_review'));

    await runner.prepareReview('you', first.id, [0]);

    const overall = 'No changes are needed. The previously reported issues are resolved.';

    vi.spyOn(providers.codex, 'run').mockResolvedValueOnce({
      output: {
        overall,
        assessment: 'no_blocking_findings',
        comments: [],
        coverage: ['Checked the current implementation.'],
      },
      model: 'test',
      usage: null,
    });

    const second = await finished(
      await runner.start('you', first.prId, 'full_review', { force: true }),
    );
    const draft = await runner.prepareReview('you', second.id, []);

    expect(draft.body).toBe(overall);
    expect(draft.comments).toEqual([]);
    expect(draft.preparedReview).toMatchObject({ runId: second.id, indices: [] });

    await expect(runner.prepareReview('you', first.id, [0])).rejects.toMatchObject({
      code: 'DRAFT_CHANGED',
    });
    expect(reviews.draft('you', first.prId)).toEqual(draft);

    await reviews.submit(second.prId, {
      account: 'you',
      event: 'COMMENT',
      body: draft.body,
      expectedHeadOid: second.headOid,
    });

    expect(github.writes.map((write) => write.op)).toEqual(['AddPendingReview', 'SubmitReview']);
    expect(github.writes[1].details).toMatchObject({ body: overall, comments: 0 });
  });

  it('removes deselected prepared findings and keeps independent comments and summary text', async () => {
    const { runner, pr, finished, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const finding = (run.result as FullReviewResult).comments[0];

    await reviews.saveDraft('you', run.prId, { body: 'My introduction.' });

    const manual = await reviews.addComment(run.prId, {
      account: 'you',
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: 'My independent comment.',
    });
    const suggestion = await reviews.addComment(run.prId, {
      account: 'you',
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: 'An independently accepted AI suggestion.',
      origin: 'ai',
    });
    const prepared = await runner.prepareReview('you', run.id, [0]);

    await reviews.saveDraft('you', run.prId, { body: `${prepared.body}\n\nMy conclusion.` });

    const deselected = await runner.prepareReview('you', run.id, []);

    expect(deselected.body).toBe(
      `My introduction.\n\n${(run.result as FullReviewResult).overall}\n\nMy conclusion.`,
    );
    expect(deselected.comments.map((comment) => comment.id)).toEqual([manual.id, suggestion.id]);
    expect(deselected.preparedReview).toMatchObject({ indices: [] });
  });

  it('does not repeat a generated summary already saved in an unprepared draft', async () => {
    const { runner, pr, finished, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const overall = (run.result as FullReviewResult).overall;

    await reviews.saveDraft('you', run.prId, { body: overall });

    const draft = await runner.prepareReview('you', run.id, [0]);

    expect(draft.body.split(overall)).toHaveLength(2);
    expect(draft.body).toContain((run.result as FullReviewResult).comments[0].body);
    expect(draft.comments).toEqual([]);
  });

  it.each(['summary', 'comment'] as const)(
    'requires confirmation before replacing an edited %s and preserves a recoverable copy',
    async (edited) => {
      const { runner, pr, finished, reviews, github } = await setup();
      const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
      const prepared =
        edited === 'comment'
          ? await legacyPreparedReview(runner, reviews, run)
          : await runner.prepareReview('you', run.id, [0]);

      if (edited === 'summary')
        await reviews.saveDraft('you', run.prId, { body: 'My revised assessment.' });
      else
        await reviews.updateComment(
          'you',
          run.prId,
          prepared.comments[0].id,
          'My revised finding.',
        );

      const saved = reviews.draft('you', run.prId);
      const conflict = await runner
        .prepareReview('you', run.id, [])
        .catch((error: unknown) => error);

      expect(conflict).toBeInstanceOf(ReviewError);
      expect(conflict).toMatchObject({ code: 'PREPARED_REVIEW_EDITED', status: 409 });
      expect(reviews.draft('you', run.prId)).toEqual(saved);

      const replacement = await runner.prepareReview('you', run.id, [], {
        replace: true,
        expectedDraftRevision: (conflict as ReviewError).details.draftRevision as string,
      });

      expect(replacement.body).toBe((run.result as FullReviewResult).overall);
      expect(replacement.comments).toEqual([]);
      expect(replacement.preparedReview?.previousDrafts).toEqual([
        { body: saved.body, comments: saved.comments, savedAt: expect.any(String) },
      ]);
      expect(github.writes).toEqual([]);
    },
  );

  it('rejects replacement confirmation after another tab edits the draft', async () => {
    const { runner, pr, finished, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));

    await runner.prepareReview('you', run.id, [0]);
    await reviews.saveDraft('you', run.prId, { body: 'First edit.' });

    const conflict = await runner.prepareReview('you', run.id, []).catch((error: unknown) => error);

    await reviews.saveDraft('you', run.prId, { body: 'Newer edit from another tab.' });

    const saved = reviews.draft('you', run.prId);

    await expect(
      runner.prepareReview('you', run.id, [], {
        replace: true,
        expectedDraftRevision: (conflict as ReviewError).details.draftRevision as string,
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_CHANGED', status: 409 });
    expect(reviews.draft('you', run.prId)).toEqual(saved);
  });

  it('requires confirmation to replace legacy prepared content and keeps its saved copy', async () => {
    const { runner, pr, finished, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const prepared = await runner.prepareReview('you', run.id, [0]);

    reviews.drafts.saveMeta('you', run.prId, {
      preparedReview: {
        runId: run.id,
        preparedAt: prepared.preparedReview!.preparedAt,
        indices: [0],
      },
    });

    const saved = reviews.draft('you', run.prId);
    const conflict = await runner.prepareReview('you', run.id, []).catch((error: unknown) => error);

    expect(conflict).toMatchObject({ code: 'PREPARED_REVIEW_EDITED', status: 409 });
    expect(reviews.draft('you', run.prId)).toEqual(saved);

    const replacement = await runner.prepareReview('you', run.id, [], {
      replace: true,
      expectedDraftRevision: (conflict as ReviewError).details.draftRevision as string,
    });

    expect(replacement.comments).toEqual([]);
    expect(replacement.preparedReview?.previousDrafts?.[0]).toMatchObject({
      body: saved.body,
      comments: saved.comments,
    });
  });

  it.each(['edit', 'prepare', 'queue'] as const)(
    'does not overwrite a concurrent %s while refreshing the PR',
    async (change) => {
      const { runner, pr, finished, reviews, sync } = await setup();
      const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
      const refresh = sync.refresh.bind(sync);
      let reached!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      vi.spyOn(sync, 'refresh').mockImplementationOnce(async (...args) => {
        reached();
        await released;

        return refresh(...args);
      });

      const preparing = runner.prepareReview('you', run.id, [0]);

      await waiting;

      if (change === 'edit')
        await reviews.saveDraft('you', run.prId, { body: 'Newer manual edit.' });
      if (change === 'prepare') await runner.prepareReview('you', run.id, []);
      if (change === 'queue') reviews.drafts.lock('you', run.prId, 'queued-review');

      const saved = reviews.draft('you', run.prId);

      release();
      await expect(preparing).rejects.toMatchObject({
        code: change === 'queue' ? 'REVIEW_QUEUED' : 'DRAFT_CHANGED',
      });
      expect(reviews.draft('you', run.prId)).toEqual(saved);
    },
  );

  it('does not take ownership of an independently accepted identical AI comment', async () => {
    const { runner, pr, finished, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const finding = (run.result as FullReviewResult).comments[0];
    const accepted = await reviews.addComment(run.prId, {
      ...finding,
      account: 'you',
      origin: 'ai',
    });

    await runner.prepareReview('you', run.id, [0]);

    const deselected = await runner.prepareReview('you', run.id, []);

    expect(deselected.comments.map((comment) => comment.id)).toEqual([accepted.id]);
  });

  it('does not replace prepared findings that were already added to GitHub', async () => {
    const { runner, pr, finished, reviews, github } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const prepared = await legacyPreparedReview(runner, reviews, run);

    reviews.drafts.updateComment('you', prepared.comments[0].id, {
      status: 'pushed',
      githubThreadId: 'remote-thread',
    });

    const saved = reviews.draft('you', run.prId);

    await expect(runner.prepareReview('you', run.id, [])).rejects.toMatchObject({
      code: 'PENDING_REVIEW',
    });
    expect(reviews.draft('you', run.prId)).toEqual(saved);
    expect(github.writes).toEqual([]);
  });

  it('moves legacy prepared inline findings into the summary when reopening the same selection', async () => {
    const { runner, pr, finished, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));

    await legacyPreparedReview(runner, reviews, run);

    const draft = await runner.prepareReview('you', run.id, [0]);

    expect(draft.comments).toEqual([]);
    expect(draft.body).toContain((run.result as FullReviewResult).comments[0].body);
    expect(draft.event).toBe('APPROVE');
    expect(draft.preparedReview?.content?.comments).toEqual([]);
  });

  it.each(['assessment', 'finding'] as const)(
    'keeps approval unselected when a blocking %s exists, even if findings are deselected',
    async (blocking) => {
      const { runner, providers, pr, finished } = await setup();

      vi.spyOn(providers.codex, 'run').mockResolvedValueOnce({
        output: {
          overall: 'The empty input path must be fixed before merging.',
          assessment: blocking === 'assessment' ? 'changes_requested' : 'no_blocking_findings',
          comments:
            blocking === 'finding'
              ? [
                  {
                    path: 'src/example.ts',
                    line: 1,
                    side: 'RIGHT',
                    severity: 'blocking',
                    body: 'Empty input crashes.',
                  },
                ]
              : [],
          coverage: [],
        },
        model: 'test',
        usage: null,
      });

      const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
      const draft = await runner.prepareReview('you', run.id, []);

      expect(draft.event).toBe('COMMENT');
      expect(draft.comments).toEqual([]);
    },
  );

  it('grounds summaries with no pending comments in the diff and the current completed review', async () => {
    const { runner, providers, pr, finished, sync, diffs } = await setup();
    const providerRun = vi.spyOn(providers.codex, 'run');
    const first = await finished(await runner.start('you', pr(1839).id, 'draft_summary'));
    const snapshot = sync.detail(first.prId)!.snapshot;
    const diff = await diffs.manifest(snapshot, 'full', null);
    const patch = diff.files.find((file) => file.patch)!.patch!;
    const initialInput = providerRun.mock.calls[0][0].input;

    expect(first.status).toBe('done');
    expect(initialInput).toContain('<pending_comments>\n(none)\n</pending_comments>');
    expect(initialInput).toContain(annotatePatch(patch));
    expect(initialInput).not.toContain('<completed_review>');

    const review = await finished(await runner.start('you', first.prId, 'full_review'));
    const result = review.result as FullReviewResult;
    const summary = await finished(await runner.start('you', first.prId, 'draft_summary'));
    const input = providerRun.mock.lastCall![0].input;
    const evidence = JSON.parse(
      /<completed_review>\n([\s\S]*?)\n<\/completed_review>/.exec(input)![1],
    );

    expect(summary.status).toBe('done');
    expect(summary.id).not.toBe(first.id);
    expect(evidence).toEqual({ overall: result.overall, coverage: result.coverage });
    expect(input).toContain(annotatePatch(patch));
    expect(input).not.toContain(result.comments[0].body);
  });

  it('omits completed review evidence after the PR head moves', async () => {
    const { runner, providers, pr, finished, github, sync } = await setup();
    const review = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const providerRun = vi.spyOn(providers.codex, 'run');
    const pull = github.scenario.world.pulls.find((item) => item.snapshot.id === review.prId)!;

    pull.snapshot.headOid = pull.snapshot.baseOid!;
    await sync.refresh(review.prId);

    const summary = await finished(await runner.start('you', review.prId, 'draft_summary'));

    expect(summary.status).toBe('done');
    expect(providerRun.mock.lastCall![0].input).not.toContain('<completed_review>');
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

  it('persists prepared review details and reuses the saved draft without changing user edits', async () => {
    const { runner, pr, finished, reviews, sync, diffs, providers, root, exportRepository } =
      await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const [prepared] = await Promise.all([
      runner.prepareReview('you', run.id, [0]),
      runner.prepareReview('you', run.id, [0]),
    ]);

    expect(prepared.preparedReview).toMatchObject({ runId: run.id, indices: [0] });
    expect(reviews.draft('you', run.prId).comments).toEqual([]);
    expect(Date.parse(prepared.preparedReview!.preparedAt)).toBeGreaterThan(0);
    await reviews.saveDraft('you', run.prId, { body: 'My edited summary.', event: 'COMMENT' });
    await runner.close();

    const restarted = new AiRunner(
      sync,
      diffs,
      reviews,
      sync.events,
      providers,
      root,
      exportRepository,
    );
    restarted.open();
    const reused = await restarted.prepareReview('you', run.id, [0, 0]);

    expect(reused.body).toBe('My edited summary.');
    expect(reused.event).toBe('COMMENT');
    expect(reused.comments).toEqual([]);
    expect(reused.preparedReview).toEqual(prepared.preparedReview);
    expect(restarted.runs('you', run.prId)[0]).toMatchObject({ id: run.id, stale: false });
    await restarted.close();
  });

  it.each(['review', 'reply', 'description', 'base'] as const)(
    'invalidates a completed review after a new %s without a head change',
    async (change) => {
      const { runner, pr, finished, github, sync } = await setup();
      const run = await finished(await runner.start('you', pr(2041).id, 'full_review'));
      const snapshot = github.scenario.world.pulls.find(
        (pull) => pull.snapshot.id === run.prId,
      )!.snapshot;

      if (change === 'review')
        snapshot.reviews.push({ ...snapshot.reviews[0], id: 'new-review', body: 'New feedback.' });
      if (change === 'reply') snapshot.threads[0].comments[0].body = 'Updated review discussion.';
      if (change === 'description') snapshot.body += '\nUpdated requirements.';
      if (change === 'base') snapshot.baseOid = 'a'.repeat(40);
      await sync.refresh(run.prId);

      expect(runner.runs('you', run.prId)[0]).toMatchObject({ stale: true, headOid: run.headOid });
      await expect(runner.prepareReview('you', run.id, [])).rejects.toThrow('out of date');

      if (change !== 'base') {
        const fresh = await finished(await runner.start('you', run.prId, 'full_review'));

        expect(fresh.id).not.toBe(run.id);
        expect(fresh.stale).toBe(false);
      }
    },
  );

  it('keeps summaries reusable after body edits but requires regeneration after verdict or comment changes', async () => {
    const { runner, pr, finished, reviews } = await setup();
    const run = await finished(await runner.start('you', pr(1839).id, 'draft_summary'));

    await reviews.saveDraft('you', run.prId, { body: 'My own text.' });
    expect(runner.runs('you', run.prId)[0].stale).toBe(false);

    const applied = await runner.applySummary('you', run.id);

    expect(applied.body).toBe((run.result as { body: string }).body);
    await reviews.saveDraft('you', run.prId, { event: 'REQUEST_CHANGES' });
    expect(runner.runs('you', run.prId)[0]).toMatchObject({
      stale: true,
      staleReason: expect.stringContaining('verdict'),
    });
    await expect(runner.applySummary('you', run.id)).rejects.toThrow('Generate a new summary');

    const next = await finished(await runner.start('you', run.prId, 'draft_summary'));

    expect(next.id).not.toBe(run.id);
    expect(next.stale).toBe(false);
    await reviews.addComment(run.prId, {
      account: 'you',
      path: 'src/scheduling/CalendarTabs.tsx',
      line: null,
      body: 'Another issue.',
    });

    expect(runner.runs('you', run.prId)[0].stale).toBe(true);
    await expect(runner.applySummary('you', next.id)).rejects.toThrow('draft comments changed');
  });

  it('invalidates a saved summary when a newer full review completes even with identical output', async () => {
    const { runner, pr, finished } = await setup();
    const first = await finished(await runner.start('you', pr(1839).id, 'full_review'));
    const summary = await finished(await runner.start('you', first.prId, 'draft_summary'));
    const newer = await finished(
      await runner.start('you', first.prId, 'full_review', { force: true }),
    );

    expect(newer.result).toEqual(first.result);
    expect(runner.runs('you', first.prId).find((run) => run.id === summary.id)).toMatchObject({
      stale: true,
      staleReason: expect.stringContaining('newer full review'),
    });
    await expect(runner.applySummary('you', summary.id)).rejects.toThrow('newer full review');

    const fresh = await finished(await runner.start('you', first.prId, 'draft_summary'));

    expect(fresh.id).not.toBe(summary.id);
    expect(fresh.stale).toBe(false);
  });

  it('retains a completed review when a replacement fails and ignores refresh-only changes', async () => {
    const { runner, providers, pr, finished, sync } = await setup();
    const saved = await finished(await runner.start('you', pr(1839).id, 'full_review'));

    await sync.refresh(saved.prId);
    expect((await runner.start('you', saved.prId, 'full_review')).id).toBe(saved.id);
    providers.codex.failNext = 'Replacement failed';

    const failed = await finished(
      await runner.start('you', saved.prId, 'full_review', { force: true }),
    );
    const runs = runner.runs('you', saved.prId);

    expect(runs[0]).toMatchObject({ id: failed.id, status: 'failed' });
    expect(runs[1]).toMatchObject({ id: saved.id, status: 'done', stale: false });
  });

  it('marks a result out of date if review activity changes while it is generating', async () => {
    const { runner, providers, pr, finished, root, github, sync } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const run = await runner.start('you', pr(1839).id, 'full_review');

      await vi.waitFor(() => expect(controls.size).toBe(1));
      github.scenario.world.pulls.find((pull) => pull.snapshot.id === run.prId)!.snapshot.body +=
        ' Changed requirements.';
      await sync.refresh(run.prId);
      controls.get(join(root, run.id))!.complete();

      expect(await finished(run)).toMatchObject({ status: 'done', stale: true });
      await expect(runner.prepareReview('you', run.id, [])).rejects.toThrow('out of date');
    } finally {
      await runner.close();
    }
  });

  it('deduplicates simultaneous requests for the same review', async () => {
    const { runner, providers, pr, finished, root } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const runs = await Promise.all([
        runner.start('you', pr(1839).id, 'full_review'),
        runner.start('you', pr(1839).id, 'full_review'),
      ]);

      expect(runs[0].id).toBe(runs[1].id);
      await vi.waitFor(() => expect(controls.size).toBe(1));
      controls.get(join(root, runs[0].id))!.complete();
      expect((await finished(runs[0])).status).toBe('done');
    } finally {
      await runner.close();
    }
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

  it('saves incomplete repository preparation when the server shuts down', async () => {
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
    runner.open();
    const run = await runner.start('you', pr(1839).id, 'full_review');

    await started;
    await runner.close();

    expect(await finished(run)).toMatchObject({
      status: 'paused',
      pauseReason: 'restart',
      resumable: true,
    });
    expect(existsSync(join(root, run.id))).toBe(true);
    expect(github.writes).toEqual([]);
  });

  it('pauses and resumes the same review and checkpoint without downloading its snapshots again', async () => {
    const { runner, providers, pr, finished, root, exported, github } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const run = await runner.start('you', pr(1839).id, 'full_review');

      await vi.waitFor(() => expect(controls.size).toBe(1));
      runner.pause('you', run.id);
      expect(runner.runs('you', run.prId)[0]).toMatchObject({
        id: run.id,
        status: 'paused',
        pauseReason: 'user',
        resumable: true,
      });

      const resumed = await Promise.all([
        runner.resume('you', run.id),
        runner.resume('you', run.id),
      ]);

      expect(resumed.map((item) => item.id)).toEqual([run.id, run.id]);
      // The reused workspace is checked again before the turn.
      await vi.waitFor(() => expect(vi.mocked(providers.codex.run).mock.calls).toHaveLength(2));
      expect(vi.mocked(providers.codex.run).mock.calls[1][0].threadId).toBe(
        `thread-${join(root, run.id)}`,
      );
      expect(exported).toHaveLength(2);
      controls.get(join(root, run.id))!.complete();

      expect(await finished(run)).toMatchObject({
        id: run.id,
        status: 'done',
        createdAt: run.createdAt,
        resumable: false,
      });
      await runner.cleanedUp();
      expect(existsSync(join(root, run.id))).toBe(false);
      expect(github.writes).toEqual([]);
    } finally {
      await runner.close();
    }
  });

  it('resumes a queued review within the two-run limit and allows discarding a paused checkpoint', async () => {
    const { runner, providers, pr, root, finished } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const first = await runner.start('you', pr(1839).id, 'full_review');
      await runner.start('you', pr(2041).id, 'full_review');
      const queued = await runner.start('you', pr(2050).id, 'full_review');

      await vi.waitFor(() => expect(controls.size).toBe(2));
      runner.pause('you', queued.id);
      expect((await runner.resume('you', queued.id)).status).toBe('queued');
      runner.pause('you', first.id);

      await vi.waitFor(() => expect(controls.has(join(root, queued.id))).toBe(true));
      expect(runner.runs('you', first.prId)[0].status).toBe('paused');
      runner.cancel('you', first.id);

      expect(await finished(first)).toMatchObject({ status: 'cancelled', resumable: false });
      await runner.cleanedUp();
      expect(existsSync(join(root, first.id))).toBe(false);
      await expect(runner.resume('you', first.id)).rejects.toThrow('cannot be resumed');
    } finally {
      await runner.close();
    }
  });

  it('recovers saved runs from an on-disk database after a restart and rebuilds a missing workspace', async () => {
    const { github, providers, pr, exportRepository, exported } = await setup();
    const root = workDir();
    const path = join(root, 'state.sqlite');
    const controls = holdRuns(providers.codex);
    const openSession = () => {
      const store = new Store(path);
      const sync = new SyncService(store, github, new EventBus());
      const diffs = new DiffService(github);
      const reviews = new ReviewService(sync, github, diffs, sync.events);
      const runner = new AiRunner(
        sync,
        diffs,
        reviews,
        sync.events,
        providers,
        root,
        exportRepository,
      );
      runner.open();

      return { store, sync, runner };
    };
    let session = openSession();

    try {
      await session.sync.sync();
      const run = await session.runner.start('you', pr(1839).id, 'full_review');

      await vi.waitFor(() => expect(controls.size).toBe(1));
      await session.runner.close();
      expect(session.runner.runs('you', run.prId)[0]).toMatchObject({
        status: 'paused',
        pauseReason: 'restart',
        resumable: true,
      });
      // Simulate an abrupt process exit after the last persisted checkpoint.
      session.store.db.$client
        .prepare('UPDATE ai_runs SET status = ? WHERE id = ?')
        .run('running', run.id);
      session.store.close();
      rmSync(join(root, run.id), { recursive: true, force: true });
      session = openSession();
      await session.sync.sync();
      await session.runner.recover('you');

      await vi.waitFor(() => expect(vi.mocked(providers.codex.run).mock.calls).toHaveLength(2));
      expect(vi.mocked(providers.codex.run).mock.calls[1][0]).toMatchObject({
        threadId: `thread-${join(root, run.id)}`,
        workDir: join(root, run.id),
      });
      expect(exported).toHaveLength(4);
      controls.get(join(root, run.id))!.complete();

      await vi.waitFor(() => expect(session.runner.runs('you', run.prId)[0].status).toBe('done'));
      expect(session.runner.runs('you', run.prId)[0].id).toBe(run.id);
      await session.runner.cleanedUp();
      expect(existsSync(join(root, run.id))).toBe(false);
    } finally {
      await session.runner.close();
      session.store.close();
    }
  });

  it('resumes nothing while the run’s previous agent is still running', async () => {
    const { runner, providers, pr, sync, diffs, reviews, root, exportRepository } = await setup();
    const controls = holdRuns(providers.codex);
    const run = await runner.start('you', pr(1839).id, 'full_review');

    await vi.waitFor(() => expect(controls.size).toBe(1));
    await runner.close();

    // The run's lock is held, as by an agent a previous server left that has not ended yet.
    const lockPath = agentLockPath(join(root, run.id));

    mkdirSync(dirname(lockPath), { recursive: true });

    const held = new DatabaseSync(lockPath, { timeout: 0 });

    held.exec('PRAGMA locking_mode = EXCLUSIVE');
    held.exec('BEGIN EXCLUSIVE');

    const restarted = new AiRunner(
      sync,
      diffs,
      reviews,
      sync.events,
      providers,
      root,
      exportRepository,
    );

    restarted.agentExitWaitMs = 100;
    restarted.open();
    await restarted.recover('you');
    expect(restarted.runs('you', run.prId)[0]).toMatchObject({ status: 'paused' });

    // Nor does resuming it yourself.
    await expect(restarted.resume('you', run.id)).rejects.toMatchObject({
      code: 'AGENT_STILL_RUNNING',
    });
    expect(vi.mocked(providers.codex.run).mock.calls).toHaveLength(1);

    // Once it has exited, the run resumes.
    held.close();
    await restarted.recover('you');
    await vi.waitFor(() => expect(vi.mocked(providers.codex.run).mock.calls).toHaveLength(2));
    for (const control of controls.values()) control.complete();
    await restarted.close();
  });

  it('leaves user-paused reviews paused after restarting while recovering other runs', async () => {
    const { runner, providers, pr, sync, diffs, reviews, root, exportRepository } = await setup();
    const controls = holdRuns(providers.codex);
    const run = await runner.start('you', pr(1839).id, 'full_review');

    await vi.waitFor(() => expect(controls.size).toBe(1));
    runner.pause('you', run.id);
    await runner.close();
    const restarted = new AiRunner(
      sync,
      diffs,
      reviews,
      sync.events,
      providers,
      root,
      exportRepository,
    );
    restarted.open();

    await restarted.recover('you');
    expect(restarted.runs('you', run.prId)[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      resumable: true,
    });
    expect(vi.mocked(providers.codex.run).mock.calls).toHaveLength(1);
    await restarted.close();
  });

  it.each(['head', 'review', 'draft'] as const)(
    'refuses to resume when the %s changes while paused',
    async (change) => {
      const { runner, providers, pr, github, reviews, sync } = await setup();
      const controls = holdRuns(providers.codex);

      try {
        const run = await runner.start(
          'you',
          pr(2041).id,
          change === 'draft' ? 'draft_summary' : 'full_review',
        );

        await vi.waitFor(() => expect(controls.size).toBe(1));
        runner.pause('you', run.id);
        const snapshot = github.scenario.world.pulls.find(
          (pull) => pull.snapshot.id === run.prId,
        )!.snapshot;

        if (change === 'head') snapshot.headOid = snapshot.baseOid!;
        if (change === 'review')
          snapshot.reviews.push({ ...snapshot.reviews[0], id: 'new-review' });
        if (change === 'draft')
          await reviews.saveDraft('you', run.prId, { event: 'REQUEST_CHANGES' });
        await sync.refresh(run.prId);

        await expect(runner.resume('you', run.id)).rejects.toThrow(/changed|commits/);
        expect(runner.runs('you', run.prId)[0]).toMatchObject({
          status: 'paused',
          resumable: false,
        });
        expect(vi.mocked(providers.codex.run).mock.calls).toHaveLength(1);
      } finally {
        await runner.close();
      }
    },
  );

  it('keeps a saved checkpoint when resumption is blocked by plan usage and rejects another account', async () => {
    const { runner, providers, pr } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const run = await runner.start('you', pr(1839).id, 'full_review');

      await vi.waitFor(() => expect(controls.size).toBe(1));
      runner.pause('you', run.id);
      providers.codex.account.limitReached = true;

      await expect(runner.resume('other-account', run.id)).rejects.toThrow('no longer exists');
      await expect(runner.resume('you', run.id)).rejects.toThrow('plan');
      expect(runner.runs('you', run.prId)[0]).toMatchObject({ status: 'paused', resumable: true });
      expect(vi.mocked(providers.codex.run).mock.calls).toHaveLength(1);
    } finally {
      await runner.close();
    }
  });

  it('starts a new review when requested and discards the superseded paused checkpoint', async () => {
    const { runner, providers, pr, root } = await setup();
    const controls = holdRuns(providers.codex);

    try {
      const first = await runner.start('you', pr(1839).id, 'full_review');

      await vi.waitFor(() => expect(controls.size).toBe(1));
      runner.pause('you', first.id);
      expect((await runner.start('you', first.prId, 'full_review')).id).toBe(first.id);

      const fresh = await runner.start('you', first.prId, 'full_review', { force: true });

      expect(fresh.id).not.toBe(first.id);
      await vi.waitFor(() => expect(existsSync(join(root, first.id))).toBe(false));
      await expect(runner.resume('you', first.id)).rejects.toThrow('cannot be resumed');
    } finally {
      await runner.close();
    }
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

  it('refuses new Codex runs once the plan limit is used up, but still serves cached answers', async () => {
    const { runner, providers, pr, finished } = await setup();
    const first = await finished(await runner.start('you', pr(2041).id, 'brief'));

    providers.codex.account = {
      ...providers.codex.account,
      limitReached: true,
      problem: "Your ChatGPT plan's Codex limit is used up. Not run, so no credits are spent.",
    };

    expect((await runner.start('you', pr(2041).id, 'brief')).id).toBe(first.id);
    await expect(runner.start('you', pr(2041).id, 'brief', { force: true })).rejects.toMatchObject({
      code: 'PLAN_LIMIT',
      status: 409,
    });

    const claude = await finished(
      await runner.start('you', pr(2041).id, 'brief', { provider: 'claude' }),
    );

    expect(claude.status).toBe('done');
  });

  it("passes a task's model to Codex only", async () => {
    const { runner, providers, pr, finished } = await setup();
    const settings = defaultAiSettings();
    const codexRun = vi.spyOn(providers.codex, 'run');
    const claudeRun = vi.spyOn(providers.claude, 'run');

    settings.tasks.brief.model = 'gpt-demo-mini';
    runner.saveSettings(settings);

    await finished(await runner.start('you', pr(2041).id, 'brief'));
    await finished(await runner.start('you', pr(2041).id, 'brief', { provider: 'claude' }));

    expect(codexRun.mock.calls[0][0].model).toBe('gpt-demo-mini');
    expect(claudeRun.mock.calls[0][0].model).toBeNull();
  });

  it('marks legacy runs without saved inputs as interrupted by a restart', async () => {
    const { store, sync, reviews, providers, pr } = await setup();
    const runner = new AiRunner(
      sync,
      new DiffService(sync.github),
      reviews,
      sync.events,
      providers,
      workDir(),
    );
    runner.open();

    providers.codex.delayMs = 10_000;

    const run = await runner.start('you', pr(2041).id, 'brief');
    await runner.close();
    store.db.$client
      .prepare('UPDATE ai_runs SET status = ?, request = NULL WHERE id = ?')
      .run('running', run.id);
    const restarted = new AiRunner(
      sync,
      new DiffService(sync.github),
      reviews,
      sync.events,
      providers,
      workDir(),
    );
    restarted.open();

    expect(restarted.runs('you', run.prId)[0].status).toBe('interrupted');
    expect(store).toBeDefined();
  });
});

describe('review inputs', () => {
  const pr = (changedFiles = 2) =>
    ({ headOid: 'head', baseOid: 'target', changedFiles }) as PullRequestSnapshot;
  const remote = (path: string, status: string): RemoteFile => ({
    path,
    status,
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+x\n',
    sha: null,
  });
  const manifest = (changes: Partial<DiffManifest> = {}): DiffManifest => ({
    prId: 'pr',
    mode: 'full',
    kind: 'full',
    fromOid: 'target',
    toOid: 'head',
    files: [
      { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'live' },
      { path: 'b.ts', status: 'added', additions: 1, deletions: 0, patch: 'live' },
    ],
    ...changes,
  });
  const comparison = (filesComplete?: boolean): CompareResult => ({
    status: 'ahead',
    mergeBaseOid: 'merge-base',
    files: [remote('a.ts', 'modified'), remote('b.ts', 'added')],
    commits: [],
    ...(filesComplete === undefined ? {} : { filesComplete }),
  });
  const workspace = () => {
    const directory = workDir();

    for (const [side, path] of [
      ['before', 'a.ts'],
      ['after', 'a.ts'],
      ['after', 'b.ts'],
    ]) {
      mkdirSync(join(directory, side), { recursive: true });
      writeFileSync(join(directory, side, path), 'content');
    }

    return directory;
  };

  it('verifies the changed files by commit and gives the agent their own patches', async () => {
    const directory = workspace();
    const { inputs, files } = await observeInputs(
      directory,
      pr(),
      manifest(),
      comparison(true),
      'merge-base',
    );

    expect(inputs).toMatchObject({ inventory: 'verified', complete: true, unreadableCount: 0 });
    expect(files.map((file) => file.patch)).toEqual(['@@ -0,0 +1 @@\n+x\n', '@@ -0,0 +1 @@\n+x\n']);

    // A file the archive left out, or left as a symlink, cannot be read.
    rmSync(join(directory, 'after', 'b.ts'));
    symlinkSync('/etc/hosts', join(directory, 'after', 'b.ts'));
    rmSync(join(directory, 'before', 'a.ts'));

    expect(
      (await observeInputs(directory, pr(), manifest(), comparison(true), 'merge-base')).inputs,
    ).toMatchObject({
      complete: false,
      unreadable: [
        { path: 'a.ts', side: 'before' },
        { path: 'b.ts', side: 'after' },
      ],
      unreadableCount: 2,
    });
  });

  it('takes GitLab’s record of the revision only when it starts from the extracted merge base', async () => {
    const directory = workspace();
    const listing = (mergeBaseOid: string) =>
      manifest({ listing: { complete: true, mergeBaseOid } });

    expect(
      (await observeInputs(directory, pr(), listing('merge-base'), comparison(), 'merge-base'))
        .inputs,
    ).toMatchObject({ inventory: 'verified', complete: true });

    const other = await observeInputs(
      directory,
      pr(),
      listing('another-base'),
      comparison(),
      'merge-base',
    );

    expect(other.inputs).toMatchObject({ inventory: 'unverified', complete: false });
    expect(other.files.every((file) => file.patch === undefined)).toBe(true);
  });

  it('never reads a file through a symlinked directory or snapshot', async () => {
    const directory = workspace();
    const elsewhere = workDir();
    const nested: CompareResult = {
      ...comparison(true),
      files: [remote('a.ts', 'modified'), remote('src/c.ts', 'added')],
    };

    mkdirSync(join(directory, 'after', 'src'));
    writeFileSync(join(directory, 'after', 'src', 'c.ts'), 'content');
    expect(
      (await observeInputs(directory, pr(), manifest(), nested, 'merge-base')).inputs.complete,
    ).toBe(true);

    // The directory replaced by a link to one holding the same name.
    mkdirSync(join(elsewhere, 'src'));
    writeFileSync(join(elsewhere, 'src', 'c.ts'), 'content');
    rmSync(join(directory, 'after', 'src'), { recursive: true });
    symlinkSync(join(elsewhere, 'src'), join(directory, 'after', 'src'));

    expect(
      (await observeInputs(directory, pr(), manifest(), nested, 'merge-base')).inputs,
    ).toMatchObject({ complete: false, unreadable: [{ path: 'src/c.ts', side: 'after' }] });

    // The whole snapshot replaced by a link.
    mkdirSync(join(elsewhere, 'after'));
    writeFileSync(join(elsewhere, 'after', 'a.ts'), 'content');
    rmSync(join(directory, 'after'), { recursive: true });
    symlinkSync(join(elsewhere, 'after'), join(directory, 'after'));

    expect(
      (await observeInputs(directory, pr(), manifest(), comparison(true), 'merge-base')).inputs
        .unreadable,
    ).toEqual([
      { path: 'a.ts', side: 'after' },
      { path: 'b.ts', side: 'after' },
    ]);
  });

  it('reads a file whose name holds a backslash, as Git allows', async () => {
    const directory = workspace();
    const named: CompareResult = {
      ...comparison(true),
      files: [remote('a.ts', 'modified'), remote('notes\\draft.md', 'added')],
    };

    writeFileSync(join(directory, 'after', 'notes\\draft.md'), 'content');

    expect(
      (await observeInputs(directory, pr(), manifest(), named, 'merge-base')).inputs,
    ).toMatchObject({ complete: true, unreadableCount: 0 });
  });

  it('is incomplete when the forge counts other files than it lists', async () => {
    expect(
      (await observeInputs(workspace(), pr(3), manifest(), comparison(true), 'merge-base')).inputs,
    ).toMatchObject({ inventory: 'verified', complete: false, unreadableCount: 0 });
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
    // Relative to the snapshot's root, like the paths in the PR's diff.
    expect(omitted).toContain('outside');
  });
});
