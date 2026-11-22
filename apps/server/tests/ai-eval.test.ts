import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiTask } from '@review-desk/shared/ai';
import { ClaudeProvider } from '@/ai/claude.js';
import { CodexProvider } from '@/ai/codex.js';
import {
  at,
  check,
  compareReports,
  fixtureProblems,
  scoreCase,
  type CaseReport,
  type EvalReport,
  type Expectation,
} from '@/ai/eval.js';
import { runEval, type EvalOptions } from '@/ai/eval-run.js';
import type { AgentProvider, AgentRequest } from '@/ai/provider.js';

const fixtures = new URL('../../../tests/fixtures/ai/', import.meta.url).pathname;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();

  delete process.env.FAKE_CODEX_ANSWER;
  delete process.env.FAKE_CLAUDE_ANSWER;
});

const temp = () => {
  const directory = mkdtempSync(join(tmpdir(), 'rd-eval-test-'));

  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
};

const item = (expectation: Omit<Expectation, 'why'>) =>
  ({ ...expectation, why: 'labelled' }) as Expectation;
const passes = (task: AiTask, output: unknown, expectation: Omit<Expectation, 'why'>) =>
  check(task, output, item(expectation)).passed;

describe('what an answer is scored on', () => {
  const comments = {
    overall: 'One finding.',
    comments: [
      {
        path: 'src/a.ts',
        side: 'RIGHT',
        line: 11,
        severity: 'suggestion',
        body: 'Loop runs four times.',
      },
      { path: 'src/a.ts', side: 'RIGHT', line: null, severity: 'nit', body: 'Off the diff.' },
    ],
  };

  it('reads a JSON pointer, escapes and array indexes included', () => {
    expect(at({ 'a/b': { '~c': [1, 2] } }, '/a~1b/~0c/1')).toBe(2);
    expect(at({ a: 1 }, '')).toEqual({ a: 1 });
    expect(at({ a: 1 }, '/b/c')).toBeUndefined();
    expect(at({ a: 1 }, 'a')).toBeUndefined();
  });

  it('checks equality, one of, and a count', () => {
    expect(passes('brief', { risk: 'low' }, { equals: '/risk', value: 'low' })).toBe(true);
    expect(passes('brief', { risk: 'high' }, { equals: '/risk', value: 'low' })).toBe(false);
    expect(passes('brief', { risk: 'medium' }, { oneOf: '/risk', values: ['low', 'medium'] })).toBe(
      true,
    );
    expect(passes('brief', { risk: 'high' }, { oneOf: '/risk', values: ['low', 'medium'] })).toBe(
      false,
    );
    expect(
      passes('brief', { questions: ['a', 'b'] }, { count: '/questions', min: 1, max: 2 }),
    ).toBe(true);
    expect(passes('brief', { questions: ['a', 'b', 'c'] }, { count: '/questions', max: 2 })).toBe(
      false,
    );
    expect(passes('brief', { questions: 'none' }, { count: '/questions', min: 0 })).toBe(false);
  });

  it('matches a text, or any text of a list, with its flags', () => {
    expect(
      passes(
        'brief',
        { summary: 'Needs a BACKOFF.' },
        { matches: '/summary', pattern: 'backoff', flags: 'i' },
      ),
    ).toBe(true);
    expect(
      passes('brief', { summary: 'Needs a BACKOFF.' }, { matches: '/summary', pattern: 'backoff' }),
    ).toBe(false);
    expect(
      passes(
        'brief',
        { questions: ['Why?', 'What delay?'] },
        { matches: '/questions', pattern: 'delay' },
      ),
    ).toBe(true);
    expect(passes('brief', {}, { matches: '/summary', pattern: '.' })).toBe(false);
  });

  it('finds one comment by its path, side and line, in any order, its body matched', () => {
    expect(
      passes('draft_comments', comments, {
        comment: { path: 'src/a.ts', side: 'RIGHT', line: 11, body: 'four' },
      }),
    ).toBe(true);
    expect(
      passes('draft_comments', comments, {
        comment: { path: 'src/a.ts', side: 'RIGHT', line: null },
      }),
    ).toBe(true);
    expect(
      passes('draft_comments', comments, { comment: { path: 'src/a.ts', side: 'LEFT', line: 11 } }),
    ).toBe(false);
    // A line where no comment is.
    expect(
      passes('draft_comments', comments, {
        comment: { path: 'src/a.ts', side: 'RIGHT', line: 12 },
      }),
    ).toBe(false);
    expect(
      passes('draft_comments', comments, {
        comment: { path: 'src/a.ts', side: 'RIGHT', line: 11, body: 'delay' },
      }),
    ).toBe(false);
  });

  it("judges a thread by its id, whatever the order of the answer's threads", () => {
    const answer = {
      threads: [
        { threadId: 't-2', verdict: 'not_addressed' },
        { threadId: 't-1', verdict: 'partially' },
      ],
    };

    expect(
      passes('since_review', answer, {
        thread: { threadId: 't-1', verdict: ['addressed', 'partially'] },
      }),
    ).toBe(true);
    expect(
      passes('since_review', answer, { thread: { threadId: 't-2', verdict: ['addressed'] } }),
    ).toBe(false);
    expect(
      passes('since_review', answer, { thread: { threadId: 't-3', verdict: ['addressed'] } }),
    ).toBe(false);
  });

  it('calls a full review clean by the rule the app applies: a blocking comment is not clean', () => {
    const review = { assessment: 'no_blocking_findings', comments: [], overall: '', coverage: [] };

    expect(passes('full_review', review, { clean: true })).toBe(true);
    expect(
      passes('full_review', { ...review, assessment: 'changes_requested' }, { clean: true }),
    ).toBe(false);
    expect(
      passes(
        'full_review',
        { ...review, comments: [{ ...comments.comments[0], severity: 'blocking' }] },
        { clean: true },
      ),
    ).toBe(false);
    expect(passes('draft_comments', comments, { clean: true })).toBe(true);
    expect(
      passes(
        'draft_comments',
        { ...comments, comments: [{ ...comments.comments[0], severity: 'blocking' }] },
        { clean: true },
      ),
    ).toBe(false);
  });
});

