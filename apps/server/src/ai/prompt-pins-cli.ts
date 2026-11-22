import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkPins, PINS_PATH, type PromptPins } from '@/ai/prompt-pins.js';

/**
 * `pnpm prompt:pins <base-revision>`: fails when a pinned prompt digest changed without its
 * version, against the branch a change merges into (CI passes the merge commit's first parent).
 * Exits 2 when that base cannot be read, so the check never passes unseen.
 */
const revision = process.argv[2] ?? 'origin/main';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const head = JSON.parse(readFileSync(`${root}${PINS_PATH}`, 'utf8')) as PromptPins;
const { code, messages } = checkPins(revision, head, {
  resolve: (name) => {
    try {
      return git('rev-parse', '--verify', '--quiet', `${name}^{commit}`).trim() || null;
    } catch {
      return null;
    }
  },
  read: (commit, path) => {
    try {
      git('cat-file', '-e', `${commit}:${path}`);
    } catch {
      // The commit resolved: it holds no such file.
      return null;
    }

    return git('show', `${commit}:${path}`);
  },
});

for (const message of messages) (code === 0 ? console.log : console.error)(message);

process.exit(code);
