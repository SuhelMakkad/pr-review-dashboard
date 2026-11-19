import { deriveItem, sortItems } from '@review-desk/shared/attention';
import { deriveAuthorItem, sortAuthorItems, type AuthorItem } from '@review-desk/shared/author';
import { isLegacySnapshot } from '@review-desk/shared/snapshot';
import {
  FEED_SOURCES,
  REVIEW_SOURCES,
  type FeedSource,
  type PullRequestDetail,
  type PullRequestList,
  type PullRequestSnapshot,
  type Source,
  type SyncStatus,
  type TriageUpdate,
} from '@review-desk/shared/types';
import {
  forForge,
  forgeTerms,
  fullRef,
  instanceUrl,
  isSameUser,
  parseAccount,
} from '@review-desk/shared/accounts';
import type { Store } from '@/db/store.js';
import { EventBus } from '@/events.js';
import type { DetectResult, GitHubApi } from '@/github/api.js';
import { asAccount, type GitHubAccounts } from '@/github/credentials.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { GitHub } from '@/github/read.js';
import type { ViewedRevision } from '@/github/write.js';
import { ReviewError } from '@/review/errors.js';
import { SnapshotCoordinator } from '@/sync/snapshots.js';

const signInCommand = (account: string) => {
  const { forge, host } = parseAccount(account);

  return forge === 'gitlab' ? `glab auth login --hostname ${host}` : 'gh auth login';
};

export const initialStatus = (): SyncStatus => ({
  account: null,
  teams: [],
  syncing: false,
  lastAttemptAt: null,
  lastCompletedAt: null,
  lastSuccessfulSync: null,
  nextSyncAt: null,
  retryAt: null,
  error: null,
  warnings: [],
});

/** Canonical order for a PR's sources. */
const SOURCE_ORDER: Source[] = [...FEED_SOURCES, 'manual'];

/** How often each discovery feed runs on the background schedule. Manual syncs run them all. */
const FEED_INTERVAL_MS: Record<FeedSource, number> = {
  requested: 60_000,
  authored: 120_000,
  assigned: 300_000,
  reviewed: 300_000,
  mentioned: 300_000,
};

const SYNC_INTERVAL_MS = 60_000;
const TEAMS_REFRESH_MS = 30 * 60_000;
const QUEUE_SAMPLE_MS = 60 * 60_000;
const MENTION_WINDOW_MS = 14 * 24 * 60 * 60_000;

export interface MineList {
  account: string | null;
  items: AuthorItem[];
}

/** The account picked in the app; when absent, the GitHub CLI's active account is used. */
export const SELECTED_ACCOUNT_KEY = 'selectedAccount';

/** Account keys match exactly (ignoring case): `alice` on GitHub is not `alice@gitlab.com`. */
const sameAccount = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const ordered = (sources: Iterable<Source>) =>
  SOURCE_ORDER.filter((source) => [...sources].includes(source));

export class SyncService {
  status: SyncStatus;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly feedRuns = new Map<string, number>();
  private readonly teamsFetched = new Map<string, number>();
  /** PRs that must be fully refetched on the next run regardless of their fingerprint. */
  private readonly forced = new Set<string>();
  /** Runs after every sync with the active login (used for notifications). */
  afterSync: ((login: string) => Promise<unknown>) | null = null;
  /** Every write of a cached PR goes through here, so reads are saved in order. */
  private readonly snapshots: SnapshotCoordinator;

  constructor(
    readonly store: Store,
    readonly github: GitHubApi = new GitHub(),
    readonly events = new EventBus(),
    /** Lets the app switch GitHub CLI accounts; null where the account is fixed. */
    readonly accounts: GitHubAccounts | null = null,
  ) {
    const lastAccount = store.getSetting<string>('lastAccount');
    const selected = store.getSetting<string>(SELECTED_ACCOUNT_KEY);

    this.status =
      (lastAccount && store.getSetting<SyncStatus>(`status:${lastAccount}`)) || initialStatus();
    this.status.syncing = false;
    this.snapshots = new SnapshotCoordinator(store, (account) => this.teamsOf(account));

    if (selected) accounts?.select(selected);
  }

