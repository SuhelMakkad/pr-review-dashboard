import { say } from '@/messages.js';
import { AccountUnavailable, unattributed } from '@/forge/account.js';
import { isoNow, type Clock } from '@/clock.js';
import type { PullRequestDetail, TriageUpdate } from '@review-desk/shared/types';
import { instanceUrl, parseAccount } from '@review-desk/shared/accounts';
import type { Store } from '@/db/store.js';
import type { EventBus } from '@/events.js';
import type { GitHubApi } from '@/github/api.js';
import { bindForge } from '@/forge/bind.js';
import { GitHubError } from '@/github/errors.js';
import type { ViewedRevision } from '@/github/write.js';
import { ReviewError } from '@/review/errors.js';
import type { AccountState } from '@/sync/accounts.js';
import type { PullReads } from '@/sync/reads.js';
import type { SnapshotCoordinator } from '@/sync/snapshots.js';
import { ordered } from '@/sync/sources.js';
import { accountCheck } from '@/forge/bind.js';
import { traitsOf } from '@review-desk/shared/traits';

/**
 * Work on one PR as it happens: refreshing it, adding it to the queue by hand or removing it, and
 * recording its viewed files and its triage. Its writes of a cached PR go through the same
 * coordinator as the sync's, so the two are saved in the order their reads began.
 */
