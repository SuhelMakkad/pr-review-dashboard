import type { Actor, PullRequestSnapshot, FeedSource, Source } from '@review-desk/shared/types';
import { parseAccount } from '@review-desk/shared/accounts';
import type { ReviewEvent } from '@review-desk/shared/review';
import type { DetectOptions, GitHubApi } from '@/github/api.js';
import type { CliAccount, CredentialSource, GitHubAccounts } from '@/github/credentials.js';
import { GitHubError } from '@/github/errors.js';
import type { ThreadInput } from '@/github/write.js';
import type { GlabAccounts } from '@/gitlab/accounts.js';

type AccountLister = Pick<GitHubAccounts, 'list' | 'select'>;

/** A GitHub client and the credentials it holds (null where they are not GitHub's own). */
export interface GitHubClient {
  client: GitHubApi;
  credentials: CredentialSource | null;
}

/** How the router reaches GitHub as one account (see `GhCredentials.bind` and `pin`). */
export interface GitHubBinding {
  /** A client whose every call is made as `login`. */
  bound(login: string): GitHubClient;
  /** A client holding the credentials gh would use right now, or null with none at all. */
  pinned(): Promise<GitHubClient | null>;
}

/** Every forge call, sent to the client `target()` names when the call is made. */
abstract class ForgeView implements GitHubApi {
  protected abstract target(): GitHubApi;

  abstract identity(): Promise<Actor>;

  abstract verifyAccount(account: string): Promise<void>;

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

  async pinnedFiles(
    repository: string,
    number: number,
    revision: { headOid: string; baseOid: string | null },
  ) {
    return (await this.target().pinnedFiles?.(repository, number, revision)) ?? null;
  }

  compare(repository: string, base: string, head: string) {
    return this.target().compare(repository, base, head);
  }

  branchHead(repository: string, branch: string) {
    return this.target().branchHead(repository, branch);
  }

  markedComment(prId: string, author: string, marker: string) {
    return this.target().markedComment(prId, author, marker);
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

  get approvalCarriesSummary() {
    return this.target().approvalCarriesSummary;
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

  setFileViewed(prId: string, path: string, viewed: boolean, expected?: { fileKey: string }) {
    return expected
      ? this.target().setFileViewed(prId, path, viewed, expected)
      : this.target().setFileViewed(prId, path, viewed);
  }

  addConversationComment(prId: string, body: string) {
    return this.target().addConversationComment(prId, body);
  }

  requestReviews(prId: string, logins: string[]) {
    return this.target().requestReviews(prId, logins);
  }
}

/** Every call made as one account, whatever is selected meanwhile (see `ForgeRouter.as`). */
export class BoundForge extends ForgeView {
  constructor(
    readonly account: string,
    private readonly client: GitHubApi,
    private readonly router: ForgeRouter,
    /** The GitHub credentials every call uses, which work beside the forge shares (archives). */
    readonly credentials: CredentialSource | null = null,
  ) {
    super();
  }

  protected target(): GitHubApi {
    return this.client;
  }

  identity() {
    return this.client.identity();
  }

  async verifyAccount(account: string): Promise<void> {
    if (parseAccount(account).forge === 'gitlab') await this.client.verifyAccount?.(account);
  }

  as(login: string): GitHubApi {
    return login === this.account ? this : this.router.as(login);
  }
}

/**
 * Sends every request to GitHub or to the GitLab host of the account it is made as. Work that
 * belongs to one account binds to it (`as`); other calls go as the account picked in the app.
 * With nothing picked, the GitHub CLI's active account is used, or the first GitLab account when
 * the GitHub CLI has no github.com sign-in at all.
 */
export class ForgeRouter extends ForgeView implements GitHubAccounts {
  private selected: string | null = null;
  /** The default when nothing is picked: undefined until worked out, null for GitHub. */
  private fallback: string | null | undefined = undefined;
  private readonly gitlabs = new Map<string, GitHubApi>();

  constructor(
    private readonly github: GitHubApi,
    private readonly gh: AccountLister,
    private readonly glab: Pick<GlabAccounts, 'list'>,
    private readonly gitlab: (host: string) => GitHubApi,
    /** Without one, GitHub calls go as the selected account whatever they are bound to (tests). */
    private readonly binding: GitHubBinding = {
      bound: () => ({ client: github, credentials: null }),
      pinned: async () => ({ client: github, credentials: null }),
    },
  ) {
    super();
  }

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

  /** Every call made as `login`, for as long as the work holding it runs. */
  as(login: string): BoundForge {
    const { forge, host } = parseAccount(login);

    if (forge === 'github') {
      const { client, credentials } = this.binding.bound(login);

      return new BoundForge(login, client, this, credentials);
    }

    return new BoundForge(login, this.gitlabFor(host).as?.(login) ?? this.gitlabFor(host), this);
  }

  /**
   * With nothing picked: the account the credentials in use right now are, with every later call
   * held to those same credentials. The GitHub CLI's token is pinned, so a switch of its active
   * account cannot change whose the rest of the work is; without any GitHub sign-in, the first
   * GitLab account.
   */
  async discoverIdentity(): Promise<{ identity: Actor; forge: GitHubApi }> {
    if (this.selected) {
      const forge = this.as(this.selected);

      return { identity: await forge.identity(), forge };
    }

    await this.resolveFallback();

    if (this.fallback) {
      const forge = this.as(this.fallback);

      return { identity: await forge.identity(), forge };
    }

    const pinned = await this.binding.pinned();

    if (pinned) {
      const identity = await pinned.client.identity();

      return {
        identity,
        forge: new BoundForge(identity.login, pinned.client, this, pinned.credentials),
      };
    }

    // Nothing to pin: the GitHub CLI's own answer explains the missing sign-in. Should it find
    // someone after all (signed in just now), the rest is bound to that login by name, never to
    // whoever the CLI holds next.
    const identity = await this.github.identity();

    return { identity, forge: this.as(identity.login) };
  }

  private account(): string | null {
    return this.selected ?? this.fallback ?? null;
  }

  protected target(): GitHubApi {
    const account = this.account();

    if (!account) return this.github;

    const { forge, host } = parseAccount(account);

    return forge === 'github' ? this.github : this.gitlabFor(host);
  }

  private gitlabFor(host: string): GitHubApi {
    let client = this.gitlabs.get(host);

    if (!client) {
      client = this.gitlab(host);
      this.gitlabs.set(host, client);
    }

    return client;
  }

  async identity() {
    await this.resolveFallback();

    return this.target().identity();
  }

  async verifyAccount(account: string): Promise<void> {
    const { forge, host } = parseAccount(account);

    if (forge === 'gitlab') await this.gitlabFor(host).verifyAccount?.(account);
  }

  /** Works out the default account once, the first time one is needed with nothing picked. */
  private async resolveFallback(): Promise<void> {
    if (this.selected || this.fallback !== undefined) return;

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
}
