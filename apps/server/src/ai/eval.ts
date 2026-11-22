import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { hasBlockingFindings, type AiTask, type FullReviewResult } from '@review-desk/shared/ai';
import { canonical } from '@/ai/prompt-pins.js';
import { TASKS } from '@/ai/tasks.js';

/**
 * Evaluating a task's prompt against labelled fixtures (`pnpm ai:eval`): what a fixture is, how an
 * answer is scored against it, and how two runs compare. Pure; the command runs the providers.
 */

const why = z.string().min(1);

/** A labelled property an answer must have, each with why it is expected. */
const expectation = z.union([
  z.strictObject({ equals: z.string(), value: z.unknown(), why }),
  z.strictObject({ oneOf: z.string(), values: z.array(z.unknown()).min(1), why }),
  z.strictObject({ matches: z.string(), pattern: z.string(), flags: z.string().optional(), why }),
  z.strictObject({
    count: z.string(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    why,
  }),
  z.strictObject({
    comment: z.strictObject({
      path: z.string(),
      side: z.enum(['LEFT', 'RIGHT']),
      line: z.number().int().nullable(),
      body: z.string().optional(),
      /** Its severity, one of these: what it asks of the author. */
      severity: z
        .array(z.enum(['blocking', 'suggestion', 'nit', 'question']))
        .min(1)
        .optional(),
    }),
    why,
  }),
  z.strictObject({
    thread: z.strictObject({ threadId: z.string(), verdict: z.array(z.string()).min(1) }),
    why,
  }),
  z.strictObject({ clean: z.literal(true), why }),
]);

export type Expectation = z.infer<typeof expectation>;

/** A path inside `before/` or `after/`: never absolute, never climbing out. */
const inside = (path: string) =>
  path.length > 0 && !isAbsolute(path) && !normalize(path).startsWith('..');

/** One labelled case: what the task is given, and what its answer must show. */
export const fixtureSchema = z.strictObject({
  /** Stable across runs: how two reports pair their cases. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  note: z.string().min(1),
  evidence: z.strictObject({
    pr: z.record(z.string(), z.unknown()),
    // The fields prompts and anchoring read, typed: a wrong one fails here, before any agent.
    diff: z
      .looseObject({
        kind: z.string(),
        fromOid: z.string().optional(),
        toOid: z.string().optional(),
        note: z.string().optional(),
        files: z.array(
          z.looseObject({
            path: z.string(),
            previousPath: z.string().optional(),
            status: z.string(),
            additions: z.number().int(),
            deletions: z.number().int(),
            patch: z.string().optional(),
            binary: z.boolean().optional(),
            generated: z.boolean().optional(),
            tooLarge: z.boolean().optional(),
          }),
        ),
      })
      .optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
    completedReview: z
      .strictObject({ id: z.string(), result: z.record(z.string(), z.unknown()).nullable() })
      .nullable()
      .optional(),
    login: z.string().optional(),
  }),
  /** A full review's workspace: `review.json`, and the repository before and after. */
  workspace: z
    .strictObject({
      review: z.record(z.string(), z.unknown()),
      before: z.record(z.string(), z.string()),
      after: z.record(z.string(), z.string()),
    })
    .optional(),
  expect: z.array(expectation).min(1),
});

export type Fixture = z.infer<typeof fixtureSchema>;

/** What is wrong with `raw` as a fixture of `task`; empty when it can be run. */
export function fixtureProblems(task: AiTask, raw: unknown): string[] {
  const parsed = fixtureSchema.safeParse(raw);

  if (!parsed.success)
    return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  const fixture = parsed.data;
  const declared = TASKS[task].evidence;
  const problems: string[] = [];

  if (declared.diff !== null && !fixture.evidence.diff)
    problems.push('evidence.diff: the task reads a diff.');
  // Its comments are anchored to the full diff: a fixture of an anchoring task must give one.
  if (TASKS[task].anchor && fixture.evidence.diff?.kind !== 'full')
    problems.push('evidence.diff: anchoring needs the full diff.');
  if (declared.draft && !fixture.evidence.draft)
    problems.push('evidence.draft: the task reads your draft.');
  if (declared.completedReview && fixture.evidence.completedReview === undefined)
    problems.push('evidence.completedReview: the task reads the completed review (null for none).');
  if (declared.login && !fixture.evidence.login)
    problems.push('evidence.login: the task reads your login.');
  if (TASKS[task].execution === 'workspace' && !fixture.workspace)
    problems.push('workspace: the task reads a workspace.');
  if (TASKS[task].execution !== 'workspace' && fixture.workspace)
    problems.push('workspace: the task reads no workspace.');

  for (const side of ['before', 'after'] as const)
    for (const path of Object.keys(fixture.workspace?.[side] ?? {}))
      if (!inside(path))
        problems.push(`workspace.${side}.${path}: a workspace path must stay inside its folder.`);

  // Every pattern compiles now, never after an agent has answered.
  for (const item of fixture.expect) {
    const pattern =
      'matches' in item
        ? { source: item.pattern, flags: item.flags }
        : 'comment' in item && item.comment.body !== undefined
          ? { source: item.comment.body, flags: 'i' }
          : null;

    if (pattern)
      try {
        new RegExp(pattern.source, pattern.flags);
      } catch {
        problems.push(`expect: ${pattern.source} is not a pattern.`);
      }
  }

  return problems;
}

/** A case's identity for comparing runs: its evidence, workspace and expectations, hashed. */
export function caseHash(fixture: Fixture): string {
  return createHash('sha256')
    .update(
      canonical({
        evidence: fixture.evidence,
        workspace: fixture.workspace ?? null,
        expect: fixture.expect,
      }),
    )
    .digest('hex');
}

/** The value at a JSON pointer (RFC 6901) in `value`; undefined where there is none. */
export function at(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;

  let current = value;

  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');

    if (current === null || typeof current !== 'object') return undefined;

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

export interface Result {
  why: string;
  passed: boolean;
  reason: string;
}

const show = (value: unknown) => JSON.stringify(value) ?? 'nothing';
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);

interface Comment {
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number | null;
  severity?: string;
  body: string;
}

/** Whether the answer shows a blocking finding, by the rule the app itself applies. */
function blocking(task: AiTask, output: unknown): boolean {
  if (task === 'full_review') return hasBlockingFindings(output as FullReviewResult);

  const comments = (at(output, '/comments') as Comment[] | undefined) ?? [];

  return comments.some((comment) => comment.severity === 'blocking');
}

/** One expectation against the answer, as its schema and anchoring left it. */
export function check(task: AiTask, output: unknown, item: Expectation): Result {
  const result = (passed: boolean, reason: string) => ({ why: item.why, passed, reason });

  if ('equals' in item) {
    const found = at(output, item.equals);

    return result(
      same(found, item.value),
      `${item.equals} is ${show(found)}, expected ${show(item.value)}`,
    );
  }

  if ('oneOf' in item) {
    const found = at(output, item.oneOf);

    return result(
      item.values.some((value) => same(found, value)),
      `${item.oneOf} is ${show(found)}, expected one of ${show(item.values)}`,
    );
  }

  if ('matches' in item) {
    const found = at(output, item.matches);
    const pattern = new RegExp(item.pattern, item.flags);
    const texts = (Array.isArray(found) ? found : [found]).filter(
      (text) => typeof text === 'string',
    );

    return result(
      texts.some((text) => pattern.test(text)),
      `${item.matches} ${texts.length ? 'does not match' : 'has no text for'} /${item.pattern}/${item.flags ?? ''}`,
    );
  }

  if ('count' in item) {
    const found = at(output, item.count);
    const length = Array.isArray(found) ? found.length : null;
    const passed =
      length !== null &&
      (item.min === undefined || length >= item.min) &&
      (item.max === undefined || length <= item.max);

    return result(
      passed,
      `${item.count} has ${length ?? 'no'} items, expected ${item.min ?? 0} to ${item.max ?? 'any'}`,
    );
  }

  if ('comment' in item) {
    const wanted = item.comment;
    const comments = (at(output, '/comments') as Comment[] | undefined) ?? [];
    const pattern = wanted.body === undefined ? null : new RegExp(wanted.body, 'i');
    const found = comments.some(
      (comment) =>
        comment.path === wanted.path &&
        comment.side === wanted.side &&
        comment.line === wanted.line &&
        (wanted.severity === undefined ||
          wanted.severity.includes(comment.severity as (typeof wanted.severity)[number])) &&
        (pattern === null || pattern.test(comment.body)),
    );

    return result(
      found,
      `no comment on ${wanted.path} ${wanted.side} ${wanted.line ?? '(no line)'}${wanted.body ? ` matching /${wanted.body}/i` : ''}`,
    );
  }

  if ('thread' in item) {
    const threads =
      (at(output, '/threads') as { threadId: string; verdict: string }[] | undefined) ?? [];
    const thread = threads.find((candidate) => candidate.threadId === item.thread.threadId);

    return result(
      thread !== undefined && item.thread.verdict.includes(thread.verdict),
      `thread ${item.thread.threadId} is ${thread ? thread.verdict : 'not judged'}, expected ${item.thread.verdict.join(' or ')}`,
    );
  }

  return result(!blocking(task, output), 'it reports a blocking finding');
}

/** Every expectation against the answer: passed only when all are. */
export function scoreCase(task: AiTask, output: unknown, expect: Expectation[]) {
  const results = expect.map((item) => check(task, output, item));

  return { passed: results.every((item) => item.passed), results };
}

/** How one case went: scored, or why it could not be (`error`: the provider or the setup failed). */
export interface CaseReport {
  id: string;
  hash: string;
  passed: boolean;
  results: Result[];
  /** The model that answered, as the provider reported it. */
  model: string | null;
  /** The answer was in another shape: a failure of the prompt. */
  shapeError?: string;
  /** Its folder could not be removed: left behind, the score stands. */
  cleanupError?: string;
  /** The provider or the setup failed: the case says nothing about the prompt. */
  error?: string;
}

export interface TaskReport {
  task: AiTask;
  promptVersion: number;
  digest: string | null;
  cases: CaseReport[];
}

/** A run of the evaluation: how it was asked to run, and each task's cases. */
export interface EvalReport {
  provider: 'codex' | 'claude';
  /** The model asked for; each case records the one that answered. */
  model: string | null;
  effort: string;
  /** Every case was scored: none failed for its provider or setup. */
  complete: boolean;
  tasks: TaskReport[];
}

/** One case's change between a baseline and a candidate. */
export interface CaseChange {
  task: AiTask;
  id: string;
  change: 'regressed' | 'fixed' | 'still passing' | 'still failing';
  /** Labels whose result changed, with the candidate's reason. */
  labels: { why: string; from: boolean; to: boolean; reason: string }[];
}

const resultSchema = z.strictObject({ why: z.string(), passed: z.boolean(), reason: z.string() });

/** A saved report, as it must be read back to be compared. */
export const reportSchema = z.strictObject({
  provider: z.enum(['codex', 'claude']),
  model: z.string().nullable(),
  effort: z.string(),
  complete: z.boolean(),
  tasks: z.array(
    z.strictObject({
      task: z.enum(Object.keys(TASKS) as [AiTask, ...AiTask[]]),
      promptVersion: z.number(),
      digest: z.string().nullable(),
      cases: z.array(
        z.strictObject({
          id: z.string(),
          hash: z.string(),
          passed: z.boolean(),
          results: z.array(resultSchema),
          model: z.string().nullable(),
          shapeError: z.string().optional(),
          cleanupError: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
  ),
});

/** What makes a report unfit to compare: no cases, a case twice, or a case with no known model. */
function reportProblems(name: string, report: EvalReport): string[] {
  const problems: string[] = [];
  const ids = report.tasks.flatMap((task) => task.cases.map((item) => `${task.task}/${item.id}`));

  if (ids.length === 0) problems.push(`The ${name} has no cases.`);

  for (const id of new Set(ids.filter((key, index) => ids.indexOf(key) !== index)))
    problems.push(`The ${name} has ${id} more than once.`);

  for (const task of report.tasks)
    for (const item of task.cases)
      if (item.model === null)
        problems.push(`The ${name}'s ${task.task}/${item.id} was answered by an unknown model.`);

  return problems;
}

/**
 * The candidate against the baseline. Refused (`refusals`) unless both are well-formed reports
 * that ran complete, with the same provider, effort and models, on the same cases, each once.
 * `regressed` when any case that passed fails now.
 */
export function compareReports(rawBaseline: unknown, rawCandidate: unknown) {
  const parsed = [reportSchema.safeParse(rawBaseline), reportSchema.safeParse(rawCandidate)];

  if (!parsed[0].success || !parsed[1].success)
    return {
      refusals: parsed.flatMap((result, index) =>
        result.success ? [] : [`The ${index === 0 ? 'baseline' : 'candidate'} is not a report.`],
      ),
      changes: [] as CaseChange[],
      regressed: false,
    };

  const baseline = parsed[0].data as EvalReport;
  const candidate = parsed[1].data as EvalReport;
  const refusals: string[] = [
    ...reportProblems('baseline', baseline),
    ...reportProblems('candidate', candidate),
  ];

  if (!baseline.complete) refusals.push('The baseline is incomplete: rerun it.');
  if (!candidate.complete) refusals.push('The candidate is incomplete: rerun it.');
  if (baseline.provider !== candidate.provider)
    refusals.push('The two ran on different providers.');
  if (baseline.effort !== candidate.effort) refusals.push('The two ran at different efforts.');
  if (baseline.model !== candidate.model) refusals.push('The two asked for different models.');

  const cases = (report: EvalReport) =>
    new Map(
      report.tasks.flatMap((task) =>
        task.cases.map((item) => [`${task.task}/${item.id}`, item] as const),
      ),
    );
  const before = cases(baseline);
  const after = cases(candidate);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();

  for (const key of keys) {
    const left = before.get(key);
    const right = after.get(key);

    if (!left || !right) refusals.push(`${key} ran in only one of the two.`);
    else if (left.hash !== right.hash) refusals.push(`${key} is not the same case in the two.`);
    else if (left.model !== right.model)
      refusals.push(
        `${key} was answered by ${left.model ?? 'an unknown model'} and ${right.model ?? 'an unknown model'}.`,
      );
  }

  if (refusals.length > 0) return { refusals, changes: [] as CaseChange[], regressed: false };

  const changes: CaseChange[] = keys.map((key) => {
    const left = before.get(key)!;
    const right = after.get(key)!;
    const [task, id] = key.split('/') as [AiTask, string];

    return {
      task,
      id,
      change: left.passed
        ? right.passed
          ? 'still passing'
          : 'regressed'
        : right.passed
          ? 'fixed'
          : 'still failing',
      labels: right.results.flatMap((result, index) => {
        const was = left.results[index];

        return was && was.passed !== result.passed
          ? [{ why: result.why, from: was.passed, to: result.passed, reason: result.reason }]
          : [];
      }),
    };
  });

  return { refusals, changes, regressed: changes.some((item) => item.change === 'regressed') };
}
