import type {
  Actor,
  FeedSource,
  ForgeCapabilities,
  PullRequestSnapshot,
  Source,
} from '@review-desk/shared/types';
import {
  accountHandle,
  gitlabAccountKey,
  isSameUser,
  parseAccount,
} from '@review-desk/shared/accounts';
import { scopedAccount } from '@/github/credentials.js';
import type {
  BlobText,
  CompareResult,
  DetectOptions,
  DetectResult,
  GitHubApi,
  PinnedFiles,
  RateBudget,
  RemoteFile,
  ResolvedPull,
  ReviewReceipt,
} from '@/github/api.js';
import { GitHubError } from '@/github/errors.js';
import type { ThreadInput } from '@/github/write.js';
import type { ReviewEvent } from '@review-desk/shared/review';
import { diffKey, fingerprint } from '@/gitlab/fingerprint.js';
import {
  isPendingReviewId,
  mergeRequestId,
  mergeRequestPath,
  parseMergeRequestId,
  pendingReviewId,
  projectPath,
  type MergeRequestRef,
} from '@/gitlab/ids.js';
import {
  mergeRequestSnapshot,
  noteUrl,
  remoteFile,
  stateOf,
  viewerReviews,
  type MergeRequestData,
  type RawApprovals,
  type RawDiff,
  type RawDiscussion,
  type RawDraftNote,
  type RawJob,
  type RawMergeRequest,
  type RawReviewer,
  type RawUser,
  type RawVersion,
} from '@/gitlab/snapshot.js';
import {
  call,
  GlabCli,
  paginate,
  responseError,
  type GitLabTransport,
} from '@/gitlab/transport.js';
import {
  createGitLabWriter,
  submissionKey,
  type GitLabWrites,
  type LocalState,
  type Submission,
} from '@/gitlab/write.js';
import { parseVersion, reviewFeatures, type GitLabVersion } from '@/gitlab/version.js';

/** Where Review Desk keeps what GitLab cannot store for it (viewed files). */
export interface SettingsStore {
  getSetting<T>(key: string): T | null;
  setSetting(key: string, value: unknown): void;
  deleteSetting(key: string): void;
}

const MAX_BLOB_BYTES = 512 * 1024;
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * `work`, or `fallback` when GitLab answers 404 because the endpoint is newer than the instance:
 * MR diffs arrived in GitLab 15.7, draft notes in 15.9, the reviewers list not long before.
 */
function unlessMissing<T>(work: Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  return work.catch((error: unknown) =>
    error instanceof GitHubError && error.status === 404 ? fallback() : Promise.reject(error),
  );
}
const SHA = /^[0-9a-f]{40,64}$/i;

/** Runs `work` over `items` with at most `limit` running at once, keeping the order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;

      results[index] = await work(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

/** The REST filter for each discovery feed. */
const feedFilters: Partial<Record<FeedSource, string>> = {
  requested: 'reviewer_username',
  assigned: 'assignee_username',
  authored: 'author_username',
};

interface RawTodo {
  target_type?: string;
  target?: { project_id?: number; iid?: number; state?: string } | null;
}

/** GitHub search qualifiers the insights backfill uses, as GitLab list filters. */
function searchFilters(query: string): string | null {
  const qualifier = (name: string) => new RegExp(`(?:^|\\s)${name}:(\\S+)`).exec(query)?.[1];
  const range = (value: string | undefined, field: 'created' | 'updated') => {
    const [from, to] = (value ?? '').split('..');

    if (!from || !to) return '';

    // `to` is an inclusive day; GitLab's `_before` is exclusive.
    const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString();

    return `&${field}_after=${encodeURIComponent(`${from}T00:00:00Z`)}&${field}_before=${encodeURIComponent(end)}`;
  };
  const reviewer = qualifier('reviewed-by');
  const author = qualifier('author');
  const user = reviewer ?? author;

  if (!user) return null;

  const filter = reviewer ? 'reviewer_username' : 'author_username';

  return (
    `merge_requests?scope=all&state=all&${filter}=${encodeURIComponent(accountHandle(user))}` +
    range(qualifier('created'), 'created') +
    range(qualifier('updated'), 'updated')
  );
}

