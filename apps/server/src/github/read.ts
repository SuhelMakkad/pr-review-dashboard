import type {
  Actor,
  Check,
  CiState,
  DiffSide,
  PullFile,
  PullRequestSnapshot,
  RequestEvent,
  Reviewer,
  ReviewState,
  Source,
  ThreadComment,
} from '@review-desk/shared/types';
import { createHash } from 'node:crypto';
import { SNAPSHOT_VERSION } from '@review-desk/shared/snapshot';
import type {
  BlobText,
  CompareResult,
  DetectResult,
  GitHubApi,
  RateBudget,
  RemoteFile,
} from './api.js';
import { GitHubError } from './errors.js';
import {
  blobsQuery,
  checksPageQuery,
  connectionPageQuery,
  detectQuery,
  discoverQuery,
  historyQuery,
  searchQuery,
  identityQuery,
  snapshotQuery,
  threadCommentsQuery,
  type ConnectionKey,
} from './queries.js';
import { GhCli, type GitHubTransport } from './transport.js';
import { createWriter, type GitHubWrites, type ThreadInput } from './write.js';
import type { ReviewEvent } from '@review-desk/shared/review';

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
interface RawComment extends Omit<ThreadComment, 'replyToId' | 'commitOid' | 'originalCommitOid'> {
  replyTo: { id: string } | null;
  commit?: { oid: string } | null;
  originalCommit?: { oid: string } | null;
}
interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  diffSide?: DiffSide;
  startLine?: number | null;
  originalLine?: number | null;
  subjectType?: 'LINE' | 'FILE';
  viewerCanReply?: boolean;
  viewerCanResolve?: boolean;
  comments: Connection<RawComment>;
}
interface RawConversationComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  author: Actor | null;
}
interface RawForcePush {
  id?: string;
  createdAt?: string;
  beforeCommit?: { oid: string } | null;
  afterCommit?: { oid: string } | null;
  actor?: { login: string } | null;
}
interface RawVerdict {
  state: string;
  submittedAt: string | null;
  author: { login: string } | null;
  commit: { oid: string } | null;
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
  baseRefOid?: string | null;
  mergeStateStatus?: string | null;
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
  files: Connection<PullFile>;
  verdicts?: { nodes: RawVerdict[] };
  conversation?: { nodes: RawConversationComment[] };
  pending?: { nodes: { id: string; createdAt: string; comments: { totalCount: number } }[] };
  forcePushes?: { nodes: RawForcePush[] };
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

interface RawRestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  sha: string | null;
}

interface RawCompare {
  status: CompareResult['status'];
  merge_base_commit?: { sha: string };
  files?: RawRestFile[];
  commits?: { sha: string; parents: { sha: string }[] }[];
}

const restFile = (file: RawRestFile): RemoteFile => ({
  path: file.filename,
  previousPath: file.previous_filename,
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  patch: file.patch,
  sha: file.sha,
});

interface RawHistory {
  id: string;
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: Actor | null;
  state: PullRequestSnapshot['state'];
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  timelineItems: { nodes: RawEvent[] };
  reviews: { nodes: RawReview[] };
  verdicts: { nodes: RawVerdict[] };
}

/** A partial snapshot with only what review history needs; everything else is empty. */
function historySnapshot(raw: RawHistory): PullRequestSnapshot {
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    body: '',
    repository: raw.repository.nameWithOwner,
    author: raw.author ?? { login: 'deleted-user' },
    isDraft: raw.isDraft,
    state: raw.state,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    headOid: raw.headRefOid,
    headCommittedAt: raw.updatedAt,
    headObservedAt: raw.updatedAt,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewDecision: null,
    mergeable: 'UNKNOWN',
    sources: [],
    reviewRequests: [],
    requestEvents: raw.timelineItems.nodes
      .filter((event) => event?.id)
      .map((event) => ({
        id: event.id,
        createdAt: event.createdAt,
        removed: event.__typename === 'ReviewRequestRemovedEvent',
        reviewer: reviewer(event.requestedReviewer),
      })),
    reviews: raw.reviews.nodes
      .filter((review) => review.submittedAt && review.state !== 'PENDING')
      .map((review) => ({
        id: review.id,
        state: review.state as ReviewState,
        submittedAt: review.submittedAt!,
        updatedAt: review.updatedAt,
        commitOid: review.commit?.oid ?? null,
        body: '',
        url: review.url,
      })),
    threads: [],
    files: [],
    checks: [],
    ci: 'none',
    fetchedAt: new Date().toISOString(),
    baseOid: null,
    mergeStateStatus: null,
    conversation: [],
    forcePushes: [],
    verdicts: raw.verdicts.nodes
      .filter((verdict) => verdict?.author && verdict.submittedAt)
      .map((verdict) => ({
        login: verdict.author!.login,
        state: verdict.state as ReviewState,
        submittedAt: verdict.submittedAt!,
        commitOid: verdict.commit?.oid ?? null,
      })),
    pendingReview: null,
  };
}