  start(): void {
    if (this.stopped) return;

    void this.sync();
    this.timer = setInterval(() => {
      void this.sync({ scheduled: true });
    }, SYNC_INTERVAL_MS);
  }

  /** Stops the schedule and waits for a sync in progress; no sync starts after this. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) clearInterval(this.timer);

    this.timer = null;

    await this.running?.catch(() => undefined);
  }

  /** Share write cooldowns with reads so a manual/background sync cannot bypass GitHub's limit. */
  deferUntil(retryAt: string): void {
    const account = this.status.account?.login;
    if (!account) return;

    const until = new Date(
      Math.max(Date.parse(retryAt), this.status.retryAt ? Date.parse(this.status.retryAt) : 0),
    ).toISOString();
    this.store.setSetting(`github-write-retry:${account}`, until);
    this.status = { ...this.status, retryAt: until, nextSyncAt: until };
    this.store.saveStatus(this.status);
    this.emitStatus();
  }

  private cooldown(): string | null {
    const account = this.status.account?.login;
    const saved = account ? this.store.getSetting<string>(`github-write-retry:${account}`) : null;
    const until = Math.max(
      saved ? Date.parse(saved) : 0,
      this.status.retryAt ? Date.parse(this.status.retryAt) : 0,
    );

    return until > Date.now() ? new Date(until).toISOString() : null;
  }

