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
 * What a task's provider receives, as a digest: its instructions, its wire schema, and the prompts
 * its builder renders for `samples` (one for each kind of diff it can be given). A change to any
 * of them is a change to the prompt.
 *
 * Not covered: what a full review reads from its workspace beyond the prompt (`review.json`, built
 * by `ai/workspace.ts`). A change there needs its version bumped by hand.
 */
export function promptDigest(task: AiTask, samples: Evidence[]): string {
  const definition = TASKS[task];

  return createHash('sha256')
    .update(
      canonical({
        instructions: definition.instructions,
        schema: jsonSchemaFor(task),
        prompts: samples.map((sample) => definition.input(sample)),
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

/** Where the pins are kept, from the repository root. */
export const PINS_PATH = 'apps/server/src/ai/prompt-pins.json';

/** How the base's pins are read: through git, or by a test. */
export interface BaseReader {
  /** The commit `revision` names, or null when it names none. */
  resolve(revision: string): string | null;
  /** The file at `path` in `commit`, or null when that commit holds none; throws when unsure. */
  read(commit: string, path: string): string | null;
}

/** Runs git with `args`, returning what it printed; throws when it fails. */
export type Git = (args: string[]) => string;

/** The base read through git: absent only when the commit's tree has no such entry. */
export function gitReader(git: Git): BaseReader {
  return {
    resolve: (revision) => {
      try {
        return git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).trim() || null;
      } catch {
        return null;
      }
    },
    read: (commit, path) => {
      // A listing that fails is not an absence: it throws, and the check cannot pass.
      if (!git(['ls-tree', commit, '--', path]).trim()) return null;

      return git(['show', `${commit}:${path}`]);
    },
  };
}

/**
 * `head`'s pins against the branch merged into (`revision`): 0 when they agree, or when that
 * branch has no pins yet; 1 for a problem; 2 when the base cannot be read. Never passes on a base
 * it could not read.
 */
export function checkPins(
  revision: string,
  head: PromptPins,
  git: BaseReader,
): { code: 0 | 1 | 2; messages: string[] } {
  const commit = git.resolve(revision);

  if (!commit) return { code: 2, messages: [`${revision} names no commit to compare with.`] };

  let text: string | null;

  try {
    text = git.read(commit, PINS_PATH);
  } catch {
    return { code: 2, messages: [`The prompt pins at ${revision} cannot be read.`] };
  }

  if (text === null)
    return { code: 0, messages: [`No prompt pins at ${revision} yet: nothing to compare.`] };

  let base: unknown;

  try {
    base = JSON.parse(text);
  } catch {
    base = null;
  }

  if (!base || typeof base !== 'object' || Array.isArray(base))
    return { code: 2, messages: [`The prompt pins at ${revision} cannot be read.`] };

  const problems = pinProblems(base as PromptPins, head);

  return { code: problems.length > 0 ? 1 : 0, messages: problems };
}