const searchQualifiers: Record<Source, string> = {
  requested: 'review-requested',
  assigned: 'assignee',
  reviewed: 'reviewed-by',
  authored: 'author',
  mentioned: 'mentions',
};

interface RawDetect {
  id: string;
  state: PullRequestSnapshot['state'];
  isDraft: boolean;
  updatedAt: string;
  headRefOid: string;
  baseRefOid: string | null;
  mergeStateStatus: string | null;
  mergeable: string;
  reviewDecision: string | null;
  commits: { nodes: { commit: { statusCheckRollup: unknown } }[] };
  timelineItems: { totalCount: number };
  reviewThreads: { totalCount: number };
  comments: { totalCount: number };
  reviews: { totalCount: number };
}

/** Stable digest of everything Detect returns for one PR. */
export function fingerprintOf(node: RawDetect): string {
  return createHash('sha256').update(JSON.stringify(node)).digest('hex').slice(0, 32);
}

export class GitHub implements GitHubApi {
  private readonly writes: GitHubWrites;

  constructor(readonly transport: GitHubTransport = new GhCli()) {
    this.writes = createWriter(transport);
  }

  addPendingReview(prId: string, commitOid: string) {
    return this.writes.addPendingReview(prId, commitOid);
  }

  addReviewThread(reviewId: string, thread: ThreadInput) {
    return this.writes.addReviewThread(reviewId, thread);
  }

  submitReview(reviewId: string, event: ReviewEvent, body: string) {
    return this.writes.submitReview(reviewId, event, body);
  }

  deleteReview(reviewId: string) {
    return this.writes.deleteReview(reviewId);
  }

  commentNow(prId: string, commitOid: string, thread: ThreadInput) {
    return this.writes.commentNow(prId, commitOid, thread);
  }

  replyToThread(threadId: string, body: string) {
    return this.writes.replyToThread(threadId, body);
  }

  setThreadResolved(threadId: string, resolved: boolean) {
    return this.writes.setThreadResolved(threadId, resolved);
  }

  setFileViewed(prId: string, path: string, viewed: boolean) {
    return this.writes.setFileViewed(prId, path, viewed);
  }

  addConversationComment(prId: string, body: string) {
    return this.writes.addConversationComment(prId, body);
  }

  requestReviews(prId: string, logins: string[]) {
    return this.writes.requestReviews(prId, logins);
  }

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
    const qualifier = searchQualifiers[source];
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

  async detect(ids: string[]): Promise<{ results: DetectResult[]; budget: RateBudget | null }> {
    const results: DetectResult[] = [];
    let budget: RateBudget | null = null;

    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50);
      const data = await this.transport.graphql<{
        rateLimit: RateBudget | null;
        nodes: (RawDetect | null)[];
      }>(detectQuery, { ids: batch });

      budget = data.rateLimit ?? budget;