  /**
   * Runs one sync. Scheduled runs respect per-feed cadences; explicit runs (startup, "Sync now",
   * tests) run every feed. Concurrent calls share the run in progress.
   */
  sync(options: { scheduled?: boolean } = {}): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped || this.cooldown()) return Promise.resolve();

    const run = this.perform(Boolean(options.scheduled)).finally(() => {
      if (this.running === run) this.running = null;
    });

    this.running = run;

    return run;
  }

  /**
   * Switches to another account signed in to the GitHub CLI, without changing the CLI's own
   * active account. A sync in progress finishes as the previous account first, then the new
   * account's saved queue shows at once while a sync fetches its current state.
   */
  async switchAccount(from: string | null, to: string): Promise<SyncStatus> {
    const accounts = this.accounts;

    if (!accounts)
      throw new ReviewError('UNSUPPORTED', 409, 'Switching accounts is not available here.');

    const target = (await accounts.list()).find((account) => sameAccount(account.login, to));
    const signIn = signInCommand(to);

    if (!target)
      throw new ReviewError(
        'NOT_SIGNED_IN',
        404,
        `${to} is not signed in to the ${forgeTerms(to).name} CLI. Run ${signIn} to add it.`,
      );

    if (!target.ok)
      throw new ReviewError(
        'SIGN_IN_FAILED',
        409,
        `The ${forgeTerms(to).name} CLI could not verify ${target.login}. Run ${signIn} to sign in again.`,
      );

    const previous = this.running;
    const switching = (async () => {
      await previous?.catch(() => undefined);

      // Checked after the previous sync, which can itself notice a different account.
      if ((this.status.account?.login ?? null) !== from)
        throw new ReviewError(
          'ACCOUNT_CHANGED',
          409,
          this.worded('GitHub account changed. Refresh before switching.'),
        );

      accounts.select(target.login);
      this.store.setSetting(SELECTED_ACCOUNT_KEY, target.login);

      if (target.login !== from) {
        const saved = this.store.getSetting<SyncStatus>(`status:${target.login}`);

        this.status = {
          ...(saved ?? initialStatus()),
          account: saved?.account ?? { login: target.login },
          syncing: false,
          error: null,
          warnings: [],
        };
        this.store.saveStatus(this.status);
        this.emitStatus();
      }
    })();
    const run = switching
      .catch(() => undefined)
      .finally(() => {
        if (this.running === run) this.running = null;
      });

    this.running = run;

    // Wait until the switch no longer counts as running, or this sync would only rejoin it.
    await run;
    await switching;
    void this.sync();

    return this.status;
  }

  private assertNotCoolingDown(): void {
    const retryAt = this.cooldown();

    if (retryAt)
      throw new GitHubError(
        this.worded('GitHub is rate limited. Saved data is still available.'),
        retryAt,
        429,
        'rate_limit',
      );
  }

  /** The active login, or ACCOUNT_CHANGED when a request was made for a different account. */
  private activeLogin(account: string): string {
    const login = this.status.account?.login;

    if (!login || login !== account)
      throw new ReviewError(
        'ACCOUNT_CHANGED',
        409,
        this.worded('GitHub account changed. Refresh before changing your queue.'),
      );

    return login;
  }

  /**
   * Refetches one PR immediately (after opening it, or before and after a write), bypassing
   * detection. Every call starts its own read, so the result was fetched after the call began:
   * either this read, or a read that started later and was saved first. Null when the PR is not
   * tracked, or no longer open.
   */
  async refresh(
    id: string,
    account: string | null = this.status.account?.login ?? null,
  ): Promise<PullRequestDetail | null> {
    this.assertNotCoolingDown();

    if (!account) return null;

    // A read is refused when the PR is removed or reduced after it started; the row left behind
    // can be older than the read, so read again rather than return it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const observation = this.snapshots.observe(account, id);
      const cached = this.store.snapshot(account, id);

      if (!cached) return null;

      const fetched = await asAccount(account, () =>
        this.github.snapshot(id, account, cached.sources, cached),
      );
      // Keep the stored sources: a PR may have been added or removed by hand during the fetch.
      const outcome = this.snapshots.commit(observation, fetched, {
        fingerprint: null,
        requireStored: true,
        sources: (latest) => latest?.sources ?? fetched.sources,
      });

      if (outcome.status === 'invalidated' && outcome.snapshot) continue;
      if (outcome.status === 'committed') this.events.emit({ type: 'pulls.changed', ids: [id] });

      return outcome.snapshot ? this.detailOf(account, outcome.snapshot) : null;
    }

    throw new ReviewError(
      'QUEUE_CHANGED',
      409,
      this.worded('This PR kept changing in your queue while it was refreshed. Try again.'),
    );
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
  ): Promise<PullRequestDetail> {
    const login = this.activeLogin(account);

    this.assertNotCoolingDown();

    const { forge, host: accountHost } = parseAccount(login);
    const instance = instanceUrl(this.status.account?.webUrl);
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

    // A nested path or a `group/project!12` reference names a GitLab project; GitHub would read
    // only its first two segments and could find a different PR.
    if (forge === 'github' && (gitlab || path.split('/').length !== 2))
      throw new ReviewError(
        'OTHER_HOST',
        409,
        `${path}${gitlab ? `!${number}` : ''} looks like a GitLab merge request, but you are working as ${login} on GitHub. Switch to a GitLab account to add it.`,
      );

    // Only a link carries the relative URL root; a typed `group/project!12` never does.
    const repository = forge === 'gitlab' && host ? this.withoutRelativeRoot(path) : path;

    if (repository === null)
      throw new ReviewError(
        'OTHER_HOST',
        409,
        `That link is for another GitLab on ${host}, not the one ${login} is signed in to.`,
      );
    const label = `${repository}${forge === 'gitlab' ? '!' : '#'}${number}`;
    const resolved = await asAccount(login, () => this.github.resolvePull(repository, number));

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
    const fetched = await asAccount(login, () =>
      this.github.snapshot(resolved.id, login, ordered([...feeds, 'manual']), cached),
    );
    const sources = () => ordered(this.store.membership(login).get(resolved.id) ?? []);
    const snapshot = this.store.transaction(() => {
      this.store.addManual(login, resolved.id, new Date().toISOString());

      const outcome = this.snapshots.commit(observation, fetched, { fingerprint: null, sources });

      // Removed while it was being added: the removal came later, so it stands.
      if (outcome.status === 'invalidated')
        throw new ReviewError(
          'QUEUE_CHANGED',
          409,
          this.worded(
            'This PR was removed from your queue while it was being added. Add it again.',
          ),
        );

      // A newer read was saved first: keep it, now with the manual source.
      return outcome.status === 'committed'
        ? outcome.snapshot
        : this.snapshots.update(login, resolved.id, (latest) => ({
            ...latest,
            sources: sources(),
          }));
    });

    this.events.emit({ type: 'pulls.changed', ids: [resolved.id] });

    const detail = snapshot ? this.detailOf(login, snapshot) : null;

    if (!detail)
      throw new ReviewError(
        'ACCOUNT_CHANGED',
        409,
        this.worded('GitHub account changed. Refresh.'),
      );

    return detail;
  }

  /**
   * A GitLab link's project path without the instance's relative URL root: for a GitLab served at
   * `https://example.com/gitlab`, `gitlab/group/project` is the project `group/project`. The root
   * comes from the signed-in account's own profile address, which GitLab writes with it.
   */
  private withoutRelativeRoot(path: string): string | null {
    const base = instanceUrl(this.status.account?.webUrl);
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
  untrack(account: string, id: string): { tracked: boolean } {
    const login = this.activeLogin(account);
    const cached = this.store.snapshot(login, id);
    const feeds = this.store.membership(login).get(id) ?? [];

    // The snapshot's sources count too: a sync can save them just after the manual row changes.
    if (!cached || (!feeds.includes('manual') && !cached.sources.includes('manual')))
      throw new ReviewError('NOT_ADDED', 409, 'Only PRs you added yourself can be removed.');

    const remaining = ordered(feeds.filter((feed) => feed !== 'manual'));

    this.store.transaction(() => {
      this.store.removeManual(login, id);
      // Reads that started before the removal must not bring the PR or its old sources back.
      this.snapshots.invalidate(login, id);

      if (remaining.length > 0)
        this.snapshots.update(login, id, (latest) => ({ ...latest, sources: remaining }));
      else this.store.forgetPull(login, id);
    });
    this.forced.delete(id);
    this.events.emit({ type: 'pulls.changed', ids: [id] });

    return { tracked: remaining.length > 0 };
  }

  private async perform(scheduled: boolean): Promise<void> {
    this.status = {
      ...this.status,
      syncing: true,
      error: null,
      warnings: [],
      lastAttemptAt: new Date().toISOString(),
    };
    this.emitStatus();

    let retryAt: string | null = null;
    const changed = new Set<string>();

    try {
      const account = await this.github.identity();

      if (account.login !== this.status.account?.login) {
        const saved = this.store.getSetting<SyncStatus>(`status:${account.login}`);

        this.status = {
          ...(saved ?? initialStatus()),
          account,
          syncing: true,
          error: null,
          warnings: [],
          lastAttemptAt: this.status.lastAttemptAt,
        };
      } else {
        this.status.account = account;
      }

      // Kept from the last sync when it cannot be read now.
      this.status.capabilities =
        (await this.github.capabilities?.().catch(() => this.status.capabilities)) ??
        this.status.capabilities;

      await this.refreshTeams(account.login, scheduled);

      retryAt = await this.discover(account.login, scheduled);

      const membership = this.store.membership(account.login);
      const previous = new Map(
        this.store
          .snapshots(account.login)
          .filter((pr) => pr.state === 'OPEN')
          .map((pr) => [pr.id, pr]),
      );
      const ids = [...new Set([...membership.keys(), ...previous.keys()])];
      // Change detection reads every PR's state, so it starts a read of each before asking.
      const observations = new Map(
        ids.map((id) => [id, this.snapshots.observe(account.login, id)]),
      );
      // CI that is still running, as saved: a read that was not saved cannot change what is polled.
      const ciPending = new Set(
        [...previous.values()].filter((pr) => pr.ci === 'pending').map((pr) => pr.id),
      );
      const detected = await this.detect(ids, ciPending);

      if (detected.retryAt) retryAt = detected.retryAt;

      const fetches: {
        id: string;
        sources: Source[];
        cached?: PullRequestSnapshot;
        result: DetectResult | null;
      }[] = [];
      const now = Date.now();

      for (const id of ids) {
        const cached = previous.get(id);
        const result = detected.results?.get(id) ?? null;
        const sources = ordered(membership.get(id) ?? cached?.sources ?? []);

        if (result && result.state === null) {
          this.status.warnings.push(
            `${cached ? fullRef(cached) : id} is unavailable; its cached record was retained.`,
          );
          continue;
        }

        if (result && result.state !== 'OPEN') {
          // Closure or merge is confirmed by GitHub, so the PR can leave the list.
          if (cached) {
            const outcome = this.snapshots.commitState(observations.get(id)!, result.state!);

            if (outcome.status === 'committed') changed.add(id);
          }

          continue;
        }

        const sync = this.store.syncState(account.login, id);
        const reconcileDue =
          !detected.lowBudget && (!sync?.nextFullAt || Date.parse(sync.nextFullAt) <= now);
        const needsSnapshot =
          !cached ||
          !result ||
          isLegacySnapshot(cached) ||
          this.forced.has(id) ||
          sync?.fingerprint !== result.fingerprint ||
          reconcileDue;

        if (needsSnapshot) {
          fetches.push({ id, sources, cached, result });
        } else if (cached && sources.join() !== cached.sources.join()) {
          // Onto the latest row, which a refresh may have replaced since this sync read it, and
          // with the manual source as it is now.
          const saved = this.snapshots.update(account.login, id, (latest) => ({
            ...latest,
            sources: this.withManual(account.login, id, sources),
          }));

          if (saved) changed.add(id);
        }
      }

      let cursor = 0;
      const worker = async () => {
        while (cursor < fetches.length && !retryAt) {
          const { id, sources, cached, result } = fetches[cursor++];
          const observation = this.snapshots.observe(account.login, id);
          const latest = this.store.snapshot(account.login, id) ?? undefined;

          // Removed from the queue since this sync read it: do not bring it back.
          if (cached && !latest) continue;

          try {
            const snapshot = await this.github.snapshot(id, account.login, sources, latest);
            const outcome = this.snapshots.commit(observation, snapshot, {
              fingerprint: result?.fingerprint ?? null,
              // Removed from the queue while it was being fetched: do not bring it back.
              requireStored: Boolean(cached),
              // Added or removed by hand during the fetch: keep that change.
              sources: () => this.withManual(account.login, id, snapshot.sources),
            });

            // A read that started later (such as a refresh) was saved first, or the PR was
            // removed: either way this read is older than what is stored.
            if (outcome.status !== 'committed') continue;

            this.forced.delete(id);
            changed.add(id);
          } catch (error) {
            this.status.warnings.push(`${cached ? fullRef(cached) : id}: ${safeError(error)}`);

            if (error instanceof GitHubError && error.retryAt) retryAt = error.retryAt;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(3, fetches.length) }, worker));

      this.sampleQueue(account.login);

      if (this.afterSync) {
        // Hooks (notifications) must never break a sync.
        await this.afterSync(account.login).catch(() => undefined);
      }

      if (this.status.warnings.length === 0)
        this.status.lastSuccessfulSync = new Date().toISOString();
      if (retryAt)
        this.status.error = this.worded(
          'GitHub rate limit reached. Refresh will resume automatically after the cooldown.',
        );
    } catch (error) {
      this.status.error = safeError(error);
      retryAt = error instanceof GitHubError ? error.retryAt : null;
    } finally {
      const now = new Date().toISOString();

      this.status = {
        ...this.status,
        syncing: false,
        lastCompletedAt: now,
        retryAt,
        nextSyncAt: retryAt ?? new Date(Date.now() + SYNC_INTERVAL_MS).toISOString(),
      };
      this.store.saveStatus(this.status);
      this.emitStatus();

      if (changed.size > 0) this.events.emit({ type: 'pulls.changed', ids: [...changed] });
    }
  }

  /** `sources` with `manual` present exactly when the PR is added by hand right now. */
  private withManual(login: string, id: string, sources: Source[]): Source[] {
    const manual = this.store.manualAddedAt(login, id) !== null;

    return ordered([
      ...sources.filter((source) => source !== 'manual'),
      ...(manual ? ['manual' as const] : []),
    ]);
  }

  private async refreshTeams(login: string, scheduled: boolean): Promise<void> {
    const fetchedAt = this.teamsFetched.get(login) ?? 0;

    if (scheduled && Date.now() - fetchedAt < TEAMS_REFRESH_MS) return;

    try {
      this.status.teams = await this.github.teams();
      this.teamsFetched.set(login, Date.now());
    } catch (error) {
      if (error instanceof GitHubError && error.retryAt) throw error;

      this.status.warnings.push(
        `Team membership could not be refreshed. Team request details may be incomplete. ${safeError(error)}`,
      );
    }
  }

  /**
   * Runs due discovery feeds. A successful feed replaces its membership; a failed feed leaves its
   * previous membership untouched, so a transient search failure never drops a PR's source.
   */
  private async discover(login: string, scheduled: boolean): Promise<string | null> {
    const now = Date.now();
    const due = FEED_SOURCES.filter(
      (source) =>
        !scheduled ||
        now - (this.feedRuns.get(`${login}:${source}`) ?? 0) >= FEED_INTERVAL_MS[source],
    );
    const feeds = await Promise.allSettled(
      due.map((source) => this.github.discover(login, source)),
    );
    let retryAt: string | null = null;

    feeds.forEach((feed, index) => {
      const source = due[index];

      if (feed.status === 'fulfilled') {
        this.store.replaceFeed(login, source, feed.value, new Date().toISOString());
        this.feedRuns.set(`${login}:${source}`, now);
        return;
      }

      this.status.warnings.push(`${source} search incomplete: ${safeError(feed.reason)}`);

      if (feed.reason instanceof GitHubError && feed.reason.retryAt) retryAt = feed.reason.retryAt;
    });

    return retryAt;
  }

  /** Fingerprints every candidate PR in a few cheap requests. A failure falls back to full fetches. */
  private async detect(
    ids: string[],
    ciPending: ReadonlySet<string>,
  ): Promise<{
    results: Map<string, DetectResult> | null;
    lowBudget: boolean;
    retryAt: string | null;
  }> {
    if (ids.length === 0) return { results: new Map(), lowBudget: false, retryAt: null };

    try {
      const { results, budget } = await this.github.detect(ids, { ciPending });

      return {
        results: new Map(results.map((result) => [result.id, result])),
        lowBudget: Boolean(budget && budget.remaining < budget.limit * 0.1),
        retryAt: null,
      };
    } catch (error) {
      if (error instanceof GitHubError && error.retryAt) {
        this.status.warnings.push(`Change detection paused: ${safeError(error)}`);

        return { results: new Map(), lowBudget: true, retryAt: error.retryAt };
      }

      this.status.warnings.push(
        `Change detection unavailable; refetching every PR. ${safeError(error)}`,
      );

      return { results: null, lowBudget: false, retryAt: null };
    }
  }

  /** Hourly queue-size samples feed the insights page. */
  private sampleQueue(login: string): void {
    const last = this.store.lastQueueSampleAt(login);

    if (last && Date.now() - Date.parse(last) < QUEUE_SAMPLE_MS) return;

    const items = this.list().items;
    const attention = items.filter((item) => item.queue === 'attention');

    this.store.saveQueueSample(login, {
      at: new Date().toISOString(),
      attention: attention.length,
      waiting: items.filter((item) => item.queue === 'waiting').length,
      authoredBlocked: this.mine().items.filter((item) => item.group === 'needs_you').length,
      oldestAttentionAt: attention.map((item) => item.attentionAt).sort()[0] ?? null,
    });
  }

  private emitStatus(): void {
    this.events.emit({ type: 'status', status: structuredClone(this.status) });
  }

  /** A message written for GitHub, worded for the current account's forge. */
  private worded(text: string): string {
    return forForge(text, this.status.account?.login);
  }

  private openSnapshots(account: string): PullRequestSnapshot[] {
    return this.store.snapshots(account).filter((pr) => pr.state === 'OPEN');
  }

  /** The reviewer inbox: PRs you review or were asked about, never your own. */
  list(): PullRequestList {
    const account = this.status.account?.login;

    if (!account) return { account: null, items: [] };

    const now = Date.now();
    const items = this.openSnapshots(account)
      .filter((pr) => !isSameUser(pr.author.login, account))
      .filter(
        (pr) =>
          pr.sources.length === 0 || pr.sources.some((source) => REVIEW_SOURCES.includes(source)),
      )
      .map((pr) => ({
        pr,
        item: deriveItem(pr, this.store.triage(account, pr.id), account, this.status.teams),
      }))
      .filter(({ pr, item }) => {
        const mentionOnly =
          pr.sources.every((source) => source === 'mentioned') && pr.sources.length > 0;

        // A mention alone keeps a PR around only while it is recent or still unread.
        return (
          !mentionOnly ||
          item.reasons.length > 0 ||
          now - Date.parse(pr.updatedAt) < MENTION_WINDOW_MS
        );
      })
      .map(({ item }) => item);

    return { account, items: sortItems(items) };
  }

  /** The author view: your own open PRs and what blocks each one. */
  mine(): MineList {
    const account = this.status.account?.login;

    if (!account) return { account: null, items: [] };

    return {
      account,
      items: sortAuthorItems(
        this.openSnapshots(account)
          .filter((pr) => isSameUser(pr.author.login, account))
          .map((pr) =>
            deriveAuthorItem(pr, account, this.store.triage(account, pr.id).note.trim().length > 0),
          ),
      ),
    };
  }

  detail(id: string): PullRequestDetail | null {
    const account = this.status.account?.login;
    const snapshot = account ? this.store.snapshot(account, id) : null;

    return account && snapshot ? this.detailOf(account, snapshot) : null;
  }

  /** A stored snapshot with its triage, or null when the PR is no longer open. */
  private detailOf(account: string, snapshot: PullRequestSnapshot): PullRequestDetail | null {
    if (snapshot.state !== 'OPEN') return null;

    const triage = this.store.triage(account, snapshot.id);

    return {
      account,
      snapshot,
      triage,
      item: deriveItem(snapshot, triage, account, this.teamsOf(account)),
    };
  }

  /**
   * The teams of `account`: as last synced for the account in use, else as saved with its last
   * status. A read started as one account can finish after a switch to another.
   */
  private teamsOf(account: string): string[] {
    if (sameAccount(account, this.status.account?.login ?? '')) return this.status.teams;

    return this.store.getSetting<SyncStatus>(`status:${account}`)?.teams ?? [];
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

    if (saved) this.events.emit({ type: 'pulls.changed', ids: [id] });

    return Boolean(saved);
  }

  update(id: string, update: TriageUpdate): PullRequestDetail | null {
    if (update.account !== this.status.account?.login) throw new Error('ACCOUNT_CHANGED');

    const detail = this.detail(id);

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
      triage.doneAt = update.done ? new Date().toISOString() : null;
      triage.doneActivityKeys = update.done ? detail.item.activityKeys : [];

      if (update.done) {
        triage.snoozedUntil = null;
        triage.snoozedActivityKeys = [];
      }
    }

    this.store.saveTriage(update.account, id, triage);
    this.events.emit({ type: 'triage.updated', id });

    return this.detail(id);
  }
}
