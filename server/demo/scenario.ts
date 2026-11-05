import { createHash } from 'node:crypto';
import { buildDemoRepos } from './content.js';
import type { FixtureRepos } from './repo.js';
import type {
  Actor,
  PullRequestSnapshot,
  Review,
  ReviewThread,
  Source,
  ThreadComment,
} from '../../shared/types.js';

export interface ScenarioPull {
  /** Discovery feeds that return this PR. */
  feeds: Source[];
  snapshot: Omit<PullRequestSnapshot, 'sources' | 'fetchedAt' | 'headObservedAt'>;
}

export interface ScenarioStep {
  label: string;
  apply(world: ScenarioWorld): void;
}

export interface ScenarioWorld {
  viewer: Actor;
  teams: string[];
  now: () => number;
  pulls: ScenarioPull[];
  /** Commit graphs and file contents behind every PR's diff. */
  repos: FixtureRepos;
  /** Per-PR, per-path viewed state as GitHub would report it. */
  viewed: Map<string, Map<string, 'VIEWED' | 'UNVIEWED' | 'DISMISSED'>>;
}

export interface Scenario {
  name: string;
  world: ScenarioWorld;
  steps: ScenarioStep[];
}

const VIEWER = 'you';

/** Builds a fictional review workload anchored to `anchor`, so relative times look natural. */
export function defaultScenario(anchor = Date.now()): Scenario {
  const at = (minutesAgo: number) => new Date(anchor - minutesAgo * 60_000).toISOString();
  const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

  let commentSequence = 0;

  const comment = (
    login: string,
    body: string,
    minutesAgo: number,
    replyToId: string | null = null,
  ): ThreadComment => {
    commentSequence += 1;

    return {
      id: `comment-${commentSequence}`,
      author: { login },
      body,
      createdAt: at(minutesAgo),
      updatedAt: at(minutesAgo),
      url: `https://github.com/acme/comment-${commentSequence}`,
      replyToId,
    };
  };

  const thread = (
    id: string,
    path: string,
    line: number,
    comments: ThreadComment[],
    resolved = false,
  ): ReviewThread => ({
    id,
    isResolved: resolved,
    isOutdated: false,
    path,
    line,
    comments,
  });

  const review = (
    id: string,
    state: Review['state'],
    minutesAgo: number,
    commitOid: string,
    body = '',
  ): Review => ({
    id,
    state,
    submittedAt: at(minutesAgo),
    updatedAt: at(minutesAgo),
    commitOid,
    body,
    url: `https://github.com/acme/review-${id}`,
  });

  const base = (
    number: number,
    repository: string,
    title: string,
    author: string,
    overrides: Partial<ScenarioPull['snapshot']>,
  ): ScenarioPull['snapshot'] => ({
    id: `PR_${repository.replace('/', '_')}_${number}`,
    number,
    title,
    url: `https://github.com/${repository}/pull/${number}`,
    body: '',
    repository,
    author: { login: author },
    isDraft: false,
    state: 'OPEN',
    createdAt: at(60 * 26),
    updatedAt: at(30),
    headOid: sha(`${repository}${number}head`),
    headCommittedAt: at(45),
    baseRefName: 'main',
    headRefName: `feat/${number}`,
    additions: 120,
    deletions: 18,
    changedFiles: 4,
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    reviewRequests: [],
    requestEvents: [],
    reviews: [],
    threads: [],
    files: [],
    checks: [
      { name: 'build', state: 'success', url: null },
      { name: 'unit-tests', state: 'success', url: null },
    ],
    ci: 'success',
    baseOid: sha(`${repository}base`),
    mergeStateStatus: 'BLOCKED',
    conversation: [],
    forcePushes: [],
    verdicts: [],
    pendingReview: null,
    ...overrides,
  });

  const conversationComment = (login: string, body: string, minutesAgo: number) => {
    commentSequence += 1;

    return {
      id: `conversation-${commentSequence}`,
      author: { login },
      body,
      createdAt: at(minutesAgo),
      updatedAt: at(minutesAgo),
      url: `https://github.com/acme/conversation-${commentSequence}`,
    };
  };

  const direct = { kind: 'user' as const, login: VIEWER, name: VIEWER };
  const platformTeam = { kind: 'team' as const, login: 'acme/platform', name: 'Platform' };

  const forcePushedOld = sha('acme/api2041old');
  const fastForwardOld = sha('acme/web877old');
  const waitingHead = sha('acme/web870head');
  const caughtUpHead = sha('acme/api2033head');

  const pulls: ScenarioPull[] = [
    {
      feeds: ['requested', 'reviewed'],
      snapshot: base(
        2041,
        'acme/api',
        'Product metadata schema with versioned migrations',
        'alex',
        {
          body: '## Summary\n\nAdds the `product_metadata` table and a versioned migration runner.\n\n- Backfills existing rows\n- Adds indexes for lookups by product\n\nCloses DEMO-101.',
          headRefName: 'feat/DEMO-101/product-metadata',
          additions: 1611,
          deletions: 25,
          changedFiles: 9,
          createdAt: at(60 * 14),
          headCommittedAt: at(70),
          reviewRequests: [direct],
          requestEvents: [
            { id: 'req-2041-1', createdAt: at(60 * 13), removed: false, reviewer: direct },
            { id: 'req-2041-2', createdAt: at(65), removed: false, reviewer: direct },
          ],
          forcePushes: [
            {
              id: 'fp-2041',
              createdAt: at(70),
              beforeOid: forcePushedOld,
              afterOid: sha('acme/api2041head'),
              actor: 'alex',
            },
          ],
          reviews: [
            review(
              'r-2041',
              'CHANGES_REQUESTED',
              60 * 3,
              forcePushedOld,
              'Two blocking issues in the backfill; details inline.',
            ),
          ],
          threads: [
            thread('t-2041-1', 'src/db/migrations/0042_product_metadata.sql', 18, [
              comment(
                VIEWER,
                'This backfill runs in one transaction; it will lock the table on large tenants. Can we batch it?',
                60 * 3,
              ),
              comment('alex', 'Good catch, batched in chunks of 5k now.', 50, 'comment-1'),
            ]),
            thread('t-2041-2', 'src/facts/repository.ts', 64, [
              comment(VIEWER, 'Missing index on `(product_id, kind)` for this lookup.', 60 * 3),
              comment('alex', 'Added in the migration.', 48, 'comment-3'),
            ]),
          ],
          checks: [
            { name: 'build', state: 'success', url: null },
            { name: 'unit-tests', state: 'pending', url: null },
            { name: 'migrations', state: 'success', url: null },
          ],
          ci: 'pending',
        },
      ),
    },
    {
      feeds: ['requested', 'reviewed'],
      snapshot: base(877, 'acme/web', 'Collection filter editor with live validation', 'alex', {
        body: 'Adds a filter editor for product collections. Validation runs as you type.',
        headRefName: 'feat/DEMO-102/collection-filters',
        additions: 1216,
        deletions: 43,
        changedFiles: 7,
        reviewRequests: [direct],
        requestEvents: [
          { id: 'req-877-1', createdAt: at(60 * 20), removed: false, reviewer: direct },
          { id: 'req-877-2', createdAt: at(60 * 2), removed: false, reviewer: direct },
        ],
        reviews: [
          review(
            'r-877',
            'APPROVED',
            60 * 4,
            fastForwardOld,
            'Looks good once the copy is updated.',
          ),
        ],
      }),
    },
    {
      feeds: ['requested'],
      snapshot: base(
        1839,
        'acme/web',
        'Calendar settings use the design-system tab buttons',
        'mara',
        {
          body: 'Replaces the bespoke tab buttons on the scheduling screen with the shared `TabButtons` component.',
          headRefName: 'fix/DEMO-103/calendar-tabs',
          additions: 104,
          deletions: 42,
          changedFiles: 10,
          createdAt: at(6),
          updatedAt: at(5),
          reviewRequests: [direct],
          requestEvents: [{ id: 'req-1839', createdAt: at(5), removed: false, reviewer: direct }],
          checks: [{ name: 'build', state: 'pending', url: null }],
          ci: 'pending',
        },
      ),
    },
    {
      feeds: ['requested', 'mentioned'],
      snapshot: base(2050, 'acme/api', 'Rate-limit the public search endpoint', 'jonas', {
        body: 'Adds a token-bucket limiter in front of `/v1/search`.',
        conversation: [
          conversationComment('priya', 'Do we need per-tenant buckets here?', 60 * 4),
          conversationComment(
            'jonas',
            '@you could you sanity-check the default burst size? I picked 20 somewhat arbitrarily.',
            60 * 3,
          ),
        ],
        additions: 230,
        deletions: 12,
        changedFiles: 5,
        createdAt: at(60 * 30),
        reviewRequests: [platformTeam],
        requestEvents: [
          { id: 'req-2050', createdAt: at(60 * 29), removed: false, reviewer: platformTeam },
        ],
        checks: [
          { name: 'build', state: 'success', url: null },
          { name: 'unit-tests', state: 'failure', url: null },
        ],
        ci: 'failure',
      }),
    },
    {
      feeds: ['reviewed'],
      snapshot: base(870, 'acme/web', 'Saved searches for catalog editors', 'mara', {
        headOid: waitingHead,
        additions: 410,
        deletions: 33,
        changedFiles: 8,
        reviews: [
          review(
            'r-870',
            'CHANGES_REQUESTED',
            60 * 20,
            waitingHead,
            'Needs pagination before this can ship.',
          ),
        ],
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    },
    {
      feeds: ['reviewed'],
      snapshot: base(2033, 'acme/api', 'Structured logging for the indexing worker', 'jonas', {
        headOid: caughtUpHead,
        additions: 88,
        deletions: 61,
        changedFiles: 3,
        reviews: [review('r-2033', 'APPROVED', 60 * 6, caughtUpHead)],
        reviewDecision: 'APPROVED',
      }),
    },
    {
      feeds: ['assigned'],
      snapshot: base(42, 'acme/infra', 'Terraform: move staging to the new VPC', 'priya', {
        isDraft: true,
        additions: 640,
        deletions: 220,
        changedFiles: 14,
        createdAt: at(60 * 50),
        checks: [],
        ci: 'none',
      }),
    },
  ];

  const mine = (
    number: number,
    repository: string,
    title: string,
    overrides: Partial<ScenarioPull['snapshot']>,
  ) => base(number, repository, title, VIEWER, overrides);
  const jonas = { kind: 'user' as const, login: 'jonas', name: 'jonas' };

  pulls.push(
    {
      feeds: ['authored'],
      snapshot: mine(3001, 'acme/api', 'Retry webhooks with exponential backoff', {
        headRefName: 'feat/DEMO-104/webhook-retries',
        additions: 342,
        deletions: 57,
        changedFiles: 6,
        createdAt: at(60 * 40),
        verdicts: [
          {
            login: 'mara',
            state: 'CHANGES_REQUESTED',
            submittedAt: at(60 * 5),
            commitOid: sha('acme/api3001head'),
          },
        ],
        threads: [
          thread('t-3001-1', 'src/webhooks/retry.ts', 31, [
            comment('mara', 'Cap the backoff; at attempt 12 this waits over an hour.', 60 * 5),
          ]),
        ],
        checks: [
          { name: 'build', state: 'success', url: null },
          { name: 'unit-tests', state: 'failure', url: null },
        ],
        ci: 'failure',
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    },
    {
      feeds: ['authored'],
      snapshot: mine(882, 'acme/web', 'Keyboard shortcuts for the product list', {
        additions: 188,
        deletions: 20,
        changedFiles: 5,
        createdAt: at(60 * 30),
        reviewRequests: [jonas],
        requestEvents: [{ id: 'req-882', createdAt: at(60 * 29), removed: false, reviewer: jonas }],
      }),
    },
    {
      feeds: ['authored'],
      snapshot: mine(2058, 'acme/api', 'Bump Node to 24.11 in CI and Docker images', {
        additions: 12,
        deletions: 12,
        changedFiles: 4,
        verdicts: [
          {
            login: 'priya',
            state: 'APPROVED',
            submittedAt: at(90),
            commitOid: sha('acme/api2058head'),
          },
        ],
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
      }),
    },
    {
      feeds: ['authored'],
      snapshot: mine(45, 'acme/infra', 'Spike: cost alerts for idle preview environments', {
        isDraft: true,
        additions: 96,
        deletions: 0,
        changedFiles: 3,
        checks: [],
        ci: 'none',
        mergeStateStatus: 'DRAFT',
      }),
    },
  );

  const generatedFiles: Record<number, { path: string; added?: boolean; lines?: number }[]> = {
    1839: [
      { path: 'src/scheduling/CalendarTabs.tsx' },
      { path: 'src/scheduling/CalendarSettings.tsx', lines: 40 },
      { path: 'src/scheduling/styles.css', lines: 12 },
    ],
    2050: [
      { path: 'src/search/rateLimit.ts', added: true, lines: 36 },
      { path: 'src/search/routes.ts' },
      { path: 'tests/search/rateLimit.test.ts', added: true, lines: 20 },
    ],
    870: [
      { path: 'src/catalog/SavedSearches.tsx', added: true, lines: 48 },
      { path: 'src/catalog/api.ts' },
    ],
    2033: [
      { path: 'src/indexing/worker.ts', lines: 30 },
      { path: 'src/logging.ts', lines: 16 },
      // Large generated file: collapsed by default, and the diff performance check.
      { path: 'src/indexing/weights.generated.ts', added: true, lines: 5000 },
    ],
    42: [
      { path: 'infra/staging/vpc.tf', lines: 28 },
      { path: 'infra/staging/main.tf', lines: 20 },
    ],
    3001: [
      { path: 'src/webhooks/retry.ts', added: true, lines: 44 },
      { path: 'src/webhooks/dispatcher.ts' },
      { path: 'tests/webhooks/retry.test.ts', added: true, lines: 18 },
    ],
    882: [
      { path: 'src/products/useListShortcuts.ts', added: true, lines: 32 },
      { path: 'src/products/ProductList.tsx' },
    ],
    2058: [
      { path: '.github/workflows/ci.yml', lines: 14 },
      { path: 'Dockerfile', lines: 10 },
    ],
    45: [{ path: 'infra/alerts/preview-costs.tf', added: true, lines: 22 }],
  };
  const repos = buildDemoRepos(
    sha,
    pulls.map((pull) => {
      const reviewedOid =
        [...pull.snapshot.reviews].sort(
          (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt),
        )[0]?.commitOid ?? undefined;

      return {
        number: pull.snapshot.number,
        repository: pull.snapshot.repository,
        baseOid: pull.snapshot.baseOid ?? sha(`${pull.snapshot.repository}base`),
        headOid: pull.snapshot.headOid,
        reviewedOid,
        files: generatedFiles[pull.snapshot.number] ?? [],
      };
    }),
  );

  const world: ScenarioWorld = {
    repos,
    viewed: new Map(),
    viewer: { login: VIEWER },
    teams: ['acme/platform'],
    now: () => Date.now(),
    pulls,
  };

  const steps: ScenarioStep[] = [
    {
      label: 'A new reply arrives on the product metadata PR',
      apply(current) {
        const pull = current.pulls.find((item) => item.snapshot.number === 2041);

        if (!pull) return;

        const conversation = pull.snapshot.threads[0];
        const now = new Date(current.now()).toISOString();

        conversation.comments.push({
          id: `comment-step-${conversation.comments.length}`,
          author: { login: 'alex' },
          body: 'Also added a dry-run flag so ops can preview the batch sizes.',
          createdAt: now,
          updatedAt: now,
          url: 'https://github.com/acme/comment-step',
          replyToId: conversation.comments[0].id,
        });
        pull.snapshot.updatedAt = now;
      },
    },
  ];

  return { name: 'default', world, steps };
}
