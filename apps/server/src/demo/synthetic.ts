import { createHash } from 'node:crypto';
import { FixtureRepos } from '@/demo/repo.js';
import type { Scenario, ScenarioPull } from '@/demo/scenario.js';
import type { ReviewThread } from '@review-desk/shared/types';

/** The shape of a synthetic workload for measuring the server (see `pnpm bench`). */
export interface SyntheticOptions {
  pulls: number;
  repositories: number;
  /** Changed files in the one large PR, which also carries `largeThreads` review threads. */
  largeFiles: number;
  largeThreads: number;
  /** Changed files in the PR rebased since your review, each `rebasedLines` long. */
  rebasedFiles: number;
  rebasedLines: number;
  anchor?: number;
}

export const LARGE_PR = 'PR_synthetic_large_1';
export const REBASED_PR = 'PR_synthetic_rebased_2';
const VIEWER = 'you';

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

/** A file of `lines` plausible lines; `edit` changes every seventh one, as a real change would. */
function source(path: string, lines: number, edit = ''): string {
  return Array.from({ length: lines }, (_, line) =>
    edit && line % 7 === 3
      ? `  const value${line} = compute('${path}', ${line}, '${edit}');`
      : `  const value${line} = compute('${path}', ${line});`,
  ).join('\n');
}

/**
 * A workload far larger than the demo's: `pulls` open PRs across `repositories`, all asking for
 * your review, one of them very large and one rebased since you reviewed it. Everything lives in
 * memory behind the fixture forge, as the demo does.
 */
