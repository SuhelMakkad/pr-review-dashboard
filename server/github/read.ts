import type {
  Actor,
  Check,
  CiState,
  PullRequestSnapshot,
  RequestEvent,
  Reviewer,
  ReviewState,
  Source,
  ThreadComment,
} from '../../shared/types.js';
import type { GitHubApi } from './api.js';
import { GitHubError } from './errors.js';
import {
  checksPageQuery,
  connectionPageQuery,
  discoverQuery,
  identityQuery,
  snapshotQuery,
  threadCommentsQuery,
  type ConnectionKey,
} from './queries.js';
import { GhCli, type GitHubTransport } from './transport.js';

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}
interface RawReviewer {
  __typename: string;
  login?: string;
  name?: string;
  slug?: string;
  organization?: { login: string };
}
interface RawReview {
  id: string;
  state: string;
  submittedAt: string | null;
  updatedAt: string;
  body: string;
  url: string;
  commit: { oid: string } | null;
}
interface RawComment extends Omit<ThreadComment, 'replyToId'> {
  replyTo: { id: string } | null;
}
interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: Connection<RawComment>;
}
interface RawEvent {
  __typename: string;
  id: string;
  createdAt: string;
  requestedReviewer: RawReviewer | null;
}
interface RawCheck {
  __typename: string;
  name?: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
}
interface RawPr {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  author: Actor | null;
  isDraft: boolean;
  state: PullRequestSnapshot['state'];
  createdAt: string;
  updatedAt: string;
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  mergeable: string;
  repository: { nameWithOwner: string };
  reviews: Connection<RawReview>;
  reviewRequests: Connection<{ requestedReviewer: RawReviewer | null }>;
  timelineItems: Connection<RawEvent>;
  reviewThreads: Connection<RawThread>;
  files: Connection<{ path: string; additions: number; deletions: number }>;
  commits: {
    nodes: {
      commit: {
        committedDate: string;
        statusCheckRollup: { state: string; contexts: Connection<RawCheck> } | null;
      };
    }[];
  };
}

function reviewer(raw: RawReviewer | null): Reviewer | null {
  if (!raw) return null;

  return raw.__typename === 'Team'
    ? {
        kind: 'team',
        login: `${raw.organization?.login}/${raw.slug}`,
        name: raw.name ?? raw.slug ?? 'Team',
      }
    : { kind: 'user', login: raw.login ?? 'unknown', name: raw.login ?? 'unknown' };
}

function check(raw: RawCheck): Check {
  if (raw.__typename === 'StatusContext') {
    return {
      name: raw.context ?? 'Status',
      state: ciState(raw.state ?? ''),
      url: raw.targetUrl ?? null,
    };
  }

  const success = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(raw.conclusion ?? '');
  const state: CiState = raw.status !== 'COMPLETED' ? 'pending' : success ? 'success' : 'failure';

  return { name: raw.name ?? 'Check', state, url: raw.detailsUrl ?? null };
}

export function ciState(state: string): CiState {
  if (state === 'SUCCESS' || state === 'EXPECTED')
    return state === 'SUCCESS' ? 'success' : 'pending';
  if (state === 'FAILURE' || state === 'ERROR') return 'failure';
  if (state === 'PENDING') return 'pending';

  return 'none';
}

export class GitHub implements GitHubApi {
  constructor(readonly transport: GitHubTransport = new GhCli()) {}

  async identity(): Promise<Actor> {
    const result = await this.transport.graphql<{ viewer: Actor }>(identityQuery);

    return result.viewer;
  }

  async teams(): Promise<string[]> {
    const teams: string[] = [];

    for (let page = 1; ; page++) {
      const batch = await this.transport.rest<{ slug: string; organization: { login: string } }[]>(
        `user/teams?per_page=100&page=${page}`,
      );

      teams.push(...batch.map((team) => `${team.organization.login}/${team.slug}`));

      if (batch.length < 100) return teams;
    }
  }

  async discover(login: string, source: Source): Promise<string[]> {
    const qualifier =
      source === 'requested'
        ? 'review-requested'
        : source === 'assigned'
          ? 'assignee'
          : 'reviewed-by';
    const base = `is:pr is:open ${qualifier}:${login}`;
    const search = async (query: string, start: number, end: number): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;

      do {
        const result: { search: Connection<{ id: string }> & { issueCount: number } } =
          await this.transport.graphql(discoverQuery, { query, cursor });

        if (result.search.issueCount > 1000) {
          const middle = Math.floor((start + end) / 2000) * 1000;

          if (middle <= start || middle >= end)
            throw new GitHubError(
              `Search coverage incomplete: more than 1,000 PRs in a single second for ${source}.`,
            );

          const range = (from: number, to: number) =>
            `${base} created:>=${new Date(from).toISOString()} created:<${new Date(to).toISOString()}`;
          const left = await search(range(start, middle), start, middle);
          const right = await search(range(middle, end), middle, end);

          return [...left, ...right];
        }

        ids.push(...result.search.nodes.filter(Boolean).map((node) => node.id));
        cursor = result.search.pageInfo.endCursor;

        if (!result.search.pageInfo.hasNextPage) break;
        if (!cursor) throw new GitHubError('Search pagination was incomplete.');
      } while (cursor);

      return ids;
    };