describe('fixtures', () => {
  const base = {
    id: 'case',
    note: 'A case.',
    evidence: { pr: { id: 'PR' }, diff: { kind: 'full', files: [] } },
    expect: [{ clean: true, why: 'nothing blocking' }],
  };

  it.each(
    readdirSync(join(fixtures, 'eval')).flatMap((task) =>
      readdirSync(join(fixtures, 'eval', task)).map((file) => [task, file] as const),
    ),
  )('runs the checked-in %s fixture %s', (task, file) => {
    const raw = JSON.parse(readFileSync(join(fixtures, 'eval', task, file), 'utf8')) as {
      id: string;
    };

    expect(fixtureProblems(task as AiTask, raw)).toEqual([]);
    expect(`${raw.id}.json`).toBe(file);
  });

  it('fails an answer that denies the off-by-one, in a full review and in a comment', () => {
    const review = checkedIn('full_review', 'off-by-one') as { expect: Expectation[] };
    const comments = checkedIn('draft_comments', 'off-by-one') as { expect: Expectation[] };
    const denial = {
      overall: 'The loop makes three attempts and looks correct.',
      assessment: 'no_blocking_findings',
      comments: [],
      coverage: ['Read src/upload.ts.'],
    };
    const finding = {
      ...denial,
      overall: 'The loop makes four attempts: `<= 3` allows one too many.',
    };
    const comment = (body: string) => ({
      overall: '',
      comments: [{ path: 'src/upload.ts', side: 'RIGHT', line: 11, severity: 'blocking', body }],
    });

    const found = {
      ...denial,
      overall: 'I checked for an off-by-one in the loop bound and found none.',
    };

    expect(scoreCase('full_review', found, review.expect).passed).toBe(false);
    expect(
      scoreCase(
        'draft_comments',
        comment('I checked for an off-by-one in the loop bound and found none.'),
        comments.expect,
      ).passed,
    ).toBe(false);
    expect(
      scoreCase('full_review', { ...denial, overall: 'It should be `attempt < 3`.' }, review.expect)
        .passed,
    ).toBe(true);
    expect(scoreCase('full_review', denial, review.expect).passed).toBe(false);
    expect(scoreCase('full_review', finding, review.expect).passed).toBe(true);
    expect(
      scoreCase(
        'draft_comments',
        comment('This loop looks right: three attempts.'),
        comments.expect,
      ).passed,
    ).toBe(false);
    expect(
      scoreCase(
        'draft_comments',
        comment('`<= 3` makes four attempts, not three.'),
        comments.expect,
      ).passed,
    ).toBe(true);
  });

  it('refuses a diff whose fields prompts and anchoring read are of the wrong kind', () => {
    const file = { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: 42 };

    expect(
      fixtureProblems('draft_comments', {
        ...base,
        evidence: { pr: {}, diff: { kind: 'full', files: [file] } },
      }).join(),
    ).toContain('evidence.diff.files.0.patch');
  });

  it('refuses a comment body that is not a pattern', () => {
    expect(
      fixtureProblems('draft_comments', {
        ...base,
        expect: [{ comment: { path: 'a', side: 'RIGHT', line: 1, body: '(' }, why: 'x' }],
      }),
    ).toEqual(['expect: ( is not a pattern.']);
  });

  it('refuses a fixture missing evidence its task reads', () => {
    expect(fixtureProblems('since_review', { ...base, evidence: { pr: {} } })).toEqual([
      'evidence.diff: the task reads a diff.',
      'evidence.login: the task reads your login.',
    ]);
    expect(fixtureProblems('draft_summary', base)).toEqual([
      'evidence.draft: the task reads your draft.',
      'evidence.completedReview: the task reads the completed review (null for none).',
    ]);
  });

  it('refuses an anchoring task without the full diff, and a workspace where none or one is read', () => {
    expect(
      fixtureProblems('draft_comments', {
        ...base,
        evidence: { pr: {}, diff: { kind: 'since-review', files: [] } },
      }),
    ).toContain('evidence.diff: anchoring needs the full diff.');
    expect(fixtureProblems('full_review', base)).toContain(
      'workspace: the task reads a workspace.',
    );
    expect(
      fixtureProblems('brief', { ...base, workspace: { review: {}, before: {}, after: {} } }),
    ).toContain('workspace: the task reads no workspace.');
  });

  it('refuses a workspace path that leaves its folder, an empty list of expectations, and a bad pattern', () => {
    const escaping = (path: string) =>
      fixtureProblems('full_review', {
        ...base,
        workspace: { review: {}, before: { [path]: '' }, after: {} },
      });

    expect(escaping('../outside.ts').join()).toContain('must stay inside its folder');
    expect(escaping('/etc/passwd').join()).toContain('must stay inside its folder');
    expect(escaping('src/inside.ts')).toEqual([]);
    expect(fixtureProblems('brief', { ...base, expect: [] }).join()).toContain('expect');
    expect(
      fixtureProblems('brief', {
        ...base,
        expect: [{ matches: '/summary', pattern: '(', why: 'x' }],
      }),
    ).toEqual(['expect: ( is not a pattern.']);
  });
});