export function syntheticScenario(options: SyntheticOptions): Scenario {
  const anchor = options.anchor ?? Date.parse('2026-11-05T10:00:00Z');
  const at = (minutesAgo: number) => new Date(anchor - minutesAgo * 60_000).toISOString();
  const repos = new FixtureRepos();
  const pulls: ScenarioPull[] = [];
  const names = Array.from(
    { length: options.repositories },
    (_, index) => `synthetic/repo-${index}`,
  );

  for (const repository of names) {
    const files: Record<string, string> = {};

    for (let index = 0; index < 20; index++)
      files[`src/module-${index}.ts`] = source(`${repository}/${index}`, 40);

    repos.commit(repository, sha(`${repository}:base`), [], files, at(60 * 48));
    repos.ref(repository, 'main', sha(`${repository}:base`));
  }

  const pull = (
    id: string,
    number: number,
    repository: string,
    head: string,
    changes: Partial<ScenarioPull['snapshot']> = {},
  ): ScenarioPull => ({
    feeds: ['requested'],
    snapshot: {
      id,
      number,
      title: `Synthetic change ${number}`,
      url: `https://github.com/${repository}/pull/${number}`,
      body: '',
      repository,
      author: { login: `author-${number % 17}` },
      isDraft: false,
      state: 'OPEN',
      createdAt: at(60 * 24),
      updatedAt: at(30 + (number % 600)),
      headOid: head,
      headCommittedAt: at(45),
      baseRefName: 'main',
      headRefName: `feat/${number}`,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
      reviewRequests: [{ kind: 'user', login: VIEWER, name: VIEWER }],
      requestEvents: [],
      reviews: [],
      threads: [],
      files: [],
      checks: [{ name: 'build', state: 'success', url: null }],
      ci: 'success',
      baseOid: sha(`${repository}:base`),
      mergeStateStatus: 'BLOCKED',
      conversation: [],
      forcePushes: [],
      verdicts: [],
      pendingReview: null,
      ...changes,
    },
  });

  // The many: each changes three files of its repository.
  for (let number = 10; number < 10 + options.pulls - 2; number++) {
    const repository = names[number % names.length];
    const head = sha(`${repository}:${number}`);
    const changes: Record<string, string> = {};

    for (let file = 0; file < 3; file++)
      changes[`src/module-${(number + file) % 20}.ts`] = source(`${repository}/${number}`, 40, 'x');

    repos.derive(repository, head, sha(`${repository}:base`), changes, at(45));
    pulls.push(pull(`PR_synthetic_${number}`, number, repository, head));
  }

  // The large one: every file changed, and a long review discussion.
  const large = 'synthetic/large';
  const largeBase: Record<string, string> = {};
  const largeHead: Record<string, string | null> = {};

  for (let index = 0; index < options.largeFiles; index++) {
    largeBase[`src/generated/part-${index}.ts`] = source(`part-${index}`, 12);
    largeHead[`src/generated/part-${index}.ts`] = source(`part-${index}`, 14, 'large');
  }

  repos.commit(large, sha(`${large}:base`), [], largeBase, at(60 * 48));
  repos.ref(large, 'main', sha(`${large}:base`));
  repos.derive(large, sha(`${large}:head`), sha(`${large}:base`), largeHead, at(50));

  const threads: ReviewThread[] = Array.from({ length: options.largeThreads }, (_, index) => ({
    id: `thread-large-${index}`,
    isResolved: index % 3 === 0,
    isOutdated: false,
    path: `src/generated/part-${index % options.largeFiles}.ts`,
    line: 3,
    comments: [0, 1].map((reply) => ({
      id: `comment-large-${index}-${reply}`,
      author: { login: reply ? VIEWER : `author-${index % 17}` },
      body: `Point ${index}, reply ${reply}: this needs a closer look at the boundary.`,
      createdAt: at(100 - reply),
      updatedAt: at(100 - reply),
      url: `https://github.com/${large}/pull/1#discussion_r${index}${reply}`,
      replyToId: reply ? `comment-large-${index}-0` : null,
    })),
  }));

  pulls.push(
    pull(LARGE_PR, 1, large, sha(`${large}:head`), { threads, baseOid: sha(`${large}:base`) }),
  );

  // The rebased one: reviewed at one head, then rebuilt onto a newer main with more edits.
  const rebased = 'synthetic/rebased';
  const oldBase: Record<string, string> = {};
  const reviewed: Record<string, string | null> = {};
  const moved: Record<string, string | null> = {};
  const current: Record<string, string | null> = {};

  for (let index = 0; index < options.rebasedFiles; index++) {
    const path = `src/feature/area-${index}.ts`;

    oldBase[path] = source(path, options.rebasedLines);
    reviewed[path] = source(path, options.rebasedLines, 'reviewed');
    moved[path] = source(path, options.rebasedLines, 'main');
    current[path] = source(path, options.rebasedLines + 5, 'current');
  }

  repos.commit(rebased, sha(`${rebased}:old`), [], oldBase, at(60 * 72));
  repos.derive(rebased, sha(`${rebased}:reviewed`), sha(`${rebased}:old`), reviewed, at(60 * 30));
  repos.derive(rebased, sha(`${rebased}:main`), sha(`${rebased}:old`), moved, at(60 * 10));
  repos.derive(rebased, sha(`${rebased}:head`), sha(`${rebased}:main`), current, at(40));
  repos.ref(rebased, 'main', sha(`${rebased}:main`));
  pulls.push(
    pull(REBASED_PR, 2, rebased, sha(`${rebased}:head`), {
      baseOid: sha(`${rebased}:main`),
      reviews: [
        {
          id: 'review-rebased',
          state: 'COMMENTED',
          submittedAt: at(60 * 29),
          updatedAt: at(60 * 29),
          commitOid: sha(`${rebased}:reviewed`),
          body: 'First pass.',
          url: `https://github.com/${rebased}/pull/2#pullrequestreview-1`,
        },
      ],
      forcePushes: [
        {
          id: 'force-push-rebased',
          createdAt: at(40),
          beforeOid: sha(`${rebased}:reviewed`),
          afterOid: sha(`${rebased}:head`),
          actor: 'author-1',
        },
      ],
    }),
  );

  return {
    name: 'synthetic',
    world: {
      viewer: { login: VIEWER },
      teams: [],
      now: () => anchor,
      pulls,
      repos,
      viewed: new Map(),
    },
    steps: [],
  };
}

/** Moves `count` of the many PRs to a new head, as a burst of pushes would. */
export function pushTo(scenario: Scenario, count: number, round: number): string[] {
  const moved: string[] = [];

  for (const { snapshot } of scenario.world.pulls) {
    if (moved.length >= count) break;
    if (!snapshot.id.startsWith('PR_synthetic_') || snapshot.id === LARGE_PR) continue;
    if (snapshot.id === REBASED_PR) continue;

    const head = sha(`${snapshot.repository}:${snapshot.number}:push-${round}`);

    scenario.world.repos.derive(
      snapshot.repository,
      head,
      snapshot.headOid,
      { [`src/module-${snapshot.number % 20}.ts`]: source(snapshot.id, 41, `push-${round}`) },
      new Date(scenario.world.now()).toISOString(),
    );
    snapshot.headOid = head;
    snapshot.updatedAt = new Date(scenario.world.now() + round * 1000).toISOString();
    moved.push(snapshot.id);
  }

  return moved;
}
