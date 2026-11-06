import { describe, expect, it, vi } from 'vitest';
import { GitHub, type GitHubTransport, safeError } from '@/github/index.js';

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