    return [...new Set(await search(base, Date.UTC(2008, 0, 1), Date.now() + 86_400_000))];
  }

  private async collect<T>(
    id: string,
    login: string,
    key: ConnectionKey,
    first: Connection<T>,
  ): Promise<T[]> {
    const nodes = [...first.nodes];
    let page = first.pageInfo;

    while (page.hasNextPage) {
      if (!page.endCursor) throw new GitHubError(`Incomplete ${key} pagination.`);

      const result = await this.transport.graphql<{ node: Record<string, Connection<T>> }>(
        connectionPageQuery(key),
        { id, login, cursor: page.endCursor },
      );
      const next = result.node?.[key];

      if (!next) throw new GitHubError(`Unable to retrieve ${key}.`);

      nodes.push(...next.nodes);
      page = next.pageInfo;
    }

    return nodes.filter(Boolean);
  }

  async snapshot(
    id: string,
    login: string,
    sources: Source[],
    previous?: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot> {
    const result = await this.transport.graphql<{ node: RawPr | null }>(snapshotQuery, {
      id,
      login,
      cursor: null,
    });
    const raw = result.node;

    if (!raw)
      throw new GitHubError(
        `PR ${previous?.number ?? id} is unavailable; its cached record was retained.`,
      );

    const reviews = await this.collect(id, login, 'reviews', raw.reviews);
    const requests = await this.collect(id, login, 'reviewRequests', raw.reviewRequests);
    const events = await this.collect(id, login, 'timelineItems', raw.timelineItems);
    const threads = await this.collect(id, login, 'reviewThreads', raw.reviewThreads);
    const files = await this.collect(id, login, 'files', raw.files);

    for (const thread of threads) {
      while (thread.comments.pageInfo.hasNextPage) {
        const page = await this.transport.graphql<{ node: { comments: Connection<RawComment> } }>(
          threadCommentsQuery,
          { id: thread.id, cursor: thread.comments.pageInfo.endCursor },
        );

        thread.comments.nodes.push(...page.node.comments.nodes);
        thread.comments.pageInfo = page.node.comments.pageInfo;
      }
    }

    const commit = raw.commits.nodes[0]?.commit;
    const contexts = commit?.statusCheckRollup?.contexts;
    const rawChecks = contexts ? [...contexts.nodes] : [];
    let checkPage = contexts?.pageInfo;

    while (checkPage?.hasNextPage) {
      const page = await this.transport.graphql<{ node: { commits: RawPr['commits'] } }>(
        checksPageQuery,
        { id, cursor: checkPage.endCursor },
      );
      const next = page.node.commits.nodes[0]?.commit.statusCheckRollup?.contexts;

      if (!next) throw new GitHubError('CI pagination was incomplete.');

      rawChecks.push(...next.nodes);
      checkPage = next.pageInfo;
    }

    const now = new Date().toISOString();
    const lastReview = reviews
      .filter((review) => review.submittedAt)
      .sort((a, b) => Date.parse(b.submittedAt!) - Date.parse(a.submittedAt!))[0];
    const reconstructedHeadTime =
      lastReview?.submittedAt &&
      commit?.committedDate &&
      commit.committedDate > lastReview.submittedAt
        ? commit.committedDate
        : raw.updatedAt;

    return {
      id: raw.id,
      number: raw.number,
      title: raw.title,
      url: raw.url,
      body: raw.body,
      repository: raw.repository.nameWithOwner,
      author: raw.author ?? { login: 'deleted-user' },
      isDraft: raw.isDraft,
      state: raw.state,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      headOid: raw.headRefOid,
      headCommittedAt: commit?.committedDate ?? raw.updatedAt,
      headObservedAt:
        previous?.headOid === raw.headRefOid
          ? previous.headObservedAt
          : previous
            ? now
            : reconstructedHeadTime,
      baseRefName: raw.baseRefName,
      headRefName: raw.headRefName,
      additions: raw.additions,
      deletions: raw.deletions,
      changedFiles: raw.changedFiles,
      reviewDecision: raw.reviewDecision,
      mergeable: raw.mergeable,
      sources,
      reviewRequests: requests
        .map((request) => reviewer(request.requestedReviewer))
        .filter((value): value is Reviewer => Boolean(value)),
      requestEvents: events.map((event): RequestEvent => ({
        id: event.id,
        createdAt: event.createdAt,
        removed: event.__typename === 'ReviewRequestRemovedEvent',
        reviewer: reviewer(event.requestedReviewer),
      })),
      reviews: reviews
        .filter((review) => review.submittedAt && review.state !== 'PENDING')
        .map((review) => ({
          id: review.id,
          state: review.state as ReviewState,
          submittedAt: review.submittedAt!,
          updatedAt: review.updatedAt,
          commitOid: review.commit?.oid ?? null,
          body: review.body,
          url: review.url,
        })),
      threads: threads.map((thread) => ({
        ...thread,
        comments: thread.comments.nodes.filter(Boolean).map((comment) => ({
          ...comment,
          author: comment.author ?? { login: 'deleted-user' },
          replyToId: comment.replyTo?.id ?? null,
        })),
      })),
      files,
      checks: rawChecks.filter(Boolean).map(check),
      ci: ciState(commit?.statusCheckRollup?.state ?? ''),
      fetchedAt: now,
    };
  }
}
