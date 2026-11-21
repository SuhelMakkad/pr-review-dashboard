import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The server's boundaries, read from its sources with the TypeScript parser: which modules may
 * import what, and where its user-facing words come from. Each rule holds today; a change that
 * breaks one says so here.
 */

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** Where each package's `@/` alias points. */
const aliases: Record<string, string> = {
  'apps/server/src': 'apps/server/src',
  'apps/web/src': 'apps/web/src',
  'packages/shared/src': 'packages/shared/src',
};

interface Source {
  /** From the package's source root, e.g. `gitlab/read.ts`. */
  path: string;
  /** From the repository root. */
  file: string;
  tree: ts.SourceFile;
}

/** Every TypeScript source under `directory` (from the repository root), declarations included. */
function sources(directory: string): Source[] {
  const base = join(root, directory);

  return readdirSync(base, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
    .map((file) => {
      const absolute = join(base, file);

      return {
        path: relative(base, absolute).split(sep).join('/'),
        file: relative(root, absolute).split(sep).join('/'),
        tree: ts.createSourceFile(
          absolute,
          readFileSync(absolute, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        ),
      };
    });
}

/** Every node of a tree, depth first. */
function nodes(tree: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    all.push(node);
    ts.forEachChild(node, visit);
  };

  visit(tree);

  return all;
}

/**
 * The module specifiers a source depends on, in every form: static and side-effect imports,
 * re-exports, `import()` calls and types, `import x = require()` and `require()`.
 */
function specifiers(source: Source): string[] {
  const found: string[] = [];
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };

  for (const node of nodes(source.tree)) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0]);
  }

  return found;
}

/**
 * Where a specifier leads: a repository path for a relative or `@/` one (`apps/server/src/...`),
 * else the package name as written.
 */
function target(source: Source, specifier: string, packageRoot: string): string {
  if (specifier.startsWith('.'))
    return relative(root, resolve(root, dirname(source.file), specifier))
      .split(sep)
      .join('/');
  if (specifier.startsWith('@/')) return `${aliases[packageRoot]}/${specifier.slice(2)}`;

  return specifier;
}

/** The repository paths and package names `source` depends on. */
const targets = (source: Source, packageRoot: string) =>
  specifiers(source).map((specifier) => target(source, specifier, packageRoot));

const server = sources('apps/server/src');
const inServer = (directory: string) => (to: string) =>
  to.startsWith(`apps/server/src/${directory}/`);