describe('comparing two runs', () => {
  const report = (
    cases: Partial<CaseReport>[],
    overrides: Partial<EvalReport> = {},
  ): EvalReport => ({
    provider: 'codex',
    model: null,
    effort: 'medium',
    complete: true,
    tasks: [
      {
        task: 'brief',
        promptVersion: 1,
        digest: 'd',
        cases: cases.map((item, index) => ({
          id: `case-${index}`,
          hash: `hash-${index}`,
          passed: true,
          results: [{ why: 'risk', passed: true, reason: 'ok' }],
          model: 'gpt',
          ...item,
        })),
      },
    ],
    ...overrides,
  });

  it('flags a case that passed and fails now, with the label that changed', () => {
    const failing = { passed: false, results: [{ why: 'risk', passed: false, reason: 'is high' }] };
    const { refusals, changes, regressed } = compareReports(
      report([{}, failing]),
      report([failing, {}]),
    );

    expect(refusals).toEqual([]);
    expect(regressed).toBe(true);
    expect(changes.map((item) => item.change)).toEqual(['regressed', 'fixed']);
    expect(changes[0].labels).toEqual([{ why: 'risk', from: true, to: false, reason: 'is high' }]);
  });

  it('is content when nothing that passed fails, whatever was already failing', () => {
    const failing = { passed: false, results: [{ why: 'risk', passed: false, reason: 'is high' }] };

    expect(compareReports(report([{}, failing]), report([{}, failing]))).toMatchObject({
      refusals: [],
      regressed: false,
      changes: [{ change: 'still passing' }, { change: 'still failing' }],
    });
  });

  it('refuses what is not a report, one with no cases, a case twice, or a case with no known model', () => {
    const refused = (baseline: unknown, candidate: unknown) =>
      compareReports(baseline, candidate).refusals;
    const twice = report([{}, {}]);

    twice.tasks[0].cases[1].id = 'case-0';

    expect(refused({ cases: [] }, report([{}]))).toEqual(['The baseline is not a report.']);
    expect(refused(report([]), report([]))).toEqual([
      'The baseline has no cases.',
      'The candidate has no cases.',
    ]);
    expect(refused(twice, report([{}]))).toContain('The baseline has brief/case-0 more than once.');
    expect(refused(report([{ model: null }]), report([{ model: null }]))).toEqual([
      "The baseline's brief/case-0 was answered by an unknown model.",
      "The candidate's brief/case-0 was answered by an unknown model.",
    ]);
  });

  it('refuses runs that are incomplete, or ran differently, or on other cases', () => {
    const refused = (baseline: EvalReport, candidate: EvalReport) =>
      compareReports(baseline, candidate).refusals;

    expect(refused(report([{}], { complete: false }), report([{}]))).toEqual([
      'The baseline is incomplete: rerun it.',
    ]);
    expect(refused(report([{}]), report([{}], { provider: 'claude' }))).toEqual([
      'The two ran on different providers.',
    ]);
    expect(refused(report([{}]), report([{}], { effort: 'high' }))).toEqual([
      'The two ran at different efforts.',
    ]);
    expect(refused(report([{}]), report([{}], { model: 'gpt-mini' }))).toEqual([
      'The two asked for different models.',
    ]);
    expect(refused(report([{}]), report([{}, {}]))).toEqual([
      'brief/case-1 ran in only one of the two.',
    ]);
    expect(refused(report([{}]), report([{ hash: 'other' }]))).toEqual([
      'brief/case-0 is not the same case in the two.',
    ]);
    expect(refused(report([{}]), report([{ model: 'gpt-fallback' }]))).toEqual([
      'brief/case-0 was answered by gpt and gpt-fallback.',
    ]);
  });
});

