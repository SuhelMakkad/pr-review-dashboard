import { SNAPSHOT_VERSION } from '../../shared/snapshot.js';
import type { ReviewEvent } from '../../shared/review.js';
import type { Actor, PullRequestSnapshot, ReviewState, Source } from '../../shared/types.js';
import type { ThreadInput } from '../github/write.js';
import { createHash } from 'node:crypto';
import type {
  BlobText,
  CompareResult,
  DetectResult,
  GitHubApi,
  RateBudget,
  RemoteFile,
} from '../github/api.js';
import { GitHubError } from '../github/errors.js';
import { demoHistory } from './history.js';
import type { Scenario } from './scenario.js';

/** A GitHub stand-in backed by an in-memory scenario. Used by demo mode and end-to-end tests. */
export interface FixtureWrite {
  op: string;
  at: string;
  details: Record<string, unknown>;
}

const reviewStates: Record<ReviewEvent, ReviewState> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
};

/** A GitHub stand-in backed by an in-memory scenario. Used by demo mode and end-to-end tests. */
export class FixtureGitHub implements GitHubApi {
  private stepIndex = 0;
  private sequence = 0;
  /** Every write GitHub would have received, for assertions in tests. */
  readonly writes: FixtureWrite[] = [];
  /** The next write with this op name fails once (failure injection for tests). */
  failNext: string | null = null;
  private readonly pending = new Map<
    string,
    { prId: string; commitOid: string; threads: ThreadInput[] }
  >();
  scenario: Scenario;
  private history_: PullRequestSnapshot[] = [];

  constructor(private readonly source: Scenario | (() => Scenario)) {
    this.scenario = typeof source === 'function' ? source() : source;
    this.history_ = demoHistory(this.scenario.world.now(), this.scenario.world.viewer.login);
  }

  /** Rebuilds the scenario from scratch (demo reset; requires a factory). */
  reset(): void {
    if (typeof this.source !== 'function') throw new Error('Reset needs a scenario factory.');

    this.scenario = this.source();
    this.stepIndex = 0;
    this.writes.length = 0;
    this.pending.clear();
    this.failNext = null;
  }

  async identity(): Promise<Actor> {
    return { ...this.scenario.world.viewer };
  }

  async teams(): Promise<string[]> {
    return [...this.scenario.world.teams];
  }

  async discover(_login: string, source: Source): Promise<string[]> {
    return this.scenario.world.pulls
      .filter((pull) => pull.snapshot.state === 'OPEN' && pull.feeds.includes(source))
      .map((pull) => pull.snapshot.id);
  }

  async detect(ids: string[]): Promise<{ results: DetectResult[]; budget: RateBudget | null }> {
    const results = ids.map((id): DetectResult => {
      const pull = this.scenario.world.pulls.find((item) => item.snapshot.id === id);

      return pull
        ? {
            id,
            state: pull.snapshot.state,
            fingerprint: createHash('sha256')
              .update(JSON.stringify(pull.snapshot))
              .digest('hex')
              .slice(0, 32),
          }
        : { id, state: null, fingerprint: null };
    });

    return {
      results,
      budget: {
        limit: 5000,
        remaining: 4900,
        resetAt: new Date(this.scenario.world.now() + 3_600_000).toISOString(),
        cost: 1,
      },
    };
  }

