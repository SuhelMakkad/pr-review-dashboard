import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AiTask } from '@review-desk/shared/ai';
import { canonical, pinProblems, promptDigest, type PromptPins } from '@/ai/prompt-pins.js';
import { TASKS, type Evidence } from '@/ai/tasks.js';

/** A fixed PR and its evidence: prompts rendered from it change only when a builder does. */
const sample = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/ai/prompt-sample.json', import.meta.url), 'utf8'),
) as Evidence;
const pins = JSON.parse(
  readFileSync(new URL('../src/ai/prompt-pins.json', import.meta.url), 'utf8'),
) as PromptPins;
const tasks = Object.keys(TASKS) as AiTask[];

describe('prompt versions', () => {
  it('pins every task, and nothing else', () => {
    expect(Object.keys(pins).sort()).toEqual([...tasks].sort());
  });

  it.each(tasks)('pins what %s sends to its version', (task) => {
    const now = { version: TASKS[task].promptVersion, digest: promptDigest(task, sample) };

    // A change to its instructions, schema or prompt: bump `promptVersion`, then pin this.
    expect(
      now,
      `${task}'s prompt changed: bump its promptVersion and pin ${JSON.stringify(now)}`,
    ).toEqual(pins[task]);
  });

  it('renders the same digest for the same prompt, whatever the order of keys', () => {
    expect(canonical({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
  });
});

describe('pins against the branch merged into', () => {
  const base: PromptPins = {
    brief: { version: 1, digest: 'one' },
    since_review: { version: 2, digest: 'two' },
  };

  it('accepts the same pins, a new version with a new digest, and a new task', () => {
    expect(
      pinProblems(base, {
        brief: { version: 2, digest: 'three' },
        since_review: { version: 2, digest: 'two' },
        draft_summary: { version: 1, digest: 'four' },
      }),
    ).toEqual([]);
  });

  it('refuses a digest replaced under the same version', () => {
    expect(pinProblems(base, { ...base, brief: { version: 1, digest: 'changed' } })).toEqual([
      expect.stringContaining('brief: its prompt changed under version 1'),
    ]);
  });

  it('refuses a version that went back', () => {
    expect(pinProblems(base, { ...base, since_review: { version: 1, digest: 'two' } })).toEqual([
      expect.stringContaining('since_review: its prompt version went back'),
    ]);
  });
});
