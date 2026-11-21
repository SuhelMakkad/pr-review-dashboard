import { SNAPSHOT_VERSION } from '@review-desk/shared/snapshot';
import { isSameUser } from '@review-desk/shared/accounts';
import type { ReviewEvent } from '@review-desk/shared/review';
import type {
  Actor,
  FeedSource,
  PullRequestSnapshot,
  ReviewState,
  Source,
} from '@review-desk/shared/types';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CliAccount, GitHubAccounts } from '@/github/credentials.js';
import type { ThreadInput } from '@/github/write.js';
import { createHash } from 'node:crypto';
import type {
  BlobText,
  CompareResult,
  DetectResult,
  GitHubApi,
  RateBudget,
  RemoteFile,
  ResolvedPull,
} from '@/github/api.js';
import { GitHubError } from '@/github/errors.js';
import { demoHistory } from '@/demo/history.js';
import type { Scenario } from '@/demo/scenario.js';
import { forgeTraits, type ForgeTraits } from '@review-desk/shared/traits';
import type { HistoryQuery } from '@/forge/port.js';

/** A GitHub stand-in backed by an in-memory scenario. Used by demo mode and end-to-end tests. */
export interface FixtureWrite {
  op: string;
  at: string;
  details: Record<string, unknown>;
}

/**
 * A second fictional sign-in, so demo mode can switch accounts. No feed returns a scenario PR for
 * it, but it can add them by hand (as if the repositories were public), so both accounts can track
 * the same PR.
 */
export const DEMO_SECOND_ACCOUNT = 'you-personal';

const reviewStates: Record<ReviewEvent, ReviewState> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
};

/** The account a bound view's call is answered as (see `FixtureGitHub.as`). */
const answeringAs = new AsyncLocalStorage<string>();