/** A folder of fixtures for the given tasks. */
function folder(cases: Record<string, unknown[]>): string {
  const directory = temp();

  for (const [task, list] of Object.entries(cases)) {
    mkdirSync(join(directory, task), { recursive: true });

    for (const fixture of list as { id: string }[])
      writeFileSync(join(directory, task, `${fixture.id}.json`), JSON.stringify(fixture));
  }

  return directory;
}

const checkedIn = (task: AiTask, id: string) =>
  JSON.parse(readFileSync(join(fixtures, 'eval', task, `${id}.json`), 'utf8')) as Record<
    string,
    unknown
  >;

/** An agent that answers each request with `answer(request)`, recording what it was given. */
function agent(answer: (request: AgentRequest) => unknown, model = 'stub-model') {
  const seen: { request: AgentRequest; files: string[] }[] = [];
  const run = vi.fn(async (request: AgentRequest) => {
    const files = existsSync(request.workDir)
      ? readdirSync(request.workDir, { recursive: true, encoding: 'utf8' }).sort()
      : [];

    seen.push({ request, files });

    return { output: answer(request), model, usage: null };
  });

  return { provider: { run } as unknown as AgentProvider, run, seen };
}

const options = (overrides: Partial<EvalOptions>): EvalOptions => ({
  tasks: ['brief'],
  provider: 'codex',
  model: null,
  effort: 'low',
  fixtures: join(fixtures, 'eval'),
  pins: {},
  agents: { codex: agent(() => ({})).provider, claude: agent(() => ({})).provider },
  ...overrides,
});

