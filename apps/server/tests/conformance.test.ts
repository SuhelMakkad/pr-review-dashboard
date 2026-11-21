import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgeTraits, type ForgeTraits } from '@review-desk/shared/traits';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { declaredTraits } from '@/forge/bind.js';
import { ForgeError } from '@/forge/port.js';
import type { GitHubApi } from '@/github/api.js';
import { GitHub } from '@/github/read.js';
import { GhCli } from '@/github/transport.js';
import { GlabCli } from '@/gitlab/transport.js';
import {
  at,
  discussions,
  gitlab,
  HEAD2,
  HOST,
  mergeRequest,
  MR,
  note,
  seconds,
  VIEWER,
} from './gitlab-fake.js';

/**
 * The forge port's contract, run against GitHub (over a fake of its GraphQL API), GitLab (over a
 * fake of its REST API) and the demo fixture alike. Each case asserts what the port answers, and
 * reads the forge's declared traits where they say the answer differs.
 */

const cleanups: (() => unknown)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();

  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One forge, ready for the contract: a PR at a head, one of its threads, and a changed file. */
interface Subject {
  forge: GitHubApi;
  pr: { id: string; head: string; thread: string; path: string };
  /** The account whose history the forge holds. */
  login: string;
  /** The next submission reaches the forge, but its answer is lost on the way back. */
  loseNextSubmission(): void;
  /** The forge as it stands once that lost submission was published. */
  published(): void;
}

const reviewStates: Record<string, string> = {
  APPROVE: 'APPROVED',
  COMMENT: 'COMMENTED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
};