/** A GitHub stand-in backed by an in-memory scenario. Used by demo mode and end-to-end tests. */
export class FixtureGitHub implements GitHubApi, GitHubAccounts {
  private stepIndex = 0;
  /** The account selected in the app; null acts as the scenario's viewer. */
  private selected: string | null = null;
  /** Viewed marks of accounts other than the scenario's viewer, by `account` and PR. */
  private readonly viewedByOthers = new Map<
    string,
    Map<string, 'VIEWED' | 'UNVIEWED' | 'DISMISSED'>
  >();
  /** Every snapshot read, with the account it was answered as: tests check whose a read was. */
  readonly reads: { id: string; account: string }[] = [];
  /** Every file listing, with the account it was answered as. */
  readonly fileReads: { pull: string; account: string }[] = [];
  private sequence = 0;
  /** Every write GitHub would have received, for assertions in tests. */
  readonly writes: FixtureWrite[] = [];
  /**
   * GitHub's traits; tests can change them, for example to send an approval and its summary as
   * GitLab does.
   */
  traits: ForgeTraits = {
    ...forgeTraits.github,
    // Its own copy all the way down: a test that changes one leaves every other fixture alone.
    reference: { ...forgeTraits.github.reference },
  };
  /** How long each PR read takes, so a benchmark can watch the server while a sync runs. */
  readDelayMs = 0;
  /** The next write with this op name fails once (failure injection for tests). */
  failNext: string | null = null;
  loseResponseNext: string | null = null;
  writeDelayMs = 0;
  private readonly pending = new Map<
    string,
    {
      prId: string;
      commitOid: string;
      threads: ThreadInput[];
      replies: {
        threadId: string;
        comment: PullRequestSnapshot['threads'][number]['comments'][number];
      }[];
    }
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
    this.loseResponseNext = null;
    this.writeDelayMs = 0;
    this.selected = null;
  }

  async list(): Promise<CliAccount[]> {
    return [
      {
        login: this.scenario.world.viewer.login,
        forge: 'github',
        host: 'github.com',
        cliActive: true,
        ok: true,
      },
      {
        login: DEMO_SECOND_ACCOUNT,
        forge: 'github',
        host: 'github.com',
        cliActive: false,
        ok: true,
      },
    ];
  }

  select(login: string | null): void {
    this.selected = login;
  }

  /**
   * The fixture answering as `login`, as a client bound to that account's token would: every call
   * through it, and everything that call awaits, is that account's. The fixture keeps one state,
   * so the view runs each call on it with the account it carries.
   */
  as(login: string): GitHubApi {
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (property === 'as') return (other: string) => target.as(other);

        const value = Reflect.get(target, property, receiver);

        return typeof value === 'function'
          ? (...args: unknown[]) => answeringAs.run(login, () => value.apply(target, args))
          : value;
      },
    });
  }

  /** With nothing selected, the scenario's viewer, as the GitHub CLI's own account. */
  async discoverIdentity(): Promise<{ identity: Actor; forge: GitHubApi }> {
    const forge = this.as(this.effective());

    return { identity: await forge.identity(), forge };
  }

  /** The account a call is answered as: the one it is bound to, else the selected one. */
  private effective(): string {
    return answeringAs.getStore() ?? this.selected ?? this.scenario.world.viewer.login;
  }

  /** True while the call is for the second account: no feed or search returns anything for it. */
  private get outsider(): boolean {
    return this.effective() === DEMO_SECOND_ACCOUNT;
  }

  /** An account's viewed marks on a PR: the scenario's own for its viewer. */
  private viewedOf(account: string, prId: string) {
    if (isSameUser(account, this.scenario.world.viewer.login))
      return this.scenario.world.viewed.get(prId);

    return this.viewedByOthers.get(`${account}\u0000${prId}`);
  }

  async identity(): Promise<Actor> {
    return this.outsider ? { login: DEMO_SECOND_ACCOUNT } : { ...this.scenario.world.viewer };
  }

  async teams(): Promise<string[]> {
    return this.outsider ? [] : [...this.scenario.world.teams];
  }

  async discover(_login: string, source: FeedSource): Promise<string[]> {
    if (this.outsider) return [];

    return this.scenario.world.pulls
      .filter((pull) => pull.snapshot.state === 'OPEN' && pull.feeds.includes(source))
      .map((pull) => pull.snapshot.id);
  }

  async resolvePull(repository: string, number: number): Promise<ResolvedPull | null> {
    const pull = this.scenario.world.pulls.find(
      (item) =>
        item.snapshot.repository.toLowerCase() === repository.toLowerCase() &&
        item.snapshot.number === number,
    );

    return pull ? { id: pull.snapshot.id, state: pull.snapshot.state } : null;
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
    // Whose read this is, decided when it starts: a switch during the delay cannot change it.
    const account = this.effective();
    const pull = this.scenario.world.pulls.find((item) => item.snapshot.id === id);

    if (!pull)
      throw new GitHubError(
        `PR ${previous?.number ?? id} is unavailable; its cached record was retained.`,
      );
    if (this.readDelayMs) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));

    this.reads.push({ id, account });

    const now = new Date(this.scenario.world.now()).toISOString();
    const snapshot = structuredClone(pull.snapshot);
    const files = this.pullFilesSync(snapshot.repository, snapshot.number);
    const viewed = this.viewedOf(account, id);

    snapshot.files = files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status.toUpperCase(),
      viewerViewedState: viewed?.get(file.path) ?? 'UNVIEWED',
    }));
    snapshot.changedFiles = files.length;
    snapshot.baseTipOid = this.scenario.world.repos.refOid(
      snapshot.repository,
      snapshot.baseRefName,
    );
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
    this.fileReads.push({ pull: `${repository}#${number}`, account: this.effective() });

    return this.pullFilesSync(repository, number);
  }

  async compare(repository: string, base: string, head: string): Promise<CompareResult | null> {
    return this.scenario.world.repos.compare(repository, base, head);
  }

  async markedComment(prId: string, author: string, marker: string) {
    const pull = this.scenario.world.pulls.find((candidate) => candidate.snapshot.id === prId);
    const found = pull?.snapshot.conversation.find(
      (comment) => isSameUser(comment.author.login, author) && comment.body.startsWith(marker),
    );

    return found ? { id: found.id, url: found.url } : null;
  }

  async branchHead(repository: string, branch: string): Promise<string | null> {
    return this.scenario.world.repos.refOid(repository, branch);
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
      throw new GitHubError(`Injected failure for ${op}.`, null, 422, 'rejected');
    }

    this.writes.push({ op, at: this.now(), details });
  }

  private async beforeWrite() {
    if (this.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
  }

  private receipt<T>(op: string, result: T): T {
    if (this.loseResponseNext === op) {
      this.loseResponseNext = null;
      throw new GitHubError(`Response lost after ${op} was accepted.`);
    }

    return result;
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

  async approveReview(prId: string, commitOid: string, body: string) {
    await this.beforeWrite();
    const pull = this.pullById(prId);
    const id = this.nextId('review');
    const now = this.now();

    this.record('ApproveReview', { prId, commitOid, body });
    pull.snapshot.reviews.push({
      id,
      state: 'APPROVED',
      submittedAt: now,
      updatedAt: now,
      commitOid,
      body,
      url: `${pull.snapshot.url}#pullrequestreview-${id}`,
    });

    pull.snapshot.reviewRequests = pull.snapshot.reviewRequests.filter(
      (reviewer) => reviewer.login !== this.scenario.world.viewer.login,
    );
    // Acting as GitLab, an approval is also a verdict read from its own note.
    if (!this.traits.approvalCarriesSummary)
      pull.snapshot.verdicts.push({
        id: `note-${id}`,
        login: this.scenario.world.viewer.login,
        state: 'APPROVED',
        submittedAt: now,
        commitOid,
      });
    pull.snapshot.updatedAt = now;

    return this.receipt('ApproveReview', {
      id,
      url: `${pull.snapshot.url}#pullrequestreview-${id}`,
    });
  }

  async addPendingReview(prId: string, commitOid: string): Promise<string> {
    await this.beforeWrite();
    this.pullById(prId);
    this.record('AddPendingReview', { prId, commitOid });

    const id = this.nextId('pending-review');

    this.pending.set(id, { prId, commitOid, threads: [], replies: [] });
    this.pullById(prId).snapshot.pendingReview = { id, createdAt: this.now(), commentCount: 0 };

    return this.receipt('AddPendingReview', id);
  }

  async addReviewThread(reviewId: string, thread: ThreadInput): Promise<string> {
    await this.beforeWrite();
    const review = this.pending.get(reviewId);

    if (!review) throw new GitHubError('Pending review not found.');

    this.record('AddReviewThread', { reviewId, ...thread });
    review.threads.push(thread);
    const pending = this.pullById(review.prId).snapshot.pendingReview;
    if (pending) pending.commentCount++;

    return this.receipt('AddReviewThread', this.nextId('draft-thread'));
  }

  async submitReview(reviewId: string, event: ReviewEvent, body: string) {
    await this.beforeWrite();
    const review = this.pending.get(reviewId);

    if (!review) throw new GitHubError('Pending review not found.');

    this.record('SubmitReview', { reviewId, event, body, comments: review.threads.length });

    const pull = this.pullById(review.prId);
    const now = this.now();
    const id = reviewId;
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
    pull.snapshot.pendingReview = null;
    for (const reply of review.replies)
      this.threadById(reply.threadId).thread.comments.push(reply.comment);
    this.pending.delete(reviewId);

    return this.receipt('SubmitReview', {
      id,
      url: `${pull.snapshot.url}#pullrequestreview-${id}`,
    });
  }

  async deleteReview(reviewId: string): Promise<void> {
    await this.beforeWrite();
    this.record('DeleteReview', { reviewId });
    const review = this.pending.get(reviewId);
    if (review) this.pullById(review.prId).snapshot.pendingReview = null;
    this.pending.delete(reviewId);
    this.receipt('DeleteReview', undefined);
  }

  async reviewReceipt(id: string) {
    const pending = this.pending.get(id);

    if (pending) {
      const pull = this.pullById(pending.prId);

      return {
        id,
        state: 'PENDING',
        url: pull.snapshot.url,
        body: '',
        commitOid: pending.commitOid,
        comments: [
          ...pending.threads.map((thread, index) => ({
            id: `${id}-${index}`,
            body: thread.body,
            path: thread.path,
            line: thread.line ?? null,
            url: pull.snapshot.url,
          })),
          ...pending.replies.map(({ threadId, comment }) => {
            const thread = this.threadById(threadId).thread;
            return {
              id: comment.id,
              body: comment.body,
              path: thread.path,
              line: thread.line,
              url: comment.url,
            };
          }),
        ],
      };
    }

    for (const pull of this.scenario.world.pulls) {
      const review = pull.snapshot.reviews.find((candidate) => candidate.id === id);
      if (review) return { ...review, commitOid: review.commitOid ?? null, comments: [] };
    }

    return null;
  }

  async commentNow(prId: string, commitOid: string, thread: ThreadInput) {
    const reviewId = await this.addPendingReview(prId, commitOid);

    await this.addReviewThread(reviewId, thread);

    return this.submitReview(reviewId, 'COMMENT', '');
  }

  async replyToThread(threadId: string, body: string) {
    await this.beforeWrite();
    const { pull, thread } = this.threadById(threadId);

    this.record('ReplyToThread', { threadId, body });

    const id = this.nextId('comment');
    const now = this.now();

    const comment = {
      id,
      author: { login: this.scenario.world.viewer.login },
      body,
      createdAt: now,
      updatedAt: now,
      url: `${pull.snapshot.url}#discussion_${id}`,
      replyToId: thread.comments[0]?.id ?? null,
    };
    const pending = [...this.pending.values()].find((review) => review.prId === pull.snapshot.id);

    if (pending) {
      pending.replies.push({ threadId, comment });
      if (pull.snapshot.pendingReview) pull.snapshot.pendingReview.commentCount++;
    } else thread.comments.push(comment);
    pull.snapshot.updatedAt = now;

    return this.receipt('ReplyToThread', {
      id,
      url: `${pull.snapshot.url}#discussion_${id}`,
      pending: Boolean(pending),
    });
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    await this.beforeWrite();
    const { pull, thread } = this.threadById(threadId);

    this.record(resolved ? 'ResolveThread' : 'UnresolveThread', { threadId });
    thread.isResolved = resolved;
    pull.snapshot.updatedAt = this.now();
    this.receipt(resolved ? 'ResolveThread' : 'UnresolveThread', undefined);
  }

  async setFileViewed(
    prId: string,
    path: string,
    viewed: boolean,
  ): Promise<{ headOid: string; baseOid: string | null } | null> {
    // Whose mark this is, decided before any delay, as for reads.
    const account = this.effective();

    await this.beforeWrite();
    const pull = this.pullById(prId);
    this.record(viewed ? 'MarkFileViewed' : 'UnmarkFileViewed', { prId, path });

    const files = this.viewedOf(account, prId) ?? new Map();

    files.set(path, viewed ? 'VIEWED' : 'UNVIEWED');
    if (isSameUser(account, this.scenario.world.viewer.login))
      this.scenario.world.viewed.set(prId, files);
    else this.viewedByOthers.set(`${account}\u0000${prId}`, files);
    this.receipt(viewed ? 'MarkFileViewed' : 'UnmarkFileViewed', undefined);

    return viewed
      ? { headOid: pull.snapshot.headOid, baseOid: pull.snapshot.baseOid ?? null }
      : null;
  }

  async requestReviews(prId: string, logins: string[]): Promise<void> {
    await this.beforeWrite();
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
    this.receipt('RequestReviews', undefined);
  }

  async addConversationComment(prId: string, body: string) {
    await this.beforeWrite();
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

    return this.receipt('AddComment', { id, url: `${pull.snapshot.url}#issuecomment-${id}` });
  }

  /** Answers the backfill's searches from the scenario plus fictional history. */
  async searchPullIds(query: HistoryQuery): Promise<string[]> {
    if (this.outsider) return [];

    const login = this.scenario.world.viewer.login;
    const from = Date.parse(query.from);
    const to = Date.parse(query.to) + 24 * 3_600_000;
    const field = query.kind === 'authored' ? 'createdAt' : 'updatedAt';
    const reviewer = query.kind === 'reviewed';
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
      .filter((pull) => !query.repositories || query.repositories.includes(pull.repository))
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
