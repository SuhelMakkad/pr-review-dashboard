import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import { forgeTraits, type ForgeTraits } from '@review-desk/shared/traits';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { declaredTraits } from '@/forge/bind.js';
import { ForgeError } from '@/forge/port.js';
import type { GitHubApi } from '@/github/api.js';
import { GitHub } from '@/github/read.js';
import { GhCli } from '@/github/transport.js';
import { GlabCli, type GitLabRequest } from '@/gitlab/transport.js';
import {
  at,
  discussions,
  gitlab,
  HEAD2,
  HOST,
  mergeRequest,
  MR,
  note,
  position,
  VIEWER,
} from './gitlab-fake.js';

/**
 * The forge port's contract, run against GitHub (over a fake of its GraphQL API), GitLab (over a
 * fake of its REST API) and the demo fixture alike. Each fake keeps what is written to it, so a
 * write is checked by reading the PR back. Each case asserts what the port answers, and reads the
 * forge's declared traits where they say the answer differs.
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
  /** The account the forge is signed in as, whose PR it is. */
  login: string;
  /** The next submission reaches the forge and is published, but its answer is lost. */
  loseNextSubmission(): void;
}

const reviewStates: Record<string, string> = {
  APPROVE: 'APPROVED',
  COMMENT: 'COMMENTED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
};

const page = { hasNextPage: false, endCursor: null };
const connection = <T>(nodes: T[]) => ({ nodes, pageInfo: page });

/** GitHub, over a GraphQL API that keeps its reviews, threads and viewed files in memory. */
function github(): Subject {
  const head = 'a'.repeat(40);
  const reviews = new Map<string, { state: string; body: string }>();
  const comment = (id: string, body: string, createdAt: string) => ({
    id,
    body,
    author: { login: 'dev' },
    createdAt,
    updatedAt: createdAt,
    url: `https://github.com/acme/api/pull/1#discussion_${id}`,
    replyTo: null,
  });
  const thread = {
    id: 'PRRT_1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 2,
    comments: [
      comment('PRRC_0', 'Can this loop exit early?', at(3)),
      comment('PRRC_1', 'Done in the next commit.', at(5)),
    ],
  };
  const viewed = new Set<string>();
  const url = (id: string) => `https://github.com/acme/api/pull/1#pullrequestreview-${id}`;
  let lose = false;
  let next = 0;

  /** The PR as GitHub's snapshot query answers it. */
  const pull = () => ({
    id: 'PR_1',
    number: 1,
    title: 'Speed up the importer',
    url: 'https://github.com/acme/api/pull/1',
    body: '',
    repository: { nameWithOwner: 'acme/api' },
    author: { login: 'dev' },
    isDraft: false,
    state: 'OPEN',
    createdAt: at(0),
    updatedAt: at(9),
    headRefOid: head,
    baseRefName: 'main',
    headRefName: 'feature',
    additions: 2,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    reviews: connection([]),
    reviewRequests: connection([]),
    timelineItems: connection([]),
    reviewThreads: connection([{ ...thread, comments: connection(thread.comments) }]),
    files: connection([
      {
        path: 'src/app.ts',
        additions: 2,
        deletions: 1,
        viewerViewedState: viewed.has('src/app.ts') ? 'VIEWED' : 'UNVIEWED',
      },
    ]),
    pending: connection(
      [...reviews]
        .filter(([, review]) => review.state === 'PENDING')
        .map(([id]) => ({ id, createdAt: at(10), comments: { totalCount: 0 } })),
    ),
    commits: { nodes: [{ commit: { committedDate: at(2), statusCheckRollup: null } }] },
  });

  /** A write names what it changes: anything but this PR and its thread is refused. */
  const target = (key: string, value: unknown, expected: string) => {
    if (value !== expected) throw new Error(`The fake GitHub has no ${key} ${String(value)}.`);
  };
  const answer = (name: string, variables: Record<string, unknown>) => {
    switch (name) {
      case 'Identity':
        return { viewer: { login: 'octo', avatarUrl: null } };
      case 'Snapshot':
        return { node: variables.id === 'PR_1' ? pull() : null };
      case 'Search':
        return { search: connection([{ id: 'PR_1' }]) };
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
                comments: connection([]),
              }
            : null,
        };
      }
      case 'ReplyToThread': {
        target('thread', variables.threadId, thread.id);

        const reply = comment(`PRRC_${thread.comments.length}`, String(variables.body), at(30));

        thread.comments.push(reply);

        return {
          addPullRequestReviewThreadReply: {
            comment: { id: reply.id, url: reply.url, state: 'SUBMITTED' },
          },
        };
      }
      case 'ResolveThread':
        target('thread', variables.threadId, thread.id);
        thread.isResolved = true;

        return { resolveReviewThread: { thread: { id: variables.threadId, isResolved: true } } };
      case 'MarkFileViewed':
        target('pull request', variables.pullRequestId, 'PR_1');
        viewed.add(String(variables.path));

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

    // Applied, as GitHub would have, then the answer is lost on its way back.
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
  };
}

