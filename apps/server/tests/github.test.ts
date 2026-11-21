import { describe, expect, it, vi } from 'vitest';
import { GhCli, GitHub, GitHubError, type GitHubTransport, safeError } from '@/github/index.js';

const page = (hasNextPage = false, endCursor: string | null = null) => ({ hasNextPage, endCursor });
const connection = <T>(nodes: T[], hasNextPage = false, endCursor: string | null = null) => ({
  nodes,
  pageInfo: page(hasNextPage, endCursor),
});

function rawSnapshot() {
  const comment = {
    id: 'comment-1',
    body: 'Original',
    author: { login: 'me' },
    createdAt: '2026-11-05T08:00:00Z',
    updatedAt: '2026-11-05T08:00:00Z',
    url: 'https://github.com/comment',
    replyTo: null,
  };

  return {
    id: 'pr-1',
    number: 1,
    title: 'Paginated PR',
    url: 'https://github.com/a/b/pull/1',
    body: '',
    repository: { nameWithOwner: 'a/b' },
    author: { login: 'author' },
    isDraft: false,
    state: 'OPEN',
    createdAt: '2026-11-04T08:00:00Z',
    updatedAt: '2026-11-05T09:00:00Z',
    headRefOid: 'head',
    baseRefName: 'main',
    headRefName: 'feature',
    additions: 1,
    deletions: 0,
    changedFiles: 2,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    reviews: connection([], true, 'review-cursor'),
    reviewRequests: connection([
      {
        requestedReviewer: {
          __typename: 'Team',
          name: 'Team',
          slug: 'team',
          organization: { login: 'acme' },
        },
      },
    ]),
    timelineItems: connection([]),
    reviewThreads: connection(
      [
        {
          id: 'thread-1',
          isResolved: true,
          isOutdated: false,
          path: 'a.ts',
          line: 1,
          comments: connection([comment], true, 'comment-cursor'),
        },
      ],
      true,
      'thread-cursor',
    ),
    files: connection([{ path: 'a.ts', additions: 1, deletions: 0 }], true, 'file-cursor'),
    commits: {
      nodes: [
        {
          commit: {
            committedDate: '2026-11-05T07:00:00Z',
            statusCheckRollup: {
              state: 'PENDING',
              contexts: connection(
                [
                  {
                    __typename: 'StatusContext',
                    context: 'build',
                    state: 'SUCCESS',
                    targetUrl: null,
                  },
                ],
                true,
                'check-cursor',
              ),
            },
          },
        },
      ],
    },
  };
}

