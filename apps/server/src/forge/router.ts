import type { PullRequestSnapshot, FeedSource, Source } from '@review-desk/shared/types';
import { parseAccount } from '@review-desk/shared/accounts';
import type { ReviewEvent } from '@review-desk/shared/review';
import type { DetectOptions, GitHubApi } from '@/github/api.js';
import { scopedAccount, type CliAccount, type GitHubAccounts } from '@/github/credentials.js';
import { GitHubError } from '@/github/errors.js';
import type { ThreadInput } from '@/github/write.js';
import type { GlabAccounts } from '@/gitlab/accounts.js';

type AccountLister = Pick<GitHubAccounts, 'list' | 'select'>;

/**
 * Sends every request to GitHub or to the GitLab host of the account it is made as: the account
 * that work was started as (`asAccount`), else the account picked in the app. With nothing picked,
 * the GitHub CLI's active account is used, or the first GitLab account when the GitHub CLI has no
 * github.com sign-in at all.
 */
export class ForgeRouter implements GitHubApi, GitHubAccounts {
  private selected: string | null = null;
  /** The default when nothing is picked: undefined until worked out, null for GitHub. */
  private fallback: string | null | undefined = undefined;
  private readonly gitlabs = new Map<string, GitHubApi>();

  constructor(
    private readonly github: GitHubApi,
    private readonly gh: AccountLister,
    private readonly glab: Pick<GlabAccounts, 'list'>,
    private readonly gitlab: (host: string) => GitHubApi,
  ) {}

  // Accounts --------------------------------------------------------------------------------------

  async list(): Promise<CliAccount[]> {
    const [github, gitlab] = await Promise.allSettled([this.gh.list(), this.glab.list()]);

    // Either CLI may be missing; the other's accounts are still usable.
    if (github.status === 'rejected' && gitlab.status === 'rejected') throw github.reason;

    return [
      ...(github.status === 'fulfilled' ? github.value : []),
      ...(gitlab.status === 'fulfilled' ? gitlab.value : []),
    ];
  }

  select(login: string | null): void {
    this.selected = login;
    this.fallback = undefined;

    // The GitHub CLI's selection stays as it was while a GitLab account is in use, so work queued
    // as a GitHub account still runs as that account.
    if (!login || parseAccount(login).forge === 'github') this.gh.select(login);
  }

  private account(): string | null {
    return scopedAccount() ?? this.selected ?? this.fallback ?? null;
  }

  private target(): GitHubApi {
    const account = this.account();

    if (!account) return this.github;

    const { forge, host } = parseAccount(account);

    if (forge === 'github') return this.github;

    let client = this.gitlabs.get(host);

    if (!client) {
      client = this.gitlab(host);
      this.gitlabs.set(host, client);
    }

    return client;
  }

  /** Works out the default account once, the first time one is needed with nothing picked. */
  private async resolveFallback(): Promise<void> {
    if (scopedAccount() || this.selected || this.fallback !== undefined) return;

    let githubAccounts: CliAccount[] = [];

    try {
      githubAccounts = await this.gh.list();
    } catch (error) {
      // gh not installed counts as no GitHub sign-in; any other failure is retried next time.
      const missing =
        error instanceof GitHubError &&
        error.outcome === 'unavailable' &&
        /ENOENT/.test(error.message);

      if (!missing) return;
    }

    // A token in GH_TOKEN works without a stored sign-in, which the list leaves out. Only a
    // definite answer counts: GitHub being unreachable for a moment decides nothing.
    let github = githubAccounts.length > 0;

    if (!github) {
      try {
        await this.github.identity();
        github = true;
      } catch (error) {
        // Signed out, or gh not installed at all; anything else may pass.
        const definite =
          error instanceof GitHubError &&
          (error.outcome === 'auth' ||
            (error.outcome === 'unavailable' && /ENOENT/.test(error.message)));

        if (!definite) return;
      }
    }

    if (github) {
      this.fallback = null;
      return;
    }

    const gitlab = await this.glab.list().catch(() => [] as CliAccount[]);

    this.fallback = gitlab.find((account) => account.ok)?.login ?? null;
  }

  // GitHubApi -------------------------------------------------------------------------------------

  async identity() {
    await this.resolveFallback();

    return this.target().identity();
  }

  reviewReceipt(id: string) {
    return this.target().reviewReceipt(id);
  }

  async capabilities() {
    return (await this.target().capabilities?.()) ?? { requestChanges: true };
  }

  teams() {
    return this.target().teams();
  }

  discover(login: string, source: FeedSource) {
    return this.target().discover(login, source);
  }

  resolvePull(repository: string, number: number) {
    return this.target().resolvePull(repository, number);
  }

  detect(ids: string[], options?: DetectOptions) {
    return this.target().detect(ids, options);
  }

  snapshot(id: string, login: string, sources: Source[], previous?: PullRequestSnapshot) {
    return this.target().snapshot(id, login, sources, previous);
  }

  pullFiles(repository: string, number: number) {
    return this.target().pullFiles(repository, number);
  }

  compare(repository: string, base: string, head: string) {
    return this.target().compare(repository, base, head);
  }

  searchPullIds(query: string) {
    return this.target().searchPullIds(query);
  }

  history(ids: string[], login: string) {
    return this.target().history(ids, login);
  }

  blobs(repository: string, requests: { oid: string; path: string }[]) {
    return this.target().blobs(repository, requests);
  }

  approveReview(prId: string, commitOid: string, body: string) {
    return this.target().approveReview(prId, commitOid, body);
  }

  addPendingReview(prId: string, commitOid: string) {
    return this.target().addPendingReview(prId, commitOid);
  }

  addReviewThread(reviewId: string, thread: ThreadInput) {
    return this.target().addReviewThread(reviewId, thread);
  }

  submitReview(reviewId: string, event: ReviewEvent, body: string) {
    return this.target().submitReview(reviewId, event, body);
  }

  deleteReview(reviewId: string) {
    return this.target().deleteReview(reviewId);
  }

  commentNow(prId: string, commitOid: string, thread: ThreadInput) {
    return this.target().commentNow(prId, commitOid, thread);
  }

  replyToThread(threadId: string, body: string) {
    return this.target().replyToThread(threadId, body);
  }

  setThreadResolved(threadId: string, resolved: boolean) {
    return this.target().setThreadResolved(threadId, resolved);
  }

  setFileViewed(prId: string, path: string, viewed: boolean) {
    return this.target().setFileViewed(prId, path, viewed);
  }

  addConversationComment(prId: string, body: string) {
    return this.target().addConversationComment(prId, body);
  }

  requestReviews(prId: string, logins: string[]) {
    return this.target().requestReviews(prId, logins);
  }
}