/**
 * GitLab, over its REST API, bound to its account as production binds it. Draft notes are kept as
 * they are added and deleted; an approval and a publication add their notes to the MR's
 * discussions, and a resolution or a reply changes them.
 */
function gitLab(): Subject {
  const { fake, client, store } = gitlab();
  let drafts: { id: number; note: string; position?: unknown }[] = [
    { id: 31, note: 'Pending thought', position: { head_sha: HEAD2, new_line: 2 } },
  ];
  const added: ReturnType<typeof discussions> = [];
  const replies: ReturnType<typeof note>[] = [];
  let resolved = false;
  let lose = false;
  let next = 200;
  /** A note GitLab publishes now: on its own, or a thread on a line, as a draft on one is. */
  const publish = (body: string, extra: Record<string, unknown> = {}) => {
    next += 1;
    added.push({
      id: `bb${next}`,
      individual_note: !extra.position,
      notes: [note(next, 'rev', body, new Date().toISOString(), extra)],
    });
  };

  cleanups.push(() => store.close());
  fake
    .on('GET', `${MR}/discussions`, () => ({
      data: [
        ...discussions().map((discussion) =>
          discussion.id === 'abc123'
            ? {
                ...discussion,
                notes: [...discussion.notes, ...replies].map((thread) => ({ ...thread, resolved })),
              }
            : discussion,
        ),
        ...added,
      ],
    }))
    .on('GET', `${MR}/draft_notes`, () => ({ data: drafts }))
    .on('POST', `${MR}/draft_notes`, (request: GitLabRequest) => {
      next += 1;

      const draft = { id: next, note: (request.body as { note: string }).note };

      drafts = [...drafts, draft];

      return { status: 201, data: draft };
    })
    .on('DELETE', `${MR}/draft_notes/31`, () => {
      drafts = drafts.filter((draft) => draft.id !== 31);

      return { status: 204, data: '' };
    })
    .on('POST', `${MR}/approve`, () => {
      publish('approved this merge request', { system: true });

      return { status: 201, data: {} };
    })
    .on('POST', `${MR}/draft_notes/bulk_publish`, (request: GitLabRequest) => {
      // Every draft, then the summary where the release takes it with the publication.
      for (const draft of drafts)
        publish(
          draft.note,
          draft.position
            ? { type: 'DiffNote', resolvable: true, position: position(HEAD2, 2) }
            : {},
        );

      drafts = [];

      const summary = (request.body as { note?: string } | undefined)?.note;

      if (summary) publish(summary);
      if (!lose) return { status: 204, data: '' };

      // Published, then the answer is lost on its way back.
      lose = false;

      return { status: 502, data: 'Bad gateway' };
    })
    .on('POST', `${MR}/discussions/abc123/notes`, (request: GitLabRequest) => {
      const body = (request.body as { body: string }).body;
      const reply = note(300 + replies.length, 'rev', body, at(30), {
        type: 'DiffNote',
        resolvable: true,
      });

      replies.push(reply);

      return { status: 201, data: reply };
    })
    .on('PUT', `${MR}/discussions/abc123`, (request: GitLabRequest) => {
      resolved = (request.body as { resolved: boolean }).resolved;

      return { data: {} };
    })
    .on('GET', 'merge_requests', { data: [mergeRequest()] });

  return {
    forge: client.as(VIEWER),
    pr: { id: 'MR_7_12', head: HEAD2, thread: 'MRD_7_12_abc123', path: 'src/app.ts' },
    login: VIEWER,
    loseNextSubmission: () => (lose = true),
  };
}

/** The demo fixture, on a PR of its scenario with a thread, and one of the files it changes. */
async function fixture(): Promise<Subject> {
  const forge = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const pull = forge.scenario.world.pulls.find(
    (candidate) => candidate.snapshot.threads.length > 0,
  )!.snapshot;
  const [file] = await forge.pullFiles(pull.repository, pull.number);

  return {
    forge,
    pr: { id: pull.id, head: pull.headOid, thread: pull.threads[0].id, path: file.path },
    login: forge.scenario.world.viewer.login,
    loseNextSubmission: () => (forge.loseResponseNext = 'SubmitReview'),
  };
}

const forges: { name: string; traits: ForgeTraits; make: () => Subject | Promise<Subject> }[] = [
  { name: 'GitHub', traits: forgeTraits.github, make: github },
  { name: 'GitLab', traits: forgeTraits.gitlab, make: gitLab },
  { name: 'the demo fixture', traits: forgeTraits.github, make: fixture },
];

/** The PR as the subject's account sees it now. */
const read = ({ forge, pr, login }: Subject): Promise<PullRequestSnapshot> =>
  forge.snapshot(pr.id, login, ['requested']);