  async snapshot(
    id: string,
    _login: string,
    sources: Source[],
    previous?: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot> {
    const pull = this.scenario.world.pulls.find((item) => item.snapshot.id === id);

    if (!pull)
      throw new GitHubError(
        `PR ${previous?.number ?? id} is unavailable; its cached record was retained.`,
      );

    const now = new Date(this.scenario.world.now()).toISOString();
    const snapshot = structuredClone(pull.snapshot);
    const files = this.pullFilesSync(snapshot.repository, snapshot.number);
    const viewed = this.scenario.world.viewed.get(id);

    snapshot.files = files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status.toUpperCase(),
      viewerViewedState: viewed?.get(file.path) ?? 'UNVIEWED',
    }));
    snapshot.changedFiles = files.length;
    snapshot.additions = files.reduce((sum, file) => sum + file.additions, 0);
    snapshot.deletions = files.reduce((sum, file) => sum + file.deletions, 0);

    return {
      ...snapshot,
      version: SNAPSHOT_VERSION,
      sources,
      fetchedAt: now,
      headObservedAt:
        previous?.headOid === snapshot.headOid
          ? previous.headObservedAt
          : previous
            ? now
            : snapshot.headCommittedAt,
    };
  }

  private pullFilesSync(repository: string, number: number): RemoteFile[] {
    const pull = this.scenario.world.pulls.find(
      (item) => item.snapshot.repository === repository && item.snapshot.number === number,
    );

    if (!pull) throw new GitHubError(`No demo PR ${repository}#${number}.`);

    return (
      this.scenario.world.repos.compare(repository, 'main', pull.snapshot.headOid)?.files ?? []
    );
  }

  async pullFiles(repository: string, number: number): Promise<RemoteFile[]> {
    return this.pullFilesSync(repository, number);
  }

  async compare(repository: string, base: string, head: string): Promise<CompareResult | null> {
    return this.scenario.world.repos.compare(repository, base, head);
  }

  async blobs(
    repository: string,
    requests: { oid: string; path: string }[],
  ): Promise<(BlobText | null)[]> {
    return requests.map((request) =>
      this.scenario.world.repos.blob(repository, request.oid, request.path),
    );
  }

  private nextId(prefix: string) {
    this.sequence += 1;

    return `${prefix}-${this.sequence}`;
  }

  private now() {
    return new Date(this.scenario.world.now()).toISOString();
  }

  private record(op: string, details: Record<string, unknown>) {
    if (this.failNext === op) {
      this.failNext = null;
      throw new GitHubError(`Injected failure for ${op}.`);
    }

    this.writes.push({ op, at: this.now(), details });
  }

  private pullById(prId: string) {
    const pull = this.scenario.world.pulls.find((item) => item.snapshot.id === prId);

    if (!pull)
      throw new GitHubError(`Could not resolve to a PullRequest with the global id of '${prId}'.`);

    return pull;
  }

  private threadById(threadId: string) {
    for (const pull of this.scenario.world.pulls) {
      const thread = pull.snapshot.threads.find((candidate) => candidate.id === threadId);

      if (thread) return { pull, thread };
    }

    throw new GitHubError(
      `Could not resolve to a PullRequestReviewThread with the global id of '${threadId}'.`,
    );
  }

  async addPendingReview(prId: string, commitOid: string): Promise<string> {
    this.pullById(prId);
    this.record('AddPendingReview', { prId, commitOid });

    const id = this.nextId('pending-review');

    this.pending.set(id, { prId, commitOid, threads: [] });

    return id;
  }

  async addReviewThread(reviewId: string, thread: ThreadInput): Promise<string> {
    const review = this.pending.get(reviewId);

    if (!review) throw new GitHubError('Pending review not found.');

    this.record('AddReviewThread', { reviewId, ...thread });
    review.threads.push(thread);

    return this.nextId('draft-thread');
  }

  async submitReview(reviewId: string, event: ReviewEvent, body: string) {
    const review = this.pending.get(reviewId);

    if (!review) throw new GitHubError('Pending review not found.');

    this.record('SubmitReview', { reviewId, event, body, comments: review.threads.length });

    const pull = this.pullById(review.prId);
    const now = this.now();
    const id = this.nextId('review');
    const login = this.scenario.world.viewer.login;

    pull.snapshot.reviews.push({
      id,
      state: reviewStates[event],
      submittedAt: now,
      updatedAt: now,
      commitOid: review.commitOid,
      body,
      url: `${pull.snapshot.url}#pullrequestreview-${id}`,
    });

    for (const thread of review.threads) {
      const commentId = this.nextId('comment');

      pull.snapshot.threads.push({
        id: this.nextId('thread'),
        isResolved: false,
        isOutdated: false,
        path: thread.path,
        line: thread.line ?? null,
        diffSide: thread.side ?? 'RIGHT',
        startLine: thread.startLine ?? null,
        subjectType: thread.line ? 'LINE' : 'FILE',
        viewerCanReply: true,
        viewerCanResolve: true,
        comments: [
          {
            id: commentId,
            author: { login },
            body: thread.body,
            createdAt: now,
            updatedAt: now,
            url: `${pull.snapshot.url}#discussion_${commentId}`,
            replyToId: null,
          },
        ],
      });
    }

    pull.snapshot.reviewRequests = pull.snapshot.reviewRequests.filter(
      (reviewer) => reviewer.login !== login,
    );
    pull.snapshot.updatedAt = now;
    this.pending.delete(reviewId);

    return { id, url: `${pull.snapshot.url}#pullrequestreview-${id}` };
  }

  async deleteReview(reviewId: string): Promise<void> {
    this.record('DeleteReview', { reviewId });
    this.pending.delete(reviewId);
  }

  async commentNow(prId: string, commitOid: string, thread: ThreadInput) {
    const reviewId = await this.addPendingReview(prId, commitOid);

    await this.addReviewThread(reviewId, thread);

    return this.submitReview(reviewId, 'COMMENT', '');
  }

  async replyToThread(threadId: string, body: string) {
    const { pull, thread } = this.threadById(threadId);

    this.record('ReplyToThread', { threadId, body });

    const id = this.nextId('comment');
    const now = this.now();

    thread.comments.push({
      id,
      author: { login: this.scenario.world.viewer.login },
      body,
      createdAt: now,
      updatedAt: now,
      url: `${pull.snapshot.url}#discussion_${id}`,
      replyToId: thread.comments[0]?.id ?? null,
    });
    pull.snapshot.updatedAt = now;

    return { id, url: `${pull.snapshot.url}#discussion_${id}`, pending: false };
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    const { pull, thread } = this.threadById(threadId);

    this.record(resolved ? 'ResolveThread' : 'UnresolveThread', { threadId });
    thread.isResolved = resolved;
    pull.snapshot.updatedAt = this.now();
  }

  async setFileViewed(prId: string, path: string, viewed: boolean): Promise<void> {
    this.pullById(prId);
    this.record(viewed ? 'MarkFileViewed' : 'UnmarkFileViewed', { prId, path });

    const files = this.scenario.world.viewed.get(prId) ?? new Map();

    files.set(path, viewed ? 'VIEWED' : 'UNVIEWED');
    this.scenario.world.viewed.set(prId, files);
  }

  async requestReviews(prId: string, logins: string[]): Promise<void> {
    const pull = this.pullById(prId);

    this.record('RequestReviews', { prId, logins });

    const now = this.now();

    for (const login of logins) {
      const reviewer = { kind: 'user' as const, login, name: login };

      if (!pull.snapshot.reviewRequests.some((existing) => existing.login === login)) {
        pull.snapshot.reviewRequests.push(reviewer);
      }

      pull.snapshot.requestEvents.push({
        id: this.nextId('request'),
        createdAt: now,
        removed: false,
        reviewer,
      });
    }

    pull.snapshot.updatedAt = now;
  }

  async addConversationComment(prId: string, body: string) {
    const pull = this.pullById(prId);

    this.record('AddComment', { prId, body });

    const id = this.nextId('conversation');
    const now = this.now();

    pull.snapshot.conversation.push({
      id,
      author: { login: this.scenario.world.viewer.login },
      body,
      createdAt: now,
      updatedAt: now,
      url: `${pull.snapshot.url}#issuecomment-${id}`,
    });
    pull.snapshot.updatedAt = now;

    return { id, url: `${pull.snapshot.url}#issuecomment-${id}` };
  }

  /** Answers the backfill's searches from the scenario plus fictional history. */
  async searchPullIds(query: string): Promise<string[]> {
    const login = this.scenario.world.viewer.login;
    const range = /(updated|created):(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(query);
    const from = range ? Date.parse(range[2]) : 0;
    const to = range ? Date.parse(range[3]) + 24 * 3_600_000 : Infinity;
    const field = range?.[1] === 'created' ? 'createdAt' : 'updatedAt';
    const reviewer = query.includes('reviewed-by:');
    const all = [
      ...this.history_,
      ...this.scenario.world.pulls.map((pull) => pull.snapshot as PullRequestSnapshot),
    ];

    return all
      .filter((pull) =>
        reviewer
          ? pull.reviews.length > 0 && pull.author.login !== login
          : pull.author.login === login,
      )
      .filter((pull) => Date.parse(pull[field]) >= from && Date.parse(pull[field]) < to)
      .map((pull) => pull.id);
  }

  async history(ids: string[]): Promise<PullRequestSnapshot[]> {
    const all = [
      ...this.history_,
      ...this.scenario.world.pulls.map((pull) => pull.snapshot as PullRequestSnapshot),
    ];

    return all
      .filter((pull) => ids.includes(pull.id))
      .map((pull) => structuredClone({ ...pull, sources: pull.sources ?? [] }));
  }

  /** Applies the next scripted change. Returns its label, or null when the script is finished. */
  advance(): string | null {
    const step = this.scenario.steps[this.stepIndex];

    if (!step) return null;

    step.apply(this.scenario.world);
    this.stepIndex += 1;

    return step.label;
  }
}
