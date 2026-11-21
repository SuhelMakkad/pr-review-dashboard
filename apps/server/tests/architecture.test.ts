import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The server's boundaries, read from its sources: which modules may import what, and where its
 * user-facing words come from. Each rule holds today; a change that breaks one says so here.
 */

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** Every TypeScript source under `directory` (from the repository root), with its text. */
function sources(directory: string) {
  const base = join(root, directory);

  return readdirSync(base, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts'))
    .map((file) => ({
      path: relative(base, join(base, file)).split(sep).join('/'),
      text: readFileSync(join(base, file), 'utf8'),
    }));
}

/** The module specifiers a source imports or re-exports. */
const imports = (text: string) =>
  [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map((match) => match[1]);

const server = sources('apps/server/src');

describe('server boundaries', () => {
  it('keeps the database driver and its query builder in db/', () => {
    const leaks = server
      .filter((file) => !file.path.startsWith('db/'))
      .filter((file) =>
        imports(file.text).some((from) => /^(drizzle-orm|better-sqlite3)(\/|$)/.test(from)),
      )
      .map((file) => file.path);

    expect(leaks).toEqual([]);
  });

  it('keeps the GitHub and GitLab adapters apart: what they share lives in forge/', () => {
    const crossing = server
      .filter(
        (file) =>
          (file.path.startsWith('github/') &&
            imports(file.text).some((from) => from.startsWith('@/gitlab/'))) ||
          (file.path.startsWith('gitlab/') &&
            imports(file.text).some((from) => from.startsWith('@/github/'))),
      )
      .map((file) => file.path);

    expect(crossing).toEqual([]);
  });

  it('builds every refusal through failed(), which checks its status', () => {
    const literals = server
      .filter((file) => file.path !== 'http/serve.ts' && /\bfailed:\s*true\b/.test(file.text))
      .map((file) => file.path);

    expect(literals).toEqual([]);
  });

  /**
   * Where a forge is named in text outside the catalog, and why. Everywhere else, words that name
   * the forge or its terms come from `messages.ts`, worded for the account they are shown to.
   */
  const namesForge: Record<string, string> = {
    'ai/context.ts': "the agent's prompt, never shown to users",
    'ai/fixture.ts': "the demo's AI answers",
    'ai/post-findings.ts': 'skip reasons stored on AI runs, to be worded per account (follow-up)',
    'ai/workspace.ts': 'AI workspace errors stored on runs, to be worded per account (follow-up)',
    'db/settings.ts': "GitLab's own state, named for what it is",
    'diff/service.ts': "names the forge from the PR's own address",
    'forge/account.ts': "GitLab's sign-in check, which only GitLab has",
    'operations/queue.ts': "recoveries of GitLab's split approvals",
    'sync/queue.ts': 'adding a link of the other forge names both',
  };
  const forgeWords =
    /(['"`])((?:(?!\1).)*?\b(?:GitHub|GitLab|pull requests?|merge requests?|PRs?|MRs?)\b(?:(?!\1).)*)\1/g;

  it('takes words that name the forge from the message catalog', () => {
    const own = (path: string) =>
      /^(github|gitlab|demo|bench)\//.test(path) || path === 'messages.ts';
    const named = server
      .filter((file) => !own(file.path))
      .filter((file) =>
        file.text.split('\n').some((line) => {
          const code = line.trim();

          if (/^(\/\/|\*|\/\*|import\b|export\b.*\bfrom\b)/.test(code)) return false;

          // Identifiers, paths and ids are not words shown to anyone.
          return [...line.matchAll(forgeWords)].some((match) => !/^[\w./@-]+$/.test(match[2]));
        }),
      )
      .map((file) => file.path);

    expect(named.filter((path) => !(path in namesForge))).toEqual([]);
    // An entry no longer needed goes, so the list only ever names real exceptions.
    expect(Object.keys(namesForge).filter((path) => !named.includes(path))).toEqual([]);
  });
});

describe('package boundaries', () => {
  it('keeps the shared package free of the apps', () => {
    const leaks = sources('packages/shared/src')
      .filter((file) =>
        imports(file.text).some((from) => /apps\/|@review-desk\/(server|web)/.test(from)),
      )
      .map((file) => file.path);

    expect(leaks).toEqual([]);
  });

  it("keeps the web app off the server's modules: it reaches the server over HTTP only", () => {
    const leaks = sources('apps/web/src')
      .filter((file) =>
        imports(file.text).some((from) => /apps\/server|@review-desk\/server/.test(from)),
      )
      .map((file) => file.path);

    expect(leaks).toEqual([]);
  });
});