      batch.forEach((id, index) => {
        const node = data.nodes[index];

        results.push(
          node?.id
            ? { id, state: node.state, fingerprint: fingerprintOf(node) }
            : { id, state: null, fingerprint: null },
        );
      });
    }

    return { results, budget };
  }

  async searchPullIds(query: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;

    // Callers keep each query under GitHub's 1,000-result cap (e.g. one month at a time).
    do {
      const result: { search: Connection<{ id?: string }> } = await this.transport.graphql(
        searchQuery,
        { query, cursor },
      );

      ids.push(...result.search.nodes.filter((node) => node?.id).map((node) => node.id!));
      cursor = result.search.pageInfo.hasNextPage ? result.search.pageInfo.endCursor : null;
    } while (cursor && ids.length < 1000);

    return [...new Set(ids)];
  }

  async history(ids: string[], login: string): Promise<PullRequestSnapshot[]> {
    const snapshots: PullRequestSnapshot[] = [];

    for (let start = 0; start < ids.length; start += 20) {
      const data = await this.transport.graphql<{ nodes: (RawHistory | null)[] }>(historyQuery, {
        ids: ids.slice(start, start + 20),
        login,
      });

      for (const raw of data.nodes) if (raw?.id) snapshots.push(historySnapshot(raw));
    }

    return snapshots;
  }

  private requireRequest() {
    if (!this.transport.request) throw new GitHubError('This GitHub transport cannot fetch diffs.');

    return this.transport.request.bind(this.transport);
  }

  async pullFiles(repository: string, number: number): Promise<RemoteFile[]> {
    const request = this.requireRequest();
    const files: RemoteFile[] = [];

    // GitHub caps this endpoint at 3,000 files (30 pages of 100).
    for (let page = 1; page <= 30; page++) {
      const response = await request<RawRestFile[]>({
        path: `repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
      });

      if (response.status >= 400)
        throw new GitHubError(
          `Could not load files (HTTP ${response.status}).`,
          null,
          response.status,
        );

      files.push(...response.data.map(restFile));

      if (response.data.length < 100 || !/rel="next"/.test(response.headers.link ?? '')) break;
    }

    return files;
  }

  async compare(repository: string, base: string, head: string): Promise<CompareResult | null> {
    const request = this.requireRequest();
    const response = await request<RawCompare>({
      path: `repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`,
    });

    if (response.status === 404 || response.status === 422) return null;
    if (response.status >= 400)
      throw new GitHubError(
        `Could not compare commits (HTTP ${response.status}).`,
        null,
        response.status,
      );

    return {
      status: response.data.status,
      mergeBaseOid: response.data.merge_base_commit?.sha ?? null,
      files: (response.data.files ?? []).map(restFile),
      commits: (response.data.commits ?? []).map((commit) => ({
        oid: commit.sha,
        parents: commit.parents.map((parent) => parent.sha),
      })),
    };
  }

  async blobs(
    repository: string,
    requests: { oid: string; path: string }[],
  ): Promise<(BlobText | null)[]> {
    const [owner, name] = repository.split('/');
    const results: (BlobText | null)[] = [];

    for (let start = 0; start < requests.length; start += 25) {
      const batch = requests.slice(start, start + 25);
      const variables: Record<string, string> = { owner, name };

      batch.forEach((item, index) => {
        variables[`e${index}`] = `${item.oid}:${item.path}`;
      });

      const data = await this.transport.graphql<{
        repository: Record<string, BlobText | null> | null;
      }>(blobsQuery(batch.length), variables);

      batch.forEach((_, index) => {
        const blob = data.repository?.[`b${index}`];

        results.push(blob && 'byteSize' in blob ? blob : null);
      });
    }

    return results;
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
        comments: thread.comments.nodes
          .filter(Boolean)
          .map(({ replyTo, commit, originalCommit, ...comment }) => ({
            ...comment,
            author: comment.author ?? { login: 'deleted-user' },
            replyToId: replyTo?.id ?? null,
            commitOid: commit?.oid ?? null,
            originalCommitOid: originalCommit?.oid ?? null,
          })),
      })),
      files,
      checks: rawChecks.filter(Boolean).map(check),
      ci: ciState(commit?.statusCheckRollup?.state ?? ''),
      fetchedAt: now,
      version: SNAPSHOT_VERSION,
      baseOid: raw.baseRefOid ?? null,
      mergeStateStatus: raw.mergeStateStatus ?? null,
      conversation: (raw.conversation?.nodes ?? []).filter(Boolean).map((comment) => ({
        ...comment,
        author: comment.author ?? { login: 'deleted-user' },
      })),
      forcePushes: (raw.forcePushes?.nodes ?? [])
        .filter((event): event is Required<Pick<RawForcePush, 'id' | 'createdAt'>> & RawForcePush =>
          Boolean(event?.id),
        )
        .map((event) => ({
          id: event.id,
          createdAt: event.createdAt,
          beforeOid: event.beforeCommit?.oid ?? null,
          afterOid: event.afterCommit?.oid ?? null,
          actor: event.actor?.login ?? null,
        })),
      verdicts: (raw.verdicts?.nodes ?? [])
        .filter((verdict) => verdict?.author && verdict.submittedAt)
        .map((verdict) => ({
          login: verdict.author!.login,
          state: verdict.state as ReviewState,
          submittedAt: verdict.submittedAt!,
          commitOid: verdict.commit?.oid ?? null,
        })),
      pendingReview: raw.pending?.nodes[0]
        ? {
            id: raw.pending.nodes[0].id,
            createdAt: raw.pending.nodes[0].createdAt,
            commentCount: raw.pending.nodes[0].comments.totalCount,
          }
        : null,
    };
  }
}