export class PullQueue {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubApi,
    private readonly events: EventBus,
    private readonly clock: Clock,
    private readonly state: AccountState,
    private readonly reads: PullReads,
    private readonly snapshots: SnapshotCoordinator,
  ) {}

  /**
   * Refetches one PR immediately (after opening it, or before and after a write), bypassing
   * detection. Every call starts its own read, so the result was fetched after the call began:
   * either this read, or a read that started later and was saved first. Null when the PR is not
   * tracked, or no longer open.
   */
  async refresh(
    id: string,
    account: string | null = this.state.status.account?.login ?? null,
    /** The caller's own binding to `account`, kept for its whole operation; else one is made. */
    forge?: GitHubApi,
  ): Promise<PullRequestDetail | null> {
    if (!account) return null;

    this.state.assertNotCoolingDown(account);

    // Every read below is this account's, whatever is selected meanwhile.
    const bound = forge ?? bindForge(this.github, account);

    // A read is refused when the PR is removed or reduced after it started; the row left behind
    // can be older than the read, so read again rather than return it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const observation = this.snapshots.observe(account, id);
      const cached = this.store.snapshot(account, id);

      if (!cached) return null;

      // Where the forge cannot carry the account with each call (GitLab), its sign-in is checked
      // before the read and again before its result is kept.
      const verify = accountCheck(bound);
      const read = () => bound.snapshot(id, account, cached.sources, cached);
      /** Saved before the caller hears of it, so the next request waits too. */
      const keepLimit = (error: unknown) => {
        if (error instanceof GitHubError && error.outcome === 'rate_limit' && error.retryAt)
          this.state.deferUntil(error.retryAt, account);
      };
      const fetched = await (async () => {
        if (!verify)
          return read().catch((error: unknown) => {
            keepLimit(error);
            throw error;
          });

        // A limit met by a check itself cannot be tied to the account: it is nobody's cooldown.
        const check = () =>
          verify(account).catch((error: unknown) => Promise.reject(unattributed(error)));

        await check();

        try {
          const snapshot = await read();

          await check();

          return snapshot;
        } catch (error) {
          if (error instanceof AccountUnavailable) throw error;

          // A limit is the account's only if glab is still signed in as it; otherwise it is passed
          // on with no deadline, so no caller saves it for this account either.
          const confirmed = await verify(account).then(
            () => true,
            () => false,
          );

          if (!confirmed) throw unattributed(error);

          keepLimit(error);
          throw error;
        }
      })();
      // Keep the stored sources: a PR may have been added or removed by hand during the fetch.
      const outcome = this.snapshots.commit(observation, fetched, {
        fingerprint: null,
        requireStored: true,
        sources: (latest) => latest?.sources ?? fetched.sources,
      });

      if (outcome.status === 'invalidated' && outcome.snapshot) continue;
      if (outcome.status === 'committed')
        this.events.emit({ type: 'pulls.changed', account, ids: [id] });

      return outcome.snapshot ? this.reads.detailOf(account, outcome.snapshot) : null;
    }

    throw new ReviewError('QUEUE_CHANGED', 409, say('queue.kept-changing'));
  }

  /**
   * Adds a PR to the queue by hand. From then on it is tracked like any other PR: it stays until it
   * is closed or merged, or until you remove it with `untrack`. Adding a tracked PR is harmless.
   */
  async track(
    account: string,
    path: string,
    number: number,
    host?: string,
    /** True for a GitLab reference such as `group/project!12`. */
    gitlab = false,
  ): Promise<PullRequestDetail & { membershipId: string | null }> {
    const login = this.state.knownLogin(account);

    this.state.assertNotCoolingDown(login);

    // Every read below is this account's, whatever is selected meanwhile.
    const client = bindForge(this.github, login);

    const { forge, host: accountHost } = parseAccount(login);
    // This account's own GitLab web address, in use or not: another's could have another root.
    const webUrl = this.state.accountOf(login)?.webUrl;
    const instance = instanceUrl(webUrl);
    // A link names the web host, which GitLab can serve apart from glab's host name for its API.
    const hosts = [accountHost, instance ? new URL(instance).host : null].filter(
      (candidate): candidate is string => Boolean(candidate),
    );

    if (host && !hosts.some((candidate) => candidate.toLowerCase() === host.toLowerCase()))
      throw new ReviewError(
        'OTHER_HOST',
        409,
        `That ${forge === 'gitlab' ? 'link' : 'PR'} is on ${host}, but you are working as ${login}. Switch to an account on ${host} to add it.`,
      );

    const { reference } = traitsOf(login);

    // A nested path or a `group/project!12` reference names a GitLab project; GitHub would read
    // only its first two segments and could find a different PR.
    if (!reference.nestedPaths && (gitlab || path.split('/').length !== 2))
      throw new ReviewError(
        'OTHER_HOST',
        409,
        `${path}${gitlab ? `!${number}` : ''} looks like a GitLab merge request, but you are working as ${login} on GitHub. Switch to a GitLab account to add it.`,
      );

    // Only a link carries the relative URL root; a typed `group/project!12` never does.
    const repository = forge === 'gitlab' && host ? this.withoutRelativeRoot(path, webUrl) : path;

    if (repository === null)
      throw new ReviewError(
        'OTHER_HOST',
        409,
        `That link is for another GitLab on ${host}, not the one ${login} is signed in to.`,
      );
    const label = `${repository}${reference.separator}${number}`;
    // For GitLab, nothing is saved unless glab is this account before the reads and after them.
    const verify = () =>
      (async () => accountCheck(client)?.(login))().catch((error: unknown) =>
        // A limit met by the check itself cannot be tied to the account.
        Promise.reject(unattributed(error)),
      );

    /** A limit the account met is its cooldown, once glab is confirmed to still be it. */
    const keepLimit = async (error: unknown) => {
      if (!(error instanceof GitHubError) || error.outcome !== 'rate_limit' || !error.retryAt)
        return;

      const confirmed = await verify().then(
        () => true,
        () => false,
      );

      if (confirmed) this.state.deferUntil(error.retryAt, login);
    };
    const reading = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        await keepLimit(error);
        throw error;
      }
    };

    await verify();

    const resolved = await reading(() => client.resolvePull(repository, number));

    if (!resolved)
      throw new ReviewError(
        'NOT_FOUND',
        404,
        `Couldn't find ${label}. Check the link, or make sure ${login} can see that repository.`,
      );

    if (resolved.state !== 'OPEN')
      throw new ReviewError(
        'PR_CLOSED',
        409,
        `${label} is ${resolved.state === 'MERGED' ? 'merged' : 'closed'}, so there is nothing to review.`,
      );

    const observation = this.snapshots.observe(login, resolved.id);
    const cached = this.store.snapshot(login, resolved.id) ?? undefined;
    const feeds = this.store.membership(login).get(resolved.id) ?? [];

    // Fetch before writing anything, so a failure leaves the queue as it was.
    const fetched = await reading(() =>
      client.snapshot(resolved.id, login, ordered([...feeds, 'manual']), cached),
    );

    await verify();

    const sources = () => ordered(this.store.membership(login).get(resolved.id) ?? []);
    let membershipId: string | null = null;
    const snapshot = this.store.transaction(() => {
      membershipId = this.store.addManual(login, resolved.id, isoNow(this.clock));

      const outcome = this.snapshots.commit(observation, fetched, { fingerprint: null, sources });

      // Removed while it was being added: the removal came later, so it stands.
      if (outcome.status === 'invalidated')
        throw new ReviewError('QUEUE_CHANGED', 409, say('queue.removed-while-adding'));

      // A newer read found it merged or closed: nothing to review, and nothing is added.
      if (outcome.snapshot?.state !== 'OPEN')
        throw new ReviewError(
          'PR_CLOSED',
          409,
          `${label} was merged or closed while it was being added, so there is nothing to review.`,
        );

      // A newer read was saved first: keep it, now with the manual source.
      return outcome.status === 'committed'
        ? outcome.snapshot
        : this.snapshots.update(login, resolved.id, (latest) => ({
            ...latest,
            sources: sources(),
          }));
    });

    this.events.emit({ type: 'pulls.changed', account: login, ids: [resolved.id] });

    const detail = snapshot ? this.reads.detailOf(login, snapshot) : null;

    if (!detail) throw new ReviewError('QUEUE_CHANGED', 409, say('queue.removed-while-adding'));

    // Null when it was already added by hand: an Undo would remove that earlier membership.
    return { ...detail, membershipId };
  }

  /**
   * A GitLab link's project path without the instance's relative URL root: for a GitLab served at
   * `https://example.com/gitlab`, `gitlab/group/project` is the project `group/project`. The root
   * comes from the signed-in account's own profile address, which GitLab writes with it.
   */
  private withoutRelativeRoot(path: string, webUrl: string | undefined): string | null {
    const base = instanceUrl(webUrl);
    const root = base ? new URL(base).pathname.replace(/^\/+|\/+$/g, '') : '';

    if (!root) return path;

    // Every link into this GitLab starts with its root; any other is another instance.
    return path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      ? path.slice(root.length + 1)
      : null;
  }

  /**
   * Removes a PR you added by hand. It stays tracked only while a GitHub feed (a review request,
   * an assignment and so on) still returns it.
   */
  untrack(account: string, id: string, membershipId?: string): { tracked: boolean } {
    const login = this.state.knownLogin(account);
    const cached = this.store.snapshot(login, id);
    const feeds = this.store.membership(login).get(id) ?? [];

    // The snapshot's sources count too: a sync can save them just after the manual row changes.
    if (!cached || (!feeds.includes('manual') && !cached.sources.includes('manual')))
      throw new ReviewError('NOT_ADDED', 409, say('queue.not-added'));

    const remaining = ordered(feeds.filter((feed) => feed !== 'manual'));

    this.store.transaction(() => {
      // An Undo names the membership its add made: one added again since is not its to remove.
      if (!this.store.removeManual(login, id, membershipId) && membershipId !== undefined)
        throw new ReviewError('NOT_ADDED', 409, say('queue.added-again'));

      // Reads that started before the removal must not bring the PR or its old sources back.
      this.snapshots.invalidate(login, id);

      if (remaining.length > 0)
        this.snapshots.update(login, id, (latest) => ({ ...latest, sources: remaining }));
      else this.store.forgetPull(login, id);
    });
    this.events.emit({ type: 'pulls.changed', account: login, ids: [id] });

    return { tracked: remaining.length > 0 };
  }

  /**
   * Records a viewed mark after the forge accepted it, on the stored PR and on reads of it still in
   * flight. Viewed state does not change the PR's fingerprint, so no refetch is needed.
   */
  markViewed(
    account: string,
    id: string,
    path: string,
    viewed: boolean,
    revision: ViewedRevision | null,
  ): boolean {
    const saved = this.snapshots.markViewed(account, id, path, viewed, revision);

    if (saved) this.events.emit({ type: 'pulls.changed', account, ids: [id] });

    return Boolean(saved);
  }

  /** Triage of `account`'s PR, whichever account is selected. */
  updateFor(
    account: string,
    id: string,
    update: Omit<TriageUpdate, 'account'>,
  ): PullRequestDetail | null {
    const detail = this.reads.detailFor(account, id);

    if (!detail) return null;

    const triage = detail.triage;

    if (update.note !== undefined) triage.note = update.note;
    if (update.seenReplyKeys) {
      const valid = new Set(detail.item.unreadReplyKeys);

      triage.seenReplyKeys = [
        ...new Set([
          ...triage.seenReplyKeys,
          ...update.seenReplyKeys.filter((key) => valid.has(key)),
        ]),
      ];
    }

    if (update.snoozeUntil !== undefined) {
      triage.snoozedUntil = update.snoozeUntil;
      triage.snoozedActivityKeys = detail.item.activityKeys;
    }

    if (update.done !== undefined) {
      triage.doneAt = update.done ? isoNow(this.clock) : null;
      triage.doneActivityKeys = update.done ? detail.item.activityKeys : [];

      if (update.done) {
        triage.snoozedUntil = null;
        triage.snoozedActivityKeys = [];
      }
    }

    this.store.saveTriage(account, id, triage);
    this.events.emit({ type: 'triage.updated', account, id });

    return this.reads.detailFor(account, id);
  }
}
