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
 * A step's result may be anything.
 */
export function storedSteps(steps: unknown): MutationStep[] {
  if (!Array.isArray(steps)) return [];

  return Array.from(steps, (step: unknown) =>
    isStep(step) ? { ...step, result: step.result ?? null } : placeholderStep(),
  );
}

/**
 * A row from before intents were declared: it entered execution with steps and no intent. Its
 * steps are replayed by position, as they always were; it never takes an intent.
 */
export const isLegacy = (row: { intent?: Intent; steps: MutationStep[] }) =>
  !row.intent && row.steps.length > 0;

/**
 * The arguments `planned` resolves to, from the stored results of earlier steps; null where one
 * refers to a step without a result.
 */
export function resolvedArgs(planned: StepIntent, steps: MutationStep[]): unknown[] | null {
  const args: unknown[] = [];

  for (const arg of planned.args) {
    if ('value' in arg) {
      args.push(arg.value);
      continue;
    }

    const source = steps[arg.step];

    if (!source?.completedAt || isPlaceholder(source)) return null;

    if (arg.result === 'value') args.push(source.result);
    else {
      const result = source.result as Record<string, unknown> | null;

      if (typeof result !== 'object' || result === null || !(arg.field in result)) return null;

      args.push(result[arg.field]);
    }
  }

  return args;
}

/** True when a call of `method` with `args` is the write `planned` declares, given `steps`. */
export function matches(
  planned: StepIntent | undefined,
  method: string,
  args: unknown[],
  steps: MutationStep[],
): boolean {
  if (!planned || planned.method !== method) return false;

  const expected = resolvedArgs(planned, steps);

  return expected !== null && fingerprint(expected) === fingerprint(args);
}

/**
 * Why a row's steps cannot be its intent's: null when they are a valid prefix of it. Valid steps
 * match the intent index by index, completed ones first, then at most one unfinished step (refused,
 * or uncertain) as the last.
 */
export function intentProblem(intent: Intent, steps: MutationStep[]): string | null {
  if (steps.length > intent.steps.length) return 'more steps than the intent declares';

  for (const [index, step] of steps.entries()) {
    if (isPlaceholder(step)) return `step ${index + 1} is missing`;
    if (!matches(intent.steps[index], step.method, step.args, steps))
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