describe('server boundaries', () => {
  /** Modules that may open SQLite themselves, apart from `db/`, and why. */
  const ownSqlite: Record<string, string> = {
    'ai/provider.ts': 'its own lock database for agent processes, apart from the store',
    'ai/agent-supervisor.ts': "the agent supervisor's side of that lock database",
  };

  it('keeps the database driver and its query builder in db/', () => {
    const leaks = server
      .filter((file) => !file.path.startsWith('db/'))
      .flatMap((file) =>
        targets(file, 'apps/server/src')
          .filter((to) => /^(drizzle-orm|better-sqlite3)(\/|$)/.test(to) || to === 'node:sqlite')
          .filter((to) => !(to === 'node:sqlite' && file.path in ownSqlite))
          .map((to) => `${file.path} → ${to}`),
      );

    expect(leaks).toEqual([]);
    expect(
      Object.keys(ownSqlite).filter(
        (path) =>
          !targets(
            server.find((file) => file.path === path)!,
            'apps/server/src',
          ).includes('node:sqlite'),
      ),
    ).toEqual([]);
  });

  it('keeps the GitHub and GitLab adapters apart: what they share lives in forge/', () => {
    const crossing = server.flatMap((file) => {
      const other = file.path.startsWith('github/')
        ? 'gitlab'
        : file.path.startsWith('gitlab/')
          ? 'github'
          : null;

      return other
        ? targets(file, 'apps/server/src')
            .filter(inServer(other))
            .map((to) => `${file.path} → ${to}`)
        : [];
    });

    expect(crossing).toEqual([]);
  });

  it('builds every refusal through failed(), which checks its status', () => {
    const literals = server
      .filter((file) => file.path !== 'http/serve.ts')
      .flatMap((file) =>
        nodes(file.tree)
          .filter(
            (node): node is ts.PropertyAssignment =>
              ts.isPropertyAssignment(node) &&
              (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
              node.name.text === 'failed' &&
              node.initializer.kind === ts.SyntaxKind.TrueKeyword,
          )
          .map(() => file.path),
      );

    expect(literals).toEqual([]);
  });

  /**
   * Text outside the catalog that names a forge or its terms, each allowed by its wording, with
   * why. Everywhere else, such words come from `messages.ts`, worded for the account they are shown
   * to. An allowance that matches nothing any more fails too.
   */
  const allowed: { path: string; wording: RegExp; reason: string }[] = [
    {
      path: 'ai/context.ts',
      wording: /Review the complete PR using review\.json/,
      reason: "the agent's prompt, never shown to users",
    },
    {
      path: 'ai/tasks.ts',
      wording: /pull request|\bPRs?\b|as you would on GitHub/,
      reason: "the agent's task prompts, never shown to users",
    },
    {
      path: 'ai/fixture.ts',
      wording: /^Largest change in this PR\.$/,
      reason: "the demo's AI answers",
    },
    {
      path: 'ai/post-findings.ts',
      wording: /\bPRs?\b/,
      reason: 'skip reasons stored on AI runs, to be worded per account (follow-up)',
    },
    {
      path: 'ai/workspace.ts',
      wording: /\bPR\b/,
      reason: 'AI workspace errors stored on runs, to be worded per account (follow-up)',
    },
    {
      path: 'db/settings.ts',
      wording: /^Only GitLab state/,
      reason: "GitLab's own state, named for what it is",
    },
    {
      path: 'diff/service.ts',
      wording: /^(GitHub|GitLab)$/,
      reason: "the forge named from the PR's own address",
    },
    {
      path: 'forge/account.ts',
      wording: /GitLab CLI is signed in as|which GitLab account/,
      reason: "GitLab's sign-in check, which only GitLab has",
    },
    {
      path: 'operations/queue.ts',
      wording: /Check GitLab: the approval|reached GitLab/,
      reason: "recoveries of GitLab's split approvals",
    },
    {
      path: 'sync/queue.ts',
      wording: /^PR$|looks like a GitLab merge request|another GitLab on/,
      reason: 'adding a PR from another forge, host or instance names both',
    },
  ];
  const forgeWords = /\b(GitHub|GitLab|pull requests?|merge requests?|PRs?|MRs?)\b/;

  /** Every string literal and template's text in `source`, outside imports and literal types. */
  const texts = (source: Source) =>
    nodes(source.tree)
      .filter(
        (node) =>
          node.parent !== undefined &&
          !ts.isImportDeclaration(node.parent) &&
          !ts.isExportDeclaration(node.parent) &&
          !ts.isLiteralTypeNode(node.parent) &&
          !ts.isExternalModuleReference(node.parent),
      )
      .flatMap((node) =>
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          ? [node.text]
          : ts.isTemplateExpression(node)
            ? [[node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('…')]
            : [],
      );

  it('takes words that name the forge from the message catalog', () => {
    const own = (path: string) =>
      /^(github|gitlab|demo|bench)\//.test(path) || path === 'messages.ts';
    const named = server
      .filter((file) => !own(file.path))
      .flatMap((file) =>
        texts(file)
          .filter((text) => forgeWords.test(text))
          .map((text) => ({ path: file.path, text })),
      );

    const unexplained = named
      .filter(
        (found) =>
          !allowed.some(
            (allowance) => allowance.path === found.path && allowance.wording.test(found.text),
          ),
      )
      .map((found) => `${found.path}: ${found.text.slice(0, 80)}`);
    const unused = allowed
      .filter(
        (allowance) =>
          !named.some(
            (found) => found.path === allowance.path && allowance.wording.test(found.text),
          ),
      )
      .map((allowance) => `${allowance.path}: ${allowance.wording}`);

    expect(unexplained).toEqual([]);
    expect(unused).toEqual([]);
  });
});

describe('package boundaries', () => {
  it('keeps the shared package free of the apps', () => {
    const leaks = sources('packages/shared/src').flatMap((file) =>
      targets(file, 'packages/shared/src')
        .filter((to) => to.startsWith('apps/') || /^@review-desk\/(server|web)(\/|$)/.test(to))
        .map((to) => `${file.path} → ${to}`),
    );

    expect(leaks).toEqual([]);
  });

  it("keeps the web app off the server's modules: it reaches the server over HTTP only", () => {
    const leaks = sources('apps/web/src').flatMap((file) =>
      targets(file, 'apps/web/src')
        .filter((to) => to.startsWith('apps/server/') || /^@review-desk\/server(\/|$)/.test(to))
        .map((to) => `${file.path} → ${to}`),
    );

    expect(leaks).toEqual([]);
  });
});
