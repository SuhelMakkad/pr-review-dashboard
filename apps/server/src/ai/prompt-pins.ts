import { createHash } from 'node:crypto';
import type { AiTask } from '@review-desk/shared/ai';
import { jsonSchemaFor, TASKS, type Evidence } from '@/ai/tasks.js';

/** Each task's prompt version and the digest of its prompt under it (`prompt-pins.json`). */
export type PromptPins = Partial<Record<AiTask, { version: number; digest: string }>>;

/** JSON with every object's keys sorted: the same text for the same value. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
}

/**
 * What a task's provider receives, as a digest: its instructions, its wire schema, and the prompt
 * its builder renders for `sample`. A change to any of them is a change to the prompt.
 */
export function promptDigest(task: AiTask, sample: Evidence): string {
  const definition = TASKS[task];

  return createHash('sha256')
    .update(
      canonical({
        instructions: definition.instructions,
        schema: jsonSchemaFor(task),
        prompt: definition.input(sample),
      }),
    )
    .digest('hex');
}

/**
 * What is wrong with `head`'s pins against `base`'s (the branch it merges into): a digest that
 * changed under the same version, or a version that went back. A task new to `head` is fine.
 */
export function pinProblems(base: PromptPins, head: PromptPins): string[] {
  const problems: string[] = [];

  for (const [task, pin] of Object.entries(head) as [
    AiTask,
    { version: number; digest: string },
  ][]) {
    const was = base[task];

    if (!was) continue;

    if (pin.version < was.version)
      problems.push(`${task}: its prompt version went back from ${was.version} to ${pin.version}.`);
    else if (pin.version === was.version && pin.digest !== was.digest)
      problems.push(
        `${task}: its prompt changed under version ${pin.version}. Bump its promptVersion, and pin the new digest under it.`,
      );
  }

  return problems;
}