/**
 * Domain-level GitLab access for one host, over the GitLab CLI. Merge requests appear to the rest of
 * the app as pull requests; see `ids.ts` for how their ids are formed and `snapshot.ts` for how
 * GitLab's notes, reviewers and approvals become reviews, requests and verdicts.
 */
export class GitLab implements GitHubApi {
  private readonly writes: GitLabWrites;

  constructor(
    readonly transport: GitLabTransport,
    private readonly settings: SettingsStore | null = null,
  ) {
    this.writes = createGitLabWriter(transport, {
      mergeRequest: (ref) => this.mergeRequest(ref),
      diffs: (ref) => this.diffs(ref),
      version: () => this.version(),
      username: async () => accountHandle((await this.identity()).login),
      assertAccount: () => this.assertAccount(),
      markViewed: (prId, path, mark) => this.markViewed(prId, path, mark),
      local: this.local,
    });
  }

  /** Review Desk's own state for this host, kept in its settings (or nowhere, in tests). */
  private readonly local: LocalState = {
    get: <T>(key: string) => this.settings?.getSetting<T>(this.localKey(key)) ?? null,
    set: (key, value) => {
      const name = this.localKey(key);

      if (value === null || value === undefined) this.settings?.deleteSetting(name);
      else this.settings?.setSetting(name, value);
    },
  };

  /** Per account once known (every sync and write reads the identity first), else per host. */
  private localKey(key: string): string {
    return `gitlab:${this.login ?? this.host}:${key}`;
  }

  private release: Promise<GitLabVersion | null> | null = null;

  /** The instance's GitLab release, read once; unknown (null) when it cannot be read. */
  version(): Promise<GitLabVersion | null> {
    this.release ??= call<{ version?: string }>(
      this.transport,
      { path: 'version' },
      'Could not read the GitLab version',
    )
      .then((data) => parseVersion(data.version))
      .catch(() => {
        this.release = null;

        return null;
      });

    return this.release;
  }

  /** Requesting changes needs GitLab 19.2, which lets a published review set the reviewer state. */
  async capabilities(): Promise<ForgeCapabilities> {
    return { requestChanges: reviewFeatures(await this.version()).reviewerState };
  }

  static forHost(host: string, settings: SettingsStore | null = null): GitLab {
    return new GitLab(new GlabCli(host), settings);
  }

  get host(): string {
    return this.transport.host;
  }

  // Writes ----------------------------------------------------------------------------------------

