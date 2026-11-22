import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AiTask } from '@review-desk/shared/ai';
import {
  canonical,
  checkPins,
  gitReader,
  PINS_PATH,
  pinProblems,
  promptDigest,
  type BaseReader,
  type PromptPins,
} from '@/ai/prompt-pins.js';
import { TASKS, type Evidence } from '@/ai/tasks.js';
import { promptSamples, samplesFor } from './prompt-samples.js';

/** A fixed PR's evidence, its diffs built by the real diff service. */
let samples: Record<'full' | 'since-review', Evidence[]>;

beforeAll(async () => {
  samples = await promptSamples();
});
const pins = JSON.parse(
  readFileSync(new URL('../src/ai/prompt-pins.json', import.meta.url), 'utf8'),
) as PromptPins;
const tasks = Object.keys(TASKS) as AiTask[];

describe('prompt versions', () => {
  it('pins every task, and nothing else', () => {
    expect(Object.keys(pins).sort()).toEqual([...tasks].sort());
  });

  it.each(tasks)('pins what %s sends to its version', (task) => {
    const now = {
      version: TASKS[task].promptVersion,
      digest: promptDigest(task, samplesFor(samples, TASKS[task].evidence.diff)),
    };

    // A change to its instructions, schema or prompt: bump `promptVersion`, then pin this.
    expect(
      now,
      `${task}'s prompt changed: bump its promptVersion and pin ${JSON.stringify(now)}`,
    ).toEqual(pins[task]);
  });

  it('samples every kind of diff a since-review prompt can be given', () => {
    expect(samples['since-review'].map((sample) => sample.diff.kind)).toEqual([
      'identical',
      'fast-forward',
      'rebased',
      'unavailable',
    ]);
    // The service's own words about each are part of the prompt.
    expect(samples['since-review'].map((sample) => Boolean(sample.diff.note))).toEqual([
      false,
      true,
      true,
      true,
    ]);
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

describe('the check against the branch merged into', () => {
  const head: PromptPins = { brief: { version: 1, digest: 'one' } };
  const reader = (files: Record<string, string | null>, commits = ['base']): BaseReader => ({
    resolve: (revision) => (commits.includes(revision) ? revision : null),
    read: (commit, path) => (path === PINS_PATH ? (files[commit] ?? null) : null),
  });

  it('fails when the revision names no commit, never passing unseen', () => {
    expect(checkPins('gone', head, reader({}))).toMatchObject({ code: 2 });
  });

  it('passes when that branch has no pins yet', () => {
    expect(checkPins('base', head, reader({ base: null }))).toMatchObject({ code: 0 });
  });

  it('fails when its pins could not be looked up, never taking that for none', () => {
    const failing: BaseReader = {
      resolve: () => 'base',
      read: () => {
        throw new Error('fatal: unable to read tree');
      },
    };

    expect(checkPins('base', head, failing)).toMatchObject({ code: 2 });
  });

  it('fails when its pins cannot be read', () => {
    expect(checkPins('base', head, reader({ base: '{ not json' }))).toMatchObject({ code: 2 });
    expect(checkPins('base', head, reader({ base: '[]' }))).toMatchObject({ code: 2 });
  });

  it('fails on a problem, and passes when they agree', () => {
    expect(
      checkPins(
        'base',
        head,
        reader({ base: JSON.stringify({ brief: { version: 1, digest: 'two' } }) }),
      ),
    ).toMatchObject({ code: 1, messages: [expect.stringContaining('brief')] });
    expect(checkPins('base', head, reader({ base: JSON.stringify(head) }))).toMatchObject({
      code: 0,
      messages: [],
    });
  });

  it('exits 2 from the command line for a revision that names no commit', () => {
    const run = spawnSync(
      'pnpm',
      ['--filter', '@review-desk/server', 'prompt:pins', 'no-such-revision'],
      { encoding: 'utf8' },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toContain('no-such-revision names no commit');
  });
});

describe('the base read through git', () => {
  const pins = JSON.stringify({ brief: { version: 1, digest: 'one' } });

  /** A repository whose first commit has no pins, and whose second has them. */
  function repository() {
    const root = mkdtempSync(join(tmpdir(), 'review-desk-pins-'));
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const commit = (message: string) => {
      git(['add', '-A']);
      git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message]);

      return git(['rev-parse', 'HEAD']).trim();
    };

    git(['init', '-q']);
    writeFileSync(join(root, 'README.md'), 'sample\n');

    const without = commit('no pins');

    mkdirSync(dirname(join(root, PINS_PATH)), { recursive: true });
    writeFileSync(join(root, PINS_PATH), pins);

    const pinned = commit('pins');

    return {
      root,
      git,
      without,
      pinned,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it('reads pins as absent only from a commit whose tree has none', () => {
    const { git, without, pinned, cleanup } = repository();

    try {
      const reader = gitReader(git);

      expect(reader.resolve(without)).toBe(without);
      expect(reader.resolve('no-such-revision')).toBeNull();
      expect(reader.read(without, PINS_PATH)).toBeNull();
      expect(reader.read(pinned, PINS_PATH)).toBe(pins);
      expect(checkPins(without, JSON.parse(pins) as PromptPins, reader)).toMatchObject({ code: 0 });
    } finally {
      cleanup();
    }
  });

  it('fails the check when the tree cannot be listed', () => {
    const { git, pinned, cleanup } = repository();

    try {
      const reader = gitReader((args) => {
        if (args[0] === 'ls-tree') throw new Error('fatal: unable to read tree');

        return git(args);
      });

      expect(() => reader.read(pinned, PINS_PATH)).toThrow();
      expect(checkPins(pinned, JSON.parse(pins) as PromptPins, reader)).toMatchObject({ code: 2 });
    } finally {
      cleanup();
    }
  });
});