describe('GitHub data retrieval', () => {
  it('searches history with the same search syntax as before, for each kind of query', async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: { nodes: [{ id: 'PR_1' }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const github = new GitHub({ graphql, rest: vi.fn() });
    const window = { login: 'octo', from: '2026-10-01', to: '2026-10-31' };

    expect(await github.searchPullIds({ kind: 'reviewed', ...window })).toEqual(['PR_1']);
    await github.searchPullIds({ kind: 'authored', ...window });

    expect(graphql.mock.calls.map((call) => call[1])).toEqual([
      { query: 'is:pr reviewed-by:octo updated:2026-10-01..2026-10-31', cursor: null },
      { query: 'is:pr author:octo created:2026-10-01..2026-10-31', cursor: null },
    ]);
  });

  it('submits an approval with a review body against the exact reviewed commit', async () => {
    const receipt = { id: 'review-1', url: 'https://github.com/a/b/pull/1#pullrequestreview-1' };
    const graphql = vi
      .fn()
      .mockResolvedValue({ addPullRequestReview: { pullRequestReview: receipt } });
    const github = new GitHub({ graphql, rest: vi.fn() });

    expect(await github.approveReview('pr-1', 'reviewed-head', 'No changes are needed.')).toEqual(
      receipt,
    );
    expect(graphql.mock.calls).toHaveLength(1);
    expect(graphql.mock.calls[0][0]).toContain('event: APPROVE');
    expect(graphql.mock.calls[0][1]).toEqual({
      pullRequestId: 'pr-1',
      commitOID: 'reviewed-head',
      body: 'No changes are needed.',
    });
  });

  it('finds a marked comment through every page of the conversation, by the PR’s id', async () => {
    const comment = (id: string, login: string, body: string) => ({
      id,
      url: `https://github.com/a/b/pull/1#issuecomment-${id}`,
      body,
      author: { login },
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        node: { comments: connection([comment('1', 'you', 'Looks good.')], true, 'page-2') },
      })
      .mockResolvedValueOnce({
        node: {
          comments: connection([
            comment('2', 'someone-else', '<!-- review-desk:ai-review run=r -->'),
            comment('3', 'you', '<!-- review-desk:ai-review run=r -->\nSummary'),
          ]),
        },
      });
    const github = new GitHub({ graphql, rest: vi.fn() });

    expect(
      await github.markedComment('pr-1', 'you', '<!-- review-desk:ai-review run=r -->'),
    ).toEqual({
      id: '3',
      url: 'https://github.com/a/b/pull/1#issuecomment-3',
    });
    expect(graphql.mock.calls.map((call) => call[1])).toEqual([
      { id: 'pr-1', cursor: null },
      { id: 'pr-1', cursor: 'page-2' },
    ]);
  });

  it('paginates discovery and deduplicates IDs', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        search: { issueCount: 3, ...connection([{ id: 'one' }, { id: 'two' }], true, 'next') },
      })
      .mockResolvedValueOnce({
        search: { issueCount: 3, ...connection([{ id: 'two' }, { id: 'three' }]) },
      });
    const github = new GitHub({ graphql, rest: vi.fn() });

    expect(await github.discover('me', 'reviewed')).toEqual(['one', 'two', 'three']);
    expect(graphql.mock.calls[1][1].cursor).toBe('next');
    expect(graphql.mock.calls[0][1].query).toContain('reviewed-by:me');
  });

  it('finds a PR by repository and number, and treats a missing one as null', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { id: 'PR_kw', state: 'OPEN' } } })
      .mockRejectedValueOnce(
        new GitHubError(
          "Could not resolve to a Repository with the name 'acme/missing'.",
          null,
          200,
          'rejected',
        ),
      )
      .mockRejectedValueOnce(new GitHubError('Bad credentials', null, 401, 'auth'));
    const github = new GitHub({ graphql, rest: vi.fn() });

    expect(await github.resolvePull('acme/api', 12)).toEqual({ id: 'PR_kw', state: 'OPEN' });
    expect(graphql.mock.calls[0][1]).toEqual({ owner: 'acme', name: 'api', number: 12 });
    expect(await github.resolvePull('acme/missing', 1)).toBeNull();
    await expect(github.resolvePull('acme/api', 12)).rejects.toThrow('Bad credentials');
  });

  it('treats a missing PR number in an existing repository as null', async () => {
    const transport = new GhCli();

    // GitHub answers with partial data: the repository, but no PR, and a NOT_FOUND error.
    vi.spyOn(transport, 'request').mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        data: { repository: { pullRequest: null } },
        errors: [
          {
            type: 'NOT_FOUND',
            message: 'Could not resolve to a PullRequest with the number of 9999.',
          },
        ],
      },
    });

    expect(await new GitHub(transport).resolvePull('acme/api', 9999)).toBeNull();
  });

  it('partitions searches above GitHub’s 1,000-result limit', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ search: { issueCount: 1001, ...connection([]) } })
      .mockResolvedValueOnce({ search: { issueCount: 1, ...connection([{ id: 'older' }]) } })
      .mockResolvedValueOnce({ search: { issueCount: 1, ...connection([{ id: 'newer' }]) } });
    const github = new GitHub({ graphql, rest: vi.fn() });

    expect(await github.discover('me', 'requested')).toEqual(['older', 'newer']);
    expect(graphql.mock.calls[1][1].query).toContain('created:>=');
    expect(graphql.mock.calls[2][1].query).toContain('created:<');
  });

  it('fully retrieves nested reviews, threads, comments, files, and CI pages', async () => {
    const graphql = vi.fn(async (query: string, variables: Record<string, unknown> = {}) => {
      if (query.includes('query Snapshot')) return { node: rawSnapshot() };
      if (query.includes('query Comments'))
        return {
          node: {
            comments: connection([
              {
                id: 'reply',
                body: 'Fixed',
                author: null,
                createdAt: '2026-11-05T09:00:00Z',
                updatedAt: '2026-11-05T09:00:00Z',
                url: 'https://github.com/reply',
                replyTo: { id: 'comment-1' },
              },
            ]),
          },
        };
      if (query.includes('query Checks'))
        return {
          node: {
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: connection([
                        {
                          __typename: 'CheckRun',
                          name: 'tests',
                          status: 'IN_PROGRESS',
                          conclusion: null,
                        },
                      ]),
                    },
                  },
                },
              ],
            },
          },
        };
      if (variables.cursor === 'review-cursor')
        return {
          node: {
            reviews: connection([
              {
                id: 'review',
                state: 'CHANGES_REQUESTED',
                submittedAt: '2026-11-05T08:00:00Z',
                updatedAt: '2026-11-05T08:00:00Z',
                body: 'Fix it',
                url: 'https://github.com/review',
                commit: { oid: 'old-head' },
              },
            ]),
          },
        };
      if (variables.cursor === 'thread-cursor')
        return {
          node: {
            reviewThreads: connection([
              {
                id: 'thread-2',
                isResolved: false,
                isOutdated: true,
                path: 'b.ts',
                line: null,
                comments: connection([]),
              },
            ]),
          },
        };
      if (variables.cursor === 'file-cursor')
        return { node: { files: connection([{ path: 'b.ts', additions: 0, deletions: 2 }]) } };

      throw new Error(`Unexpected query: ${query}`);
    });
    const github = new GitHub({ graphql, rest: vi.fn() } as unknown as GitHubTransport);
    const pr = await github.snapshot('pr-1', 'me', ['requested']);

    expect(pr.reviews).toHaveLength(1);
    expect(pr.threads).toHaveLength(2);
    expect(pr.threads[0].comments).toHaveLength(2);
    expect(pr.threads[0].comments[1].author.login).toBe('deleted-user');
    expect(pr.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(pr.checks).toHaveLength(2);
    expect(pr.ci).toBe('pending');
    expect(pr.reviewRequests[0].login).toBe('acme/team');
    expect(graphql).toHaveBeenCalledTimes(6);
  });

  it('surfaces unavailable PRs without claiming they were closed', async () => {
    const github = new GitHub({
      graphql: vi.fn().mockResolvedValue({ node: null }),
      rest: vi.fn(),
    });

    await expect(github.snapshot('missing', 'me', [])).rejects.toThrow(
      'cached record was retained',
    );
  });

  it('redacts GitHub tokens from diagnostic errors', () => {
    expect(safeError(new Error('failed with gho_abc123SECRET'))).toBe('failed with [redacted]');
  });
});