describe('a run', () => {
  it('asks no agent when a fixture cannot be run, or the provider cannot run its task', async () => {
    const codex = agent(() => ({}));
    const bad = { ...checkedIn('brief', 'retry-loop'), expect: [] };

    expect(
      await runEval(
        options({
          fixtures: folder({ brief: [bad] }),
          agents: { codex: codex.provider, claude: codex.provider },
        }),
      ),
    ).toMatchObject({
      problems: [expect.stringContaining('retry-loop.json')],
    });
    expect(await runEval(options({ tasks: ['full_review'], provider: 'claude' }))).toMatchObject({
      problems: ['full_review runs on codex only.'],
    });
    expect(codex.run).not.toHaveBeenCalled();
  });

  it("asks no agent when a case's prompt cannot be built, or two cases share an id", async () => {
    const codex = agent(() => ({}));
    const fine = checkedIn('brief', 'retry-loop');
    const broken = {
      ...fine,
      id: 'broken',
      evidence: { pr: { id: 'PR' }, diff: { kind: 'full', files: [] } },
    };
    const twin = { ...fine, note: 'Another case with the same id.' };

    expect(
      await runEval(
        options({
          fixtures: folder({ brief: [fine, broken] }),
          agents: { codex: codex.provider, claude: codex.provider },
        }),
      ),
    ).toMatchObject({ problems: [expect.stringContaining('its prompt cannot be built')] });

    const twins = folder({ brief: [fine] });

    writeFileSync(join(twins, 'brief', 'zz-twin.json'), JSON.stringify(twin));

    expect(
      await runEval(
        options({ fixtures: twins, agents: { codex: codex.provider, claude: codex.provider } }),
      ),
    ).toMatchObject({
      problems: [expect.stringContaining('another brief case has the id retry-loop')],
    });
    expect(codex.run).not.toHaveBeenCalled();
  });

  it('records a workspace that cannot be laid out as a setup failure, removes its folder, and goes on', async () => {
    const codex = agent(() => ({
      overall: 'Typo fixed; nothing else changed.',
      comments: [],
      assessment: 'no_blocking_findings',
      coverage: ['Read README.md.'],
    }));
    const clean = checkedIn('full_review', 'clean-typo');
    // A file where a folder must go: laying it out fails.
    const clashing = {
      ...clean,
      id: 'aa-clashing',
      workspace: {
        ...(clean.workspace as object),
        before: { src: 'a file', 'src/inside.ts': 'cannot be written' },
      },
    };
    const before = readdirSync(tmpdir()).filter((name) =>
      name.startsWith('review-desk-eval-'),
    ).length;
    const outcome = await runEval(
      options({
        tasks: ['full_review'],
        fixtures: folder({ full_review: [clashing, clean] }),
        agents: { codex: codex.provider, claude: codex.provider },
      }),
    );

    expect(outcome).toMatchObject({
      report: {
        complete: false,
        tasks: [
          {
            cases: [
              { id: 'aa-clashing', passed: false, error: expect.any(String) },
              { id: 'clean-typo', passed: true },
            ],
          },
        ],
      },
    });
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(
      readdirSync(tmpdir()).filter((name) => name.startsWith('review-desk-eval-')).length,
    ).toBe(before);
  });

  it('records a folder that cannot be removed against its case, keeps its score, and goes on', async () => {
    const locked: string[] = [];
    const codex = agent((request) => {
      // Something in the folder that cannot be removed.
      const inner = join(request.workDir, 'locked');

      mkdirSync(join(inner, 'deep'), { recursive: true });
      writeFileSync(join(inner, 'deep', 'file'), 'x');
      chmodSync(inner, 0o500);
      locked.push(inner);

      return {
        summary: 'Retries uploads.',
        risk: 'low',
        riskReasons: [],
        focusFiles: [{ path: 'src/upload.ts', reason: 'The loop.' }],
        questions: [],
      };
    });

    cleanups.push(() => {
      for (const inner of locked) {
        chmodSync(inner, 0o700);
        rmSync(dirname(inner), { recursive: true, force: true });
      }
    });

    const second = { ...checkedIn('brief', 'retry-loop'), id: 'second' };
    const outcome = await runEval(
      options({
        fixtures: folder({ brief: [checkedIn('brief', 'retry-loop'), second] }),
        agents: { codex: codex.provider, claude: codex.provider },
      }),
    );

    expect(outcome).toMatchObject({
      report: {
        complete: true,
        tasks: [
          {
            cases: [
              { id: 'retry-loop', passed: true, cleanupError: expect.any(String) },
              { id: 'second', passed: true, cleanupError: expect.any(String) },
            ],
          },
        ],
      },
    });
  });

  it.each([
    ['codex', 'FAKE_CODEX_ANSWER', 'not json at all', 'gpt-fake'],
    ['claude', 'FAKE_CLAUDE_ANSWER', 'null', null],
  ] as const)(
    'fails a case whose %s turn finished without an answer, keeping the run complete',
    async (provider, variable, answer, model) => {
      const file = join(temp(), 'answer.txt');

      writeFileSync(file, answer);
      process.env[variable] = file;

      const agents = {
        codex: new CodexProvider(join(fixtures, 'fake-codex.mjs')),
        claude: new ClaudeProvider(join(fixtures, 'fake-claude.mjs')),
      };
      const outcome = await runEval(
        options({
          provider,
          fixtures: folder({ brief: [checkedIn('brief', 'retry-loop')] }),
          agents,
        }),
      );

      expect(outcome).toMatchObject({
        report: {
          complete: true,
          tasks: [
            {
              cases: [{ passed: false, shapeError: expect.stringContaining('structured answer') }],
            },
          ],
        },
      });
      if (model) expect(outcome).toMatchObject({ report: { tasks: [{ cases: [{ model }] }] } });
    },
  );

  it('gives a full review its workspace in a fresh folder and a fresh session, and scores the answer', async () => {
    const answer = {
      overall: 'The loop makes four attempts: `<= 3` should be `< 3`.',
      comments: [],
      assessment: 'changes_requested',
      coverage: ['Read src/upload.ts.'],
    };
    const codex = agent(() => answer);
    const outcome = await runEval(
      options({
        tasks: ['full_review'],
        fixtures: folder({ full_review: [checkedIn('full_review', 'off-by-one')] }),
        agents: { codex: codex.provider, claude: codex.provider },
      }),
    );

    expect(codex.seen[0].files).toEqual([
      'after',
      'after/src',
      'after/src/upload.ts',
      'before',
      'before/src',
      'before/src/upload.ts',
      'review.json',
    ]);
    expect(codex.seen[0].request).toMatchObject({
      task: 'full_review',
      effort: 'low',
      model: null,
    });
    expect(codex.seen[0].request.threadId).toBeUndefined();
    expect(codex.seen[0].request.onThread).toBeUndefined();
    // The folder is gone once the case is scored.
    expect(existsSync(codex.seen[0].request.workDir)).toBe(false);
    expect(outcome).toMatchObject({
      report: {
        complete: true,
        tasks: [
          { task: 'full_review', cases: [{ id: 'off-by-one', passed: true, model: 'stub-model' }] },
        ],
      },
    });
  });

  it('fails a case answered in another shape, and records an agent that failed as an incomplete run', async () => {
    const shape = await runEval(
      options({
        fixtures: folder({ brief: [checkedIn('brief', 'retry-loop')] }),
        agents: {
          codex: agent(() => ({ summary: 1 })).provider,
          claude: agent(() => ({})).provider,
        },
      }),
    );
    const failing: AgentProvider = {
      run: async () => Promise.reject(new Error('Rate limited.')),
    } as unknown as AgentProvider;
    const broken = await runEval(
      options({
        fixtures: folder({ brief: [checkedIn('brief', 'retry-loop')] }),
        agents: { codex: failing, claude: failing },
      }),
    );

    expect(shape).toMatchObject({
      report: {
        complete: true,
        tasks: [{ cases: [{ passed: false, shapeError: expect.any(String) }] }],
      },
    });
    expect(broken).toMatchObject({
      report: { complete: false, tasks: [{ cases: [{ passed: false, error: 'Rate limited.' }] }] },
    });
  });

  it('anchors through the real transport before scoring: a comment off the diff is scored as having no line', async () => {
    const answers = temp();
    const answer = join(answers, 'answer.json');
    const fixture = {
      ...checkedIn('draft_comments', 'off-by-one'),
      expect: [
        { comment: { path: 'src/upload.ts', side: 'RIGHT', line: 11 }, why: 'kept, on the diff' },
        {
          comment: { path: 'src/upload.ts', side: 'RIGHT', line: null, body: 'outside' },
          why: 'off the diff: no line',
        },
      ],
    };

    writeFileSync(
      answer,
      JSON.stringify({
        overall: 'Two comments.',
        comments: [
          {
            path: 'src/upload.ts',
            line: 11,
            side: 'RIGHT',
            severity: 'suggestion',
            body: 'Four attempts.',
          },
          {
            path: 'src/upload.ts',
            line: 99,
            side: 'RIGHT',
            severity: 'nit',
            body: 'A line outside the diff.',
          },
        ],
      }),
    );
    process.env.FAKE_CODEX_ANSWER = answer;

    const codex = new CodexProvider(join(fixtures, 'fake-codex.mjs'));
    const outcome = await runEval(
      options({
        tasks: ['draft_comments'],
        fixtures: folder({ draft_comments: [fixture] }),
        agents: { codex, claude: codex },
      }),
    );

    expect(outcome).toMatchObject({
      report: { complete: true, tasks: [{ cases: [{ passed: true, model: 'gpt-fake' }] }] },
    });
  });
});