  approveReview(prId: string, commitOid: string, body: string) {
    return this.writes.approveReview(prId, commitOid, body);
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

  setFileViewed(prId: string, path: string, viewed: boolean, expected?: { fileKey: string }) {
    return this.writes.setFileViewed(prId, path, viewed, expected);
  }

  addConversationComment(prId: string, body: string) {
    return this.writes.addConversationComment(prId, body);
  }

  requestReviews(prId: string, logins: string[]) {
    return this.writes.requestReviews(prId, logins);
  }

  // Reads -----------------------------------------------------------------------------------------

  /** Refuses when glab is now signed in as someone other than the account the work runs as. */
  private async assertAccount(): Promise<void> {
    const expected = scopedAccount();

    if (!expected || parseAccount(expected).forge !== 'gitlab') return;

    const { login } = await this.identity();

    if (login.toLowerCase() !== expected.toLowerCase())
      throw new GitHubError(
        `The GitLab CLI is now signed in as ${login}, not ${expected}. Nothing was sent; sign in as ${expected} again or switch accounts.`,
        null,
        409,
        'rejected',
      );
  }

  /** The account key of the last identity read; local state is kept per account. */
  private login: string | null = null;

  async identity(): Promise<Actor> {
    const user = await call<RawUser>(
      this.transport,
      { path: 'user' },
      'Could not read your GitLab account',
    );

    this.login = gitlabAccountKey(user.username, this.host);

    return {
      login: gitlabAccountKey(user.username, this.host),
      avatarUrl: user.avatar_url ?? undefined,
      webUrl: user.web_url,
    };
  }

  /** GitLab asks individual users for reviews, never groups, so there are no teams to match. */
  async teams(): Promise<string[]> {
    return [];
  }

  async discover(login: string, source: FeedSource): Promise<string[]> {
    const username = encodeURIComponent(accountHandle(login));

    if (source === 'mentioned') return this.mentioned();

    const filter = feedFilters[source];

    // GitLab keeps reviewers listed after they review, so the review-requested feed already holds
    // the merge requests you reviewed; there is no separate "reviewed by" search.
    if (!filter) return [];

    const mrs = await paginate<RawMergeRequest>(
      this.transport,
      `merge_requests?scope=all&state=opened&${filter}=${username}`,
      `Could not search GitLab for ${source} merge requests`,
      10,
    );

    return [...new Set(mrs.map((mr) => mergeRequestId(mr.project_id, mr.iid)))];
  }

  /** Open merge requests with to-do items for mentioning you, pending or already done. */
  private async mentioned(): Promise<string[]> {
    const lists = await Promise.all(
      ['mentioned', 'directly_addressed'].flatMap((action) =>
        ['pending', 'done'].map((state) =>
          paginate<RawTodo>(
            this.transport,
            `todos?type=MergeRequest&action=${action}&state=${state}`,
            'Could not read GitLab mentions',
            state === 'pending' ? 5 : 2,
          ),
        ),
      ),
    );
    const ids = lists
      .flat()
      .filter(
        (todo) => todo.target?.state === 'opened' && todo.target.project_id && todo.target.iid,
      )
      .map((todo) => mergeRequestId(todo.target!.project_id!, todo.target!.iid!));

    return [...new Set(ids)];
  }

  async resolvePull(repository: string, number: number): Promise<ResolvedPull | null> {
    const response = await this.transport.request<RawMergeRequest>({
      path: `${projectPath(repository)}/merge_requests/${number}`,
    });

    if (response.status === 404) return null;
    if (response.status >= 400)
      throw responseError(response, `Could not find ${repository}!${number}`);

    return {
      id: mergeRequestId(response.data.project_id, response.data.iid),
      state: stateOf(response.data.state),
    };
  }

  /**
   * Change detection: one list request per project for every tracked merge request, plus the head
   * pipeline of merge requests whose stored CI is still running (pipeline results do not touch a
   * merge request's `updated_at`; new notes, approvals and review requests do).
   */
  async detect(
    ids: string[],
    options: DetectOptions = {},
  ): Promise<{ results: DetectResult[]; budget: RateBudget | null }> {
    const byProject = new Map<number, number[]>();

    for (const id of ids) {
      const ref = parseMergeRequestId(id);

      byProject.set(ref.projectId, [...(byProject.get(ref.projectId) ?? []), ref.iid]);
    }

    const found = new Map<string, DetectResult>();

    await mapLimit([...byProject], 4, async ([projectId, iids]) => {
      for (let start = 0; start < iids.length; start += 100) {
        const batch = iids.slice(start, start + 100);
        const query = batch.map((iid) => `iids[]=${iid}`).join('&');
        const response = await this.transport.request<RawMergeRequest[]>({
          path: `projects/${projectId}/merge_requests?${query}&per_page=100`,
        });

        // A deleted project, or one you lost access to: its merge requests are unavailable.
        if (response.status === 404 || response.status === 403) continue;
        if (response.status >= 400) throw responseError(response, 'GitLab change detection failed');

        for (const mr of response.data) {
          const id = mergeRequestId(mr.project_id, mr.iid);
          const pipeline = options.ciPending?.has(id)
            ? await this.headPipeline({ projectId, iid: mr.iid })
            : null;

          found.set(id, {
            id,
            state: stateOf(mr.state),
            fingerprint: fingerprint({
              state: mr.state,
              draft: mr.draft,
              title: mr.title,
              updatedAt: mr.updated_at,
              sha: mr.sha,
              target: mr.target_branch,
              merge: mr.detailed_merge_status ?? mr.merge_status,
              conflicts: mr.has_conflicts,
              notes: mr.user_notes_count,
              resolved: mr.blocking_discussions_resolved,
              reviewers: (mr.reviewers ?? []).map((user) => user.username),
              assignees: (mr.assignees ?? []).map((user) => user.username),
              pipeline,
            }),
          });
        }
      }
    });

    return {
      results: ids.map((id) => found.get(id) ?? { id, state: null, fingerprint: null }),
      budget: null,
    };
  }

  private async headPipeline(ref: MergeRequestRef): Promise<unknown> {
    const mr = await this.mergeRequest(ref);

    return mr.head_pipeline ? { id: mr.head_pipeline.id, status: mr.head_pipeline.status } : null;
  }

  async snapshot(
    id: string,
    login: string,
    sources: Source[],
    previous?: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot> {
    const ref = parseMergeRequestId(id);
    const response = await this.transport.request<RawMergeRequest>({ path: mergeRequestPath(ref) });

    if (response.status === 404)
      throw new GitHubError(
        `MR ${previous?.number ?? ref.iid} is unavailable; its cached record was retained.`,
      );
    if (response.status >= 400) throw responseError(response, 'Could not load the merge request');

    const data = await this.collect(ref, response.data, false, login);
    return mergeRequestSnapshot(data, login, sources, previous);
  }

  /** Reads everything a snapshot needs. Light reads (history) skip files, drafts and CI. */
  private async collect(
    ref: MergeRequestRef,
    mr: RawMergeRequest,
    light: boolean,
    viewer: string,
  ): Promise<MergeRequestData> {
    const base = mergeRequestPath(ref);
    const list = <T>(path: string, what: string) =>
      paginate<T>(this.transport, `${base}/${path}`, `Could not load ${what}`);
    const submission = this.local.get<Submission>(submissionKey(pendingReviewId(ref)));

    if (light) {
      // Review history reads requests, your reviews, and verdicts on your own MRs only: three or
      // four requests per MR rather than a full snapshot's nine.
      const own = mr.author ? isSameUser(mr.author.username, viewer) : false;
      const [discussions, reviewers, approvals] = await Promise.all([
        list<RawDiscussion>('discussions', 'discussions'),
        unlessMissing(
          call<RawReviewer[]>(
            this.transport,
            { path: `${base}/reviewers` },
            'Could not load reviewers',
          ),
          () => (mr.reviewers ?? []).map((user) => ({ user })),
        ),
        own
          ? call<RawApprovals>(
              this.transport,
              { path: `${base}/approvals` },
              'Could not load approvals',
            )
          : Promise.resolve({} as RawApprovals),
      ]);

      return { mr, discussions, reviewers, approvals, versions: [], submission };
    }

    const [discussions, reviewers, approvals, versions, targetTip] = await Promise.all([
      list<RawDiscussion>('discussions', 'discussions'),
      unlessMissing(
        call<RawReviewer[]>(
          this.transport,
          { path: `${base}/reviewers` },
          'Could not load reviewers',
        ),
        () => (mr.reviewers ?? []).map((user) => ({ user })),
      ),
      call<RawApprovals>(this.transport, { path: `${base}/approvals` }, 'Could not load approvals'),
      list<RawVersion>('versions', 'versions'),
      // Where the target branch is now, read with the rest: GitLab keeps the diff of a version,
      // which a push to the target does not renew. Unknown when it cannot be read.
      this.transport
        .request<{ commit?: { id?: string } }>({
          path: `projects/${mr.project_id}/repository/branches/${encodeURIComponent(mr.target_branch)}`,
        })
        .then(
          (response) => (response.status < 400 ? (response.data.commit?.id ?? null) : null),
          () => null,
        ),
    ]);

    const pipeline = mr.head_pipeline;
    const [diffs, drafts, jobs, headCommittedAt] = await Promise.all([
      this.diffs(ref),
      unlessMissing(list<RawDraftNote>('draft_notes', 'your pending review'), () => []),
      pipeline
        ? paginate<RawJob>(
            this.transport,
            `projects/${pipeline.project_id}/pipelines/${pipeline.id}/jobs`,
            'Could not load CI jobs',
            5,
          ).catch(() => [])
        : Promise.resolve([]),
      this.committedAt(ref.projectId, mr.sha),
    ]);

    return {
      mr,
      discussions,
      reviewers,
      approvals,
      versions,
      diffs,
      drafts,
      jobs,
      headCommittedAt,
      submission,
      targetTip,
      viewed: this.viewed(mergeRequestId(ref.projectId, ref.iid)),
    };
  }

  private async committedAt(projectId: number, sha: string): Promise<string | null> {
    const response = await this.transport.request<{ committed_date?: string }>({
      path: `projects/${projectId}/repository/commits/${encodeURIComponent(sha)}`,
    });

    return response.status < 400 ? (response.data.committed_date ?? null) : null;
  }

  private async mergeRequest(ref: MergeRequestRef): Promise<RawMergeRequest> {
    return call<RawMergeRequest>(
      this.transport,
      { path: mergeRequestPath(ref) },
      'Could not load the merge request',
    );
  }

  /** A merge request's changed files; `ref` is the merge request or its REST path. */
  private diffs(ref: MergeRequestRef | string): Promise<RawDiff[]> {
    const base = typeof ref === 'string' ? ref : mergeRequestPath(ref);
    const action = 'Could not load the changed files';

    // GitLab (17.8 at least) fails with HTTP 500 for diff pages of 50 or more; its default of 20
    // works. 150 pages covers the 3,000 files GitHub lists at most.
    return unlessMissing(
      paginate<RawDiff>(this.transport, `${base}/diffs`, action, 150, 20),
      async () =>
        (await call<{ changes?: RawDiff[] }>(this.transport, { path: `${base}/changes` }, action))
          .changes ?? [],
    );
  }

  async pullFiles(repository: string, number: number): Promise<RemoteFile[]> {
    const diffs = await this.diffs(`${projectPath(repository)}/merge_requests/${number}`);

    return diffs.map(remoteFile);
  }

  /**
   * The files of the merge request diff version for exactly `revision` (its head and start, the
   * snapshot's head and base). GitLab keeps every version's diffs and never changes them, so the
   * files, their patches and their keys are that revision's however the merge request moves
   * meanwhile. Without such a version (it moved on, or was retargeted), the live diff, unkeyed.
   */
  async pinnedFiles(
    repository: string,
    number: number,
    revision: { headOid: string; baseOid: string | null },
  ): Promise<PinnedFiles> {
    const path = `${projectPath(repository)}/merge_requests/${number}`;
    // The live diff, unkeyed: shown, but not kept and not markable as viewed.
    const live = async (): Promise<PinnedFiles> => ({
      files: (await this.diffs(path)).map(remoteFile),
      pinned: false,
    });
    const versions = await paginate<RawVersion>(
      this.transport,
      `${path}/versions`,
      'Could not load versions',
    ).catch(() => null);
    const version = versions?.find(
      (candidate) =>
        candidate.head_commit_sha === revision.headOid &&
        (candidate.start_commit_sha ?? null) === revision.baseOid,
    );

    if (!version) return live();

    const detail = await call<RawVersion & { diffs?: RawDiff[] }>(
      this.transport,
      { path: `${path}/versions/${version.id}` },
      'Could not load the merge request diff',
    ).catch(() => null);

    // GitLab can clean up an old version's stored patches (`without_files`); its list is then
    // empty although the merge request still has changes, which the live diff rebuilds.
    if (!detail || detail.state === 'without_files' || !Array.isArray(detail.diffs)) return live();

    const key = { head: version.head_commit_sha, start: version.start_commit_sha ?? null };

    return {
      files: (detail.diffs ?? []).map((diff) => ({
        ...remoteFile(diff),
        viewedKey: diffKey(diff, key),
      })),
      pinned: true,
      // Any other state (the `overflow` ones) means GitLab stored only part of the list.
      ...((detail.state === 'collected' || detail.state === 'empty') && detail.base_commit_sha
        ? { complete: true, mergeBaseOid: detail.base_commit_sha }
        : {}),
    };
  }

  async branchHead(repository: string, branch: string): Promise<string | null> {
    const response = await this.transport.request<{ commit?: { id?: string } }>({
      path: `${projectPath(repository)}/repository/branches/${encodeURIComponent(branch)}`,
    });

    if (response.status === 404) return null;
    if (response.status >= 400)
      throw responseError(response, `Could not read the ${branch} branch`);

    return response.data.commit?.id ?? null;
  }

  async compare(repository: string, base: string, head: string): Promise<CompareResult | null> {
    const project = projectPath(repository);
    const from = encodeURIComponent(base);
    const to = encodeURIComponent(head);
    const [comparison, mergeBase, baseCommit] = await Promise.all([
      this.transport.request<{
        commits?: { id: string; parent_ids?: string[]; committed_date?: string | null }[];
        diffs?: RawDiff[];
        compare_timeout?: boolean;
      }>({ path: `${project}/repository/compare?from=${from}&to=${to}&straight=false` }),
      this.transport.request<{ id?: string }>({
        path: `${project}/repository/merge_base?refs[]=${from}&refs[]=${to}`,
      }),
      SHA.test(base)
        ? Promise.resolve({ status: 200, data: { id: base } })
        : this.transport.request<{ id?: string }>({
            path: `${project}/repository/commits/${from}`,
          }),
    ]);

    // An unknown commit or branch.
    if (
      [comparison, mergeBase, baseCommit].some((response) =>
        [400, 404, 422].includes(response.status),
      )
    )
      return null;
    if (comparison.status >= 400) throw responseError(comparison, 'Could not compare commits');
    if (mergeBase.status >= 400) throw responseError(mergeBase, 'Could not find the merge base');

    // GitLab stops comparing large ranges early; a partial list would hide changed files.
    if (comparison.data.compare_timeout)
      throw new GitHubError(
        'GitLab could not finish comparing these commits. Try again, or review the full diff.',
        null,
        null,
        'unavailable',
      );

    const baseOid = baseCommit.data.id ?? base;
    const mergeBaseOid = mergeBase.data.id ?? null;
    const status: CompareResult['status'] =
      baseOid === head
        ? 'identical'
        : mergeBaseOid === baseOid
          ? 'ahead'
          : mergeBaseOid === head
            ? 'behind'
            : 'diverged';

    return {
      status,
      mergeBaseOid,
      files: (comparison.data.diffs ?? []).map(remoteFile),
      commits: (comparison.data.commits ?? []).map((commit) => ({
        oid: commit.id,
        parents: commit.parent_ids ?? [],
        committedAt: commit.committed_date ?? null,
      })),
    };
  }

  async blobs(
    repository: string,
    requests: { oid: string; path: string }[],
  ): Promise<(BlobText | null)[]> {
    const project = projectPath(repository);

    return mapLimit(requests, 4, async ({ oid, path }) => {
      const encoded = encodeURIComponent(path).replace(/\./g, '%2E');
      const response = await this.transport.request<string>({
        path: `${project}/repository/files/${encoded}/raw?ref=${encodeURIComponent(oid)}`,
      });

      if (response.status === 404) return null;
      if (response.status >= 400) throw responseError(response, `Could not read ${path}`);

      const text =
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const byteSize = Buffer.byteLength(text);
      const isBinary = text.includes('\u0000');

      return {
        text: isBinary ? null : text,
        isBinary,
        isTruncated: byteSize > MAX_BLOB_BYTES,
        byteSize,
      };
    });
  }

  /** Merge request ids for the GitHub-style search the insights backfill sends. */
  async searchPullIds(query: string): Promise<string[]> {
    const path = searchFilters(query);

    if (!path) return [];

    const mrs = await paginate<RawMergeRequest>(
      this.transport,
      path,
      'Could not search GitLab',
      10,
    );

    return [...new Set(mrs.map((mr) => mergeRequestId(mr.project_id, mr.iid)))];
  }

  async history(ids: string[], login: string): Promise<PullRequestSnapshot[]> {
    const snapshots = await mapLimit(ids, 4, async (id): Promise<PullRequestSnapshot | null> => {
      const ref = parseMergeRequestId(id);
      const response = await this.transport.request<RawMergeRequest>({
        path: mergeRequestPath(ref),
      });

      if (response.status >= 400) return null;

      const data = await this.collect(ref, response.data, true, login);

      return {
        ...mergeRequestSnapshot(data, login, [], undefined),
        body: '',
        threads: [],
        conversation: [],
      };
    });

    return snapshots.filter((snapshot): snapshot is PullRequestSnapshot => Boolean(snapshot));
  }

  /**
   * Your pending review: GitLab keeps it as your draft notes on the merge request. Null when there
   * are none, which is also how a submitted or deleted review looks.
   */
  async reviewReceipt(id: string): Promise<ReviewReceipt | null> {
    if (!isPendingReviewId(id)) return null;

    const ref = parseMergeRequestId(id);
    const [mr, drafts] = await Promise.all([
      this.mergeRequest(ref),
      paginate<RawDraftNote>(
        this.transport,
        `${mergeRequestPath(ref)}/draft_notes`,
        'Could not load your pending review',
      ),
    ]);

    if (drafts.length === 0) return this.submitted(id, mr);

    const heads = drafts
      .map((draft) => draft.position?.head_sha)
      .filter((head): head is string => Boolean(head));

    return {
      id: pendingReviewId(ref),
      state: 'PENDING',
      url: mr.web_url,
      body: '',
      // A comment left on an older commit makes the whole pending review an older one.
      commitOid: heads.find((head) => head !== mr.sha) ?? heads[0] ?? drafts[0].commit_id ?? null,
      comments: drafts.map((draft) => ({
        id: `draft-${draft.id}`,
        body: draft.note,
        path: draft.position?.new_path ?? draft.position?.old_path ?? '',
        line: draft.position?.new_line ?? draft.position?.old_line ?? null,
        url: noteUrl(mr, draft.id),
      })),
    };
  }

  /**
   * After a submission started, the drafts are gone because it published them: the receipt is the
   * review it published (your notes and approval since it started), so recovery can confirm it and
   * a later discard knows it was already submitted. Without one, there is no pending review.
   */
  private async submitted(id: string, mr: RawMergeRequest): Promise<ReviewReceipt | null> {
    const submission = this.local.get<Submission>(submissionKey(id));

    // A confirmed submission needs no recognising: no drafts means no pending review.
    if (!submission || submission.publishedAt) return null;

    const ref = parseMergeRequestId(id);
    const [discussions, versions, viewer] = await Promise.all([
      paginate<RawDiscussion>(
        this.transport,
        `${mergeRequestPath(ref)}/discussions`,
        'Could not load discussions',
      ),
      paginate<RawVersion>(
        this.transport,
        `${mergeRequestPath(ref)}/versions`,
        'Could not load versions',
      ),
      this.identity(),
    ]);
    // Only a review made of notes newer than the last one before sending can be the submission's.
    // Records kept before note ids were saved fall back to the time, allowing for clock skew.
    const since = Date.parse(submission.startedAt) - CLOCK_SKEW_MS;
    // A review ends with its newest note, so one holding a note newer than the submission ends no
    // earlier than that note, even when a reply just before joined it.
    const fresh =
      submission.afterNoteId === undefined
        ? since
        : Math.min(
            ...discussions
              .flatMap((discussion) => discussion.notes)
              .filter(
                (note) =>
                  note.id > submission.afterNoteId! &&
                  note.author &&
                  isSameUser(note.author.username, viewer.login),
              )
              .map((note) => Date.parse(note.created_at)),
          );
    const review = viewerReviews(mr, discussions, versions, viewer.login, submission)
      .filter((candidate) => Date.parse(candidate.submittedAt) >= fresh)
      .at(-1);

    return review
      ? {
          id: review.id,
          state: review.state,
          url: review.url,
          body: review.body,
          commitOid: review.commitOid,
          comments: [],
        }
      : null;
  }

  // Viewed files ----------------------------------------------------------------------------------

  private viewedKey(prId: string): string {
    return this.localKey(`viewed:${prId}`);
  }

  private viewed(prId: string): Record<string, string> {
    return this.settings?.getSetting<Record<string, string>>(this.viewedKey(prId)) ?? {};
  }

  /** GitLab has no API for viewed files, so marks live in Review Desk with the diff they saw. */
  private markViewed(prId: string, path: string, mark: string | null): void {
    if (!this.settings)
      throw new GitHubError('Viewed files cannot be saved here.', null, null, 'rejected');

    const viewed = { ...this.viewed(prId) };

    if (mark) viewed[path] = mark;
    else delete viewed[path];

    if (Object.keys(viewed).length > 0) this.settings.setSetting(this.viewedKey(prId), viewed);
    else this.settings.deleteSetting(this.viewedKey(prId));
  }
}
