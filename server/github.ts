import { spawn } from 'node:child_process';
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
} from '../shared/types.js';

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

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryAt: string | null = null,
  ) {
    super(message);
  }
}

export interface GitHubTransport {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  rest<T>(path: string): Promise<T>;
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.replace(/gh[opusr]_[A-Za-z0-9_]+/g, '[redacted]').slice(0, 600);
}

export class GhCli implements GitHubTransport {
  private run(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, 35_000);

      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(
          new GitHubError(
            `GitHub CLI unavailable: ${safeError(error)}. Install gh and run gh auth login.`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          const message = timedOut
            ? 'GitHub request timed out; cached data is still available.'
            : safeError(stderr.trim() || 'GitHub request failed. Check gh auth status.');
          const rateLimited = /rate limit|secondary rate|abuse|HTTP 429/i.test(message);

          reject(
            new GitHubError(
              message,
              rateLimited ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
            ),
          );
          return;
        }

        resolve(stdout);
      });

      child.stdin.end(input);
    });
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const raw = await this.run(
      ['api', '--hostname', 'github.com', 'graphql', '--input', '-'],
      JSON.stringify({ query, variables }),
    );
    const result = JSON.parse(raw) as { data: T; errors?: { message: string; type?: string }[] };

    if (result.errors?.length) {
      const message = result.errors.map((error) => error.message).join('; ');

      throw new GitHubError(
        message,
        /rate.limit/i.test(message) ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
      );
    }

    return result.data;
  }

  async rest<T>(path: string): Promise<T> {
    return JSON.parse(
      await this.run(['api', '--hostname', 'github.com', '--method', 'GET', path]),
    ) as T;
  }
}

const pageInfo = 'pageInfo { hasNextPage endCursor }';
const reviewerFields =
  '__typename ... on User { login } ... on Team { name slug organization { login } }';
const reviewFields = 'id state submittedAt updatedAt body url commit { oid }';
const commentFields = 'id body createdAt updatedAt url author { login avatarUrl } replyTo { id }';
const threadFields = `id isResolved isOutdated path line comments(first: 100) { nodes { ${commentFields} } ${pageInfo} }`;
const checkFields =
  '__typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }';
const connections: Record<string, string> = {
  reviews: `reviews(first: 100, after: $cursor, author: $login) { nodes { ${reviewFields} } ${pageInfo} }`,
  reviewRequests: `reviewRequests(first: 100, after: $cursor) { nodes { requestedReviewer { ${reviewerFields} } } ${pageInfo} }`,
  timelineItems: `timelineItems(first: 100, after: $cursor, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) { nodes { __typename ... on ReviewRequestedEvent { id createdAt requestedReviewer { ${reviewerFields} } } ... on ReviewRequestRemovedEvent { id createdAt requestedReviewer { ${reviewerFields} } } } ${pageInfo} }`,
  reviewThreads: `reviewThreads(first: 50, after: $cursor) { nodes { ${threadFields} } ${pageInfo} }`,
  files: `files(first: 100, after: $cursor) { nodes { path additions deletions } ${pageInfo} }`,
};

const baseQuery = `query Snapshot($id: ID!, $login: String!, $cursor: String) {
  node(id: $id) { ... on PullRequest {
    id number title url body author { login avatarUrl } repository { nameWithOwner }
    isDraft state createdAt updatedAt headRefOid baseRefName headRefName additions deletions changedFiles reviewDecision mergeable
    ${Object.values(connections).join('\n')}
    commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts(first: 100) { nodes { ${checkFields} } ${pageInfo} } } } } }
  } }
}`;

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

export class GitHub {
  constructor(readonly transport: GitHubTransport = new GhCli()) {}

  async identity(): Promise<Actor> {
    const result = await this.transport.graphql<{ viewer: Actor }>(
      'query Identity { viewer { login avatarUrl } }',
    );

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
          await this.transport.graphql(
            `query Discover($query: String!, $cursor: String) {
          search(query: $query, type: ISSUE, first: 100, after: $cursor) { issueCount nodes { ... on PullRequest { id } } ${pageInfo} }
        }`,
            { query, cursor },
          );

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
    key: keyof typeof connections,
    first: Connection<T>,
  ): Promise<T[]> {
    const nodes = [...first.nodes];
    let page = first.pageInfo;

    while (page.hasNextPage) {
      if (!page.endCursor) throw new GitHubError(`Incomplete ${key} pagination.`);

      const declarations =
        key === 'reviews'
          ? '$id: ID!, $login: String!, $cursor: String'
          : '$id: ID!, $cursor: String';
      const result = await this.transport.graphql<{ node: Record<string, Connection<T>> }>(
        `query Page(${declarations}) {
        node(id: $id) { ... on PullRequest { ${connections[key]} } }
      }`,
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
    const result = await this.transport.graphql<{ node: RawPr | null }>(baseQuery, {
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
          `query Comments($id: ID!, $cursor: String) {
          node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { nodes { ${commentFields} } ${pageInfo} } } }
        }`,
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
        `query Checks($id: ID!, $cursor: String) {
        node(id: $id) { ... on PullRequest { commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100, after: $cursor) { nodes { ${checkFields} } ${pageInfo} } } } } } } }
      }`,
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