describe('the commands', () => {
  const run = (script: string, args: string[]) =>
    spawnSync('pnpm', ['--filter', '@review-desk/server', script, ...args], { encoding: 'utf8' });

  it('runs a task through a stand-in agent and saves its report', () => {
    const out = join(temp(), 'report.json');
    const answer = join(temp(), 'answer.json');

    writeFileSync(
      answer,
      JSON.stringify({
        summary: 'Retries uploads.',
        risk: 'low',
        riskReasons: [],
        focusFiles: [{ path: 'src/upload.ts', reason: 'The loop.' }],
        questions: [],
      }),
    );

    const result = spawnSync(
      'pnpm',
      [
        '--filter',
        '@review-desk/server',
        'ai:eval',
        'brief',
        '--effort',
        'low',
        '--out',
        out,
        '--codex-command',
        join(fixtures, 'fake-codex.mjs'),
      ],
      { encoding: 'utf8', env: { ...process.env, FAKE_CODEX_ANSWER: answer } },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
      provider: 'codex',
      complete: true,
      tasks: [{ task: 'brief', cases: [{ id: 'retry-loop', passed: true }] }],
    });
  });

  it('exits 1 on a regression, 2 on runs that cannot be compared, 0 otherwise', () => {
    const directory = temp();
    const write = (name: string, passed: boolean, complete = true) => {
      const path = join(directory, `${name}.json`);

      writeFileSync(
        path,
        JSON.stringify({
          provider: 'codex',
          model: null,
          effort: 'low',
          complete,
          tasks: [
            {
              task: 'brief',
              promptVersion: 1,
              digest: null,
              cases: [{ id: 'c', hash: 'h', passed, results: [], model: 'm' }],
            },
          ],
        }),
      );

      return path;
    };

    expect(run('ai:eval:compare', [write('passing', true), write('failing', false)]).status).toBe(
      1,
    );
    expect(run('ai:eval:compare', [write('a', true), write('b', true)]).status).toBe(0);
    expect(run('ai:eval:compare', [write('c', true, false), write('d', true)]).status).toBe(2);
  });
});