/** GitHub, over a GraphQL API that keeps its reviews in memory. */
function github(): Subject {
  const head = 'a'.repeat(40);
  const reviews = new Map<string, { state: string; body: string }>();
  const url = (id: string) => `https://github.com/acme/api/pull/1#pullrequestreview-${id}`;
  let lose = false;
  let next = 0;
  const answer = (name: string, variables: Record<string, unknown>) => {
    switch (name) {
      case 'AddPendingReview': {
        const id = `PRR_${++next}`;

        reviews.set(id, { state: 'PENDING', body: '' });

        return { addPullRequestReview: { pullRequestReview: { id } } };
      }
      case 'SubmitReview': {
        const id = String(variables.id);
        const review = reviews.get(id)!;

        review.state = reviewStates[String(variables.event)];
        review.body = String(variables.body ?? '');

        return {
          submitPullRequestReview: {
            pullRequestReview: { id, url: url(id), state: review.state, submittedAt: at(20) },
          },
        };
      }
      case 'DeleteReview':
        reviews.delete(String(variables.id));

        return { deletePullRequestReview: { pullRequestReview: { id: variables.id } } };
      case 'ReviewReceipt': {
        const id = String(variables.id);
        const review = reviews.get(id);

        return {
          node: review
            ? {
                id,
                state: review.state,
                url: url(id),
                body: review.body,
                commit: { oid: head },
                comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              }
            : null,
        };
      }
      case 'ReplyToThread':
        return {
          addPullRequestReviewThreadReply: {
            comment: { id: 'PRRC_1', url: url('r1'), state: 'SUBMITTED' },
          },
        };
      case 'ResolveThread':
        return { resolveReviewThread: { thread: { id: variables.threadId, isResolved: true } } };
      case 'Search':
        return {
          search: { nodes: [{ id: 'PR_1' }], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'MarkFileViewed':
        return {
          markFileAsViewed: {
            pullRequest: { id: variables.pullRequestId, headRefOid: head, baseRefOid: null },
          },
        };
      default:
        throw new Error(`The fake GitHub does not answer ${name}.`);
    }
  };
  const graphql = vi.fn(async (document: string, variables: Record<string, unknown> = {}) => {
    const name = /(?:mutation|query) (\w+)/.exec(document)?.[1] ?? '';
    const result = answer(name, variables);

    if (lose && name === 'SubmitReview') {
      lose = false;
      throw new ForgeError('The connection ended before GitHub answered.');
    }

    return result;
  });

  return {
    forge: new GitHub({ graphql, rest: vi.fn() } as never),
    pr: { id: 'PR_1', head, thread: 'PRRT_1', path: 'src/app.ts' },
    login: 'octo',
    loseNextSubmission: () => (lose = true),
    published: () => undefined,
  };
}

/** GitLab, over its REST API, with draft notes kept as they are added, published and deleted. */
function gitLab(): Subject {
  const { fake, client, store } = gitlab();
  const draft = {
    id: 31,
    note: 'Pending thought',
    position: { head_sha: HEAD2, new_path: 'src/app.ts', new_line: 2 },
  };
  let drafts: unknown[] = [draft];
  let lose = false;

  cleanups.push(() => store.close());
  fake
    .on('GET', `${MR}/draft_notes`, () => ({ data: drafts }))
    .on('POST', `${MR}/draft_notes`, (request) => {
      const added = { id: 50, note: (request.body as { note: string }).note };

      drafts = [...drafts, added];

      return { status: 201, data: added };
    })
    .on('DELETE', `${MR}/draft_notes/31`, () => {
      drafts = [];

      return { status: 204, data: '' };
    })
    .on('POST', `${MR}/approve`, { status: 201, data: {} })
    .on('POST', `${MR}/draft_notes/bulk_publish`, () => {
      if (lose) return { status: 502, data: 'Bad gateway' };

      drafts = [];

      return { status: 204, data: '' };
    })
    .on('POST', `${MR}/discussions/abc123/notes`, {
      status: 201,
      data: note(300, 'rev', 'Thanks', at(30)),
    })
    .on('PUT', `${MR}/discussions/abc123`, { data: {} })
    .on('GET', 'merge_requests', { data: [mergeRequest()] });

  return {
    forge: client,
    pr: { id: 'MR_7_12', head: HEAD2, thread: 'MRD_7_12_abc123', path: 'src/app.ts' },
    login: VIEWER,
    loseNextSubmission: () => (lose = true),
    published: () => {
      // GitLab published the drafts, then its approval and summary notes.
      drafts = [];
      fake.on('GET', `${MR}/discussions`, {
        data: [
          ...discussions(),
          {
            id: 'bb01',
            individual_note: true,
            notes: [note(201, 'rev', 'approved this merge request', at(20), { system: true })],
          },
          {
            id: 'bb02',
            individual_note: true,
            notes: [note(202, 'rev', 'Ship it.', seconds(20, 5))],
          },
        ],
      });
    },
  };
}

/** The demo fixture, on a PR of its scenario with a thread. */
function fixture(): Subject {
  const forge = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const pull = forge.scenario.world.pulls.find(
    (candidate) => candidate.snapshot.threads.length > 0,
  )!.snapshot;

  return {
    forge,
    pr: {
      id: pull.id,
      head: pull.headOid,
      thread: pull.threads[0].id,
      path: pull.files[0]?.path ?? 'README.md',
    },
    login: forge.scenario.world.viewer.login,
    loseNextSubmission: () => (forge.loseResponseNext = 'SubmitReview'),
    published: () => undefined,
  };
}

const forges: { name: string; traits: ForgeTraits; make: () => Subject }[] = [
  { name: 'GitHub', traits: forgeTraits.github, make: github },
  { name: 'GitLab', traits: forgeTraits.gitlab, make: gitLab },
  { name: 'the demo fixture', traits: forgeTraits.github, make: fixture },
];

describe.each(forges)('$name', ({ traits, make }) => {
  it('declares its traits', () => {
    expect(declaredTraits(make().forge)).toEqual(traits);
  });

  it('answers an acknowledged submission with its receipt', async () => {
    const { forge, pr } = make();
    const review = await forge.addPendingReview(pr.id, pr.head);

    expect(await forge.submitReview(review, 'COMMENT', 'Looks fine.')).toMatchObject({
      id: expect.any(String),
      url: expect.stringMatching(/^https:\/\//),
    });
  });

  it('recovers a submission whose answer was lost, from its receipt', async () => {
    // Every forge's notes and reviews are timed from the same moment.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at(20)));

    const subject = make();
    const { forge, pr } = subject;
    const review = await forge.addPendingReview(pr.id, pr.head);

    subject.loseNextSubmission();
    await expect(forge.submitReview(review, 'APPROVE', 'Ship it.')).rejects.toBeInstanceOf(
      ForgeError,
    );
    subject.published();

    // The path the outbox takes after a lost answer: what became of the pending review?
    expect(await forge.reviewReceipt(review)).toMatchObject({
      state: 'APPROVED',
      body: 'Ship it.',
    });
  });

  it('deletes a pending review, which then has no receipt', async () => {
    const { forge, pr } = make();
    const review = await forge.addPendingReview(pr.id, pr.head);

    expect(await forge.reviewReceipt(review)).toMatchObject({ state: 'PENDING' });

    await forge.deleteReview(review);

    expect(await forge.reviewReceipt(review)).toBeNull();
  });

  it('replies to a thread at once, and resolves it', async () => {
    const { forge, pr } = make();

    expect(await forge.replyToThread(pr.thread, 'Thanks')).toMatchObject({
      id: expect.any(String),
      url: expect.any(String),
      pending: false,
    });
    await expect(forge.setThreadResolved(pr.thread, true)).resolves.toBeUndefined();
  });

  it("finds the account's history, and none in an empty list of repositories", async () => {
    const { forge, login } = make();
    const window = { login, from: '2020-01-01', to: '2030-12-31' };

    expect(await forge.searchPullIds({ kind: 'reviewed', ...window })).not.toHaveLength(0);

    // No repository named is no PR, never a search across every repository.
    expect(await forge.searchPullIds({ kind: 'reviewed', ...window, repositories: [] })).toEqual(
      [],
    );
  });

  it('marks a file viewed at the revision it is at, keyed where viewed state follows the diff', async () => {
    const { forge, pr } = make();
    const revision = await forge.setFileViewed(pr.id, pr.path, true);

    expect(revision).toMatchObject({ headOid: pr.head });

    // GitLab pins viewed state to each file's diff, so its mark says which diff it was.
    if (traits.pinnedFiles) expect(revision).toHaveProperty('fileKey', expect.any(String));
    else expect(revision).not.toHaveProperty('fileKey');
  });
});

describe('a rate limit at each CLI transport', () => {
  it('reaches GitHub callers as a rate limit with a time to retry', async () => {
    const gh = new GhCli(
      undefined,
      { environment: async () => ({}), forget: vi.fn() },
      async () => ({
        code: 1,
        stdout:
          'HTTP/2.0 429 Too Many Requests\nRetry-After: 30\nContent-Type: application/json\n\n{"message":"API rate limit exceeded"}',
        stderr: 'gh: API rate limit exceeded (HTTP 429)',
        timedOut: false,
      }),
    );

    const error = await gh.graphql('query Identity { viewer { login } }').catch((reason) => reason);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ outcome: 'rate_limit', status: 429 });
    expect(Date.parse((error as ForgeError).retryAt!) - Date.now()).toBeGreaterThan(20_000);
  });

  it('reaches GitLab callers as a rate limit with the time it names', async () => {
    const glab = new GlabCli(HOST, async () => ({
      code: 1,
      stdout: 'HTTP/2.0 429 Too Many Requests\nRetry-After: 30\n\n{"message":"slow down"}',
      stderr: '',
      timedOut: false,
    }));
    const error = await glab.request({ path: 'user' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ outcome: 'rate_limit', status: 429 });
    expect(Date.parse((error as ForgeError).retryAt!) - Date.now()).toBeGreaterThan(20_000);
  });
});

describe("the demo fixture's errors", () => {
  it('reach callers normalised, as a forge error', async () => {
    const { forge, pr } = fixture();
    const review = await forge.addPendingReview(pr.id, pr.head);

    (forge as FixtureGitHub).failNext = 'SubmitReview';

    await expect(forge.submitReview(review, 'COMMENT', '')).rejects.toBeInstanceOf(ForgeError);
  });
});