describe.each(forges)('$name', ({ traits, make }) => {
  it('declares its traits', async () => {
    expect(declaredTraits((await make()).forge)).toEqual(traits);
  });

  it('names the account it is signed in as', async () => {
    const { forge, login } = await make();

    expect((await forge.identity()).login).toBe(login);
  });

  it("reads the PR as its account sees it, each thread's comments in order", async () => {
    const subject = await make();
    const pr = await read(subject);

    expect(pr).toMatchObject({ id: subject.pr.id, headOid: subject.pr.head, state: 'OPEN' });
    expect(pr.threads.map((thread) => thread.id)).toContain(subject.pr.thread);
    expect(pr.files.map((file) => file.path)).toContain(subject.pr.path);

    for (const thread of pr.threads) {
      const times = thread.comments.map((comment) => Date.parse(comment.createdAt));

      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('answers an acknowledged submission with its receipt', async () => {
    const { forge, pr } = await make();
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

    const subject = await make();
    const { forge, pr } = subject;
    const review = await forge.addPendingReview(pr.id, pr.head);

    subject.loseNextSubmission();
    await expect(forge.submitReview(review, 'APPROVE', 'Ship it.')).rejects.toBeInstanceOf(
      ForgeError,
    );
    // The path the outbox takes after a lost answer: what became of the pending review?
    expect(await forge.reviewReceipt(review)).toMatchObject({
      state: 'APPROVED',
      body: 'Ship it.',
    });
  });

  it('deletes a pending review, which then has no receipt', async () => {
    const { forge, pr } = await make();
    const review = await forge.addPendingReview(pr.id, pr.head);

    expect(await forge.reviewReceipt(review)).toMatchObject({ state: 'PENDING' });

    await forge.deleteReview(review);

    expect(await forge.reviewReceipt(review)).toBeNull();
  });

  it('replies to a thread at once, and resolves it, as the PR then shows', async () => {
    const subject = await make();
    const { forge, pr } = subject;

    expect(await forge.replyToThread(pr.thread, 'Thanks')).toMatchObject({
      id: expect.any(String),
      url: expect.any(String),
      pending: false,
    });
    await forge.setThreadResolved(pr.thread, true);

    const thread = (await read(subject)).threads.find((candidate) => candidate.id === pr.thread);

    expect(thread?.isResolved).toBe(true);
    expect(thread?.comments.at(-1)?.body).toBe('Thanks');
  });

  it('marks a file viewed at the revision it is at, keyed where viewed state follows the diff', async () => {
    const subject = await make();
    const { forge, pr } = subject;
    const revision = await forge.setFileViewed(pr.id, pr.path, true);

    expect(revision).toMatchObject({ headOid: pr.head });

    // GitLab pins viewed state to each file's diff, so its mark says which diff it was.
    if (traits.pinnedFiles) expect(revision).toHaveProperty('fileKey', expect.any(String));
    else expect(revision).not.toHaveProperty('fileKey');

    // And the PR, read again as its account, shows the file viewed.
    const file = (await read(subject)).files.find((candidate) => candidate.path === pr.path);

    expect(file?.viewerViewedState).toBe('VIEWED');
  });

  it("finds the account's history, and none in an empty list of repositories", async () => {
    const { forge, login } = await make();
    const window = { login, from: '2020-01-01', to: '2030-12-31' };

    expect(await forge.searchPullIds({ kind: 'reviewed', ...window })).not.toHaveLength(0);

    // No repository named is no PR, never a search across every repository.
    expect(await forge.searchPullIds({ kind: 'reviewed', ...window, repositories: [] })).toEqual(
      [],
    );
  });
});

describe('a rate limit at each CLI transport', () => {
  /** The moment each limit is met, so the deadline it names can be checked exactly. */
  const NOW = Date.parse(at(20));

  it('reaches GitHub callers as a rate limit until the time it names', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

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
    expect(error).toMatchObject({
      outcome: 'rate_limit',
      status: 429,
      retryAt: new Date(NOW + 30_000).toISOString(),
    });
  });

  it('reaches GitLab callers as a rate limit until the time it names', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    const glab = new GlabCli(HOST, async () => ({
      code: 1,
      stdout: 'HTTP/2.0 429 Too Many Requests\nRetry-After: 30\n\n{"message":"slow down"}',
      stderr: '',
      timedOut: false,
    }));
    const error = await glab.request({ path: 'user' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({
      outcome: 'rate_limit',
      status: 429,
      retryAt: new Date(NOW + 30_000).toISOString(),
    });
  });
});

describe("the demo fixture's errors", () => {
  it('reach callers normalised, as a forge error', async () => {
    const { forge, pr } = await fixture();
    const review = await forge.addPendingReview(pr.id, pr.head);

    (forge as FixtureGitHub).failNext = 'SubmitReview';

    await expect(forge.submitReview(review, 'COMMENT', '')).rejects.toBeInstanceOf(ForgeError);
  });
});
