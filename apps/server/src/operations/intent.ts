import { createHash } from 'node:crypto';
import type { MutationStep } from '@/operations/types.js';

/**
 * Step intent, version 1: every write an action will make, in order, declared by the path that
 * makes them right before the first is sent. Each later call is checked against it, and an action
 * succeeds only once every declared write has its receipt. Rows from before intents were declared
 * keep the positional replay alone (see `isLegacy`).
 */
export interface Intent {
  version: 1;
  steps: StepIntent[];
}

/** One declared write: its method and its arguments. */
export interface StepIntent {
  method: string;
  args: IntentArg[];
}

/**
 * A declared argument: a literal, or an earlier step's result, whole (a pending review's id) or
 * one field of it.
 */
export type IntentArg =
  | { value: unknown }
  | { step: number; result: 'value' }
  | { step: number; result: 'field'; field: string };

/**
 * A literal argument. An `undefined` one is stored as `null`, as JSON writes it in an argument
 * list: it keeps its `value` key once saved, and still matches the call it stands for.
 */
export const literal = (value: unknown): IntentArg => ({ value: value ?? null });

/** Step `step`'s whole result, such as the id `addPendingReview` returned. */
export const resultOf = (step: number): IntentArg => ({ step, result: 'value' });

export const intended = (method: string, ...args: IntentArg[]): StepIntent => ({
  method,
  args,
});

export const fingerprint = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** A step kept only for its index: what a missing or damaged stored entry reads as. */
export const placeholderStep = (): MutationStep => ({
  method: '',
  args: [],
  startedAt: '',
  completedAt: null,
  result: null,
  uncertain: false,
});

/** True for a placeholder: nothing was sent for it, and it never matches a declared write. */
export const isPlaceholder = (step: MutationStep) => step.method === '';

/** True for a stored step of the shape every reader expects. */
function isStep(value: unknown): value is MutationStep {
  if (typeof value !== 'object' || value === null) return false;

  const step = value as Record<string, unknown>;

  return (
    typeof step.method === 'string' &&
    step.method !== '' &&
    Array.isArray(step.args) &&
    typeof step.startedAt === 'string' &&
    (step.completedAt === null || typeof step.completedAt === 'string') &&
    typeof step.uncertain === 'boolean' &&
    (step.acknowledged === undefined || typeof step.acknowledged === 'boolean')
  );
}

/**
 * A row's stored steps, each a step: a missing or malformed entry (no method, arguments that are
 * not a list, ...) becomes a placeholder that keeps its index, so every reader sees a valid shape.
 * A step's result may be anything. A history that is not a list at all is damaged, not empty: it
 * reads as one placeholder, so nothing is taken to be unsent.
 */
export function storedSteps(steps: unknown): MutationStep[] {
  if (!Array.isArray(steps)) return [placeholderStep()];

  return Array.from(steps, (step: unknown) =>
    isStep(step) ? { ...step, result: step.result ?? null } : placeholderStep(),
  );
}

/**
 * A row from before intents were declared: it entered execution with steps and no intent. Its
 * steps are replayed by position, as they always were; it never takes an intent.
 */
export const isLegacy = (row: { intent?: Intent; steps: MutationStep[] }) =>
  row.intent === undefined && row.steps.length > 0;

/**
 * The arguments the write declared at `index` resolves to, from the stored results of the steps
 * before it; null where one refers to a step that is not earlier, not finished, or without a
 * result. A step never vouches for itself.
 */
export function resolvedArgs(
  planned: StepIntent,
  steps: MutationStep[],
  index: number,
): unknown[] | null {
  const args: unknown[] = [];

  for (const arg of planned.args) {
    if ('value' in arg) {
      args.push(arg.value);
      continue;
    }

    const source = arg.step < index ? steps[arg.step] : undefined;

    if (!source?.completedAt || isPlaceholder(source)) return null;

    const result = source.result as unknown;

    if (arg.result === 'value') {
      if (result === null || result === undefined) return null;

      args.push(result);
    } else {
      // The result's own field, never one it inherits (`toString`).
      if (typeof result !== 'object' || result === null || !Object.hasOwn(result, arg.field))
        return null;

      const field = (result as Record<string, unknown>)[arg.field];

      if (field === null || field === undefined) return null;

      args.push(field);
    }
  }

  return args;
}

/** True when a call of `method` with `args` at `index` is the write the intent declares there. */
export function matches(
  intent: Intent,
  index: number,
  method: string,
  args: unknown[],
  steps: MutationStep[],
): boolean {
  const planned = intent.steps[index];

  if (!planned || planned.method !== method) return false;

  const expected = resolvedArgs(planned, steps, index);

  return expected !== null && fingerprint(expected) === fingerprint(args);
}

const isArg = (arg: unknown, index: number): arg is IntentArg => {
  if (typeof arg !== 'object' || arg === null) return false;
  if ('value' in arg) return true;

  const reference = arg as { step?: unknown; result?: unknown; field?: unknown };

  return (
    Number.isInteger(reference.step) &&
    (reference.step as number) >= 0 &&
    (reference.step as number) < index &&
    (reference.result === 'value' ||
      (reference.result === 'field' && typeof reference.field === 'string'))
  );
};

/**
 * Why a stored intent cannot be one this version runs: null when it is version 1, a list of
 * writes each with a method and arguments, every reference to an earlier write.
 */
export function intentShapeProblem(intent: unknown): string | null {
  if (typeof intent !== 'object' || intent === null) return 'the intent is damaged';

  const { version, steps } = intent as { version?: unknown; steps?: unknown };

  // Named only when it is a version at all: a damaged one is never turned into text.
  if (version !== 1)
    return typeof version === 'number' && Number.isInteger(version)
      ? `the intent is version ${version}, which this version cannot run`
      : 'the intent has no version this version can run';
  if (!Array.isArray(steps)) return 'the intent is damaged';

  for (const [index, step] of steps.entries()) {
    const write = step as { method?: unknown; args?: unknown } | null;

    if (
      typeof write !== 'object' ||
      write === null ||
      typeof write.method !== 'string' ||
      write.method === '' ||
      !Array.isArray(write.args) ||
      !write.args.every((arg) => isArg(arg, index))
    )
      return `declared write ${index + 1} is damaged`;
  }

  return null;
}

/**
 * Why a row's steps cannot be its intent's: null when they are a valid prefix of it. Valid steps
 * match the intent index by index, completed ones first, then at most one unfinished step (refused,
 * or uncertain) as the last.
 */
export function intentProblem(intent: Intent, steps: MutationStep[]): string | null {
  const shape = intentShapeProblem(intent);

  if (shape) return shape;
  if (steps.length > intent.steps.length) return 'more steps than the intent declares';

  for (const [index, step] of steps.entries()) {
    if (isPlaceholder(step)) return `step ${index + 1} is missing`;
    if (!matches(intent, index, step.method, step.args, steps))
      return `step ${index + 1} is not the write declared for it`;
    if (!step.completedAt && index < steps.length - 1)
      return `step ${index + 1} is unfinished, but a later one was sent`;
  }

  return null;
}

/** True when every declared write has its receipt. */
export const fullyReceipted = (intent: Intent, steps: MutationStep[]) =>
  steps.length === intent.steps.length &&
  intentProblem(intent, steps) === null &&
  steps.every((step) => step.completedAt);
