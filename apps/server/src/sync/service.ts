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
import type { Store } from '@/db/store.js';
import { EventBus } from '@/events.js';
import type { DetectResult, GitHubApi } from '@/github/api.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { GitHub } from '@/github/read.js';
import { extractActivity } from '@/insights/extract.js';
import { ReviewError } from '@/review/errors.js';

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
const RECONCILE_MS = 30 * 60_000;
const RECONCILE_JITTER_MS = 5 * 60_000;
const TEAMS_REFRESH_MS = 30 * 60_000;
const QUEUE_SAMPLE_MS = 60 * 60_000;
const MENTION_WINDOW_MS = 14 * 24 * 60 * 60_000;

export interface MineList {
  account: string | null;
  items: AuthorItem[];
}

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const ordered = (sources: Iterable<Source>) =>
  SOURCE_ORDER.filter((source) => [...sources].includes(source));

export class SyncService {
  status: SyncStatus;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly feedRuns = new Map<string, number>();
  private readonly teamsFetched = new Map<string, number>();
  /** PRs that must be fully refetched on the next run regardless of their fingerprint. */
  private readonly forced = new Set<string>();
  /** Runs after every sync with the active login (used for notifications). */
  afterSync: ((login: string) => Promise<unknown>) | null = null;

  constructor(
    readonly store: Store,
    readonly github: GitHubApi = new GitHub(),
    readonly events = new EventBus(),
  ) {
    const lastAccount = store.getSetting<string>('lastAccount');

    this.status =
      (lastAccount && store.getSetting<SyncStatus>(`status:${lastAccount}`)) || initialStatus();
    this.status.syncing = false;
  }

  start(): void {
    void this.sync();
    this.timer = setInterval(() => {
      void this.sync({ scheduled: true });
    }, SYNC_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    await this.running;
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
    if (this.cooldown()) return Promise.resolve();

    this.running = this.perform(Boolean(options.scheduled)).finally(() => {
      this.running = null;
    });

    return this.running;
  }

  private assertNotCoolingDown(): void {
    const retryAt = this.cooldown();

    if (retryAt)
      throw new GitHubError(
        'GitHub is rate limited. Saved data is still available.',
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
        'GitHub account changed. Refresh before changing your queue.',
      );

    return login;
  }

  /** Refetches one PR immediately (after opening it or after a write), bypassing detection. */
  async refresh(id: string): Promise<PullRequestDetail | null> {
    this.assertNotCoolingDown();

    const account = this.status.account?.login;
    const cached = account ? this.store.snapshot(account, id) : null;

    if (!account || !cached) return null;

    const snapshot = await this.github.snapshot(id, account, cached.sources, cached);
    const current = this.store.snapshot(account, id);

    // Removed from the queue while it was being fetched: do not bring it back.
    if (!current) return null;

    // Keep the stored sources: a PR may have been added or removed by hand during the fetch.
    this.commitSnapshot(account, { ...snapshot, sources: current.sources }, null);
    this.events.emit({ type: 'pulls.changed', ids: [id] });

    return this.detail(id);
  }

  /**
   * Adds a PR to the queue by hand. From then on it is tracked like any other PR: it stays until it
   * is closed or merged, or until you remove it with `untrack`. Adding a tracked PR is harmless.
   */
  async track(account: string, repository: string, number: number): Promise<PullRequestDetail> {
    const login = this.activeLogin(account);

    this.assertNotCoolingDown();

    const label = `${repository}#${number}`;
    const resolved = await this.github.resolvePull(repository, number);

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

    const cached = this.store.snapshot(login, resolved.id) ?? undefined;
    const feeds = this.store.membership(login).get(resolved.id) ?? [];

    // Fetch before writing anything, so a failure leaves the queue as it was.
    const snapshot = await this.github.snapshot(
      resolved.id,
      login,
      ordered([...feeds, 'manual']),
      cached,
    );

    this.store.transaction(() => {
      this.store.addManual(login, snapshot.id, new Date().toISOString());
      this.commitSnapshot(login, snapshot, null);
    });
    this.events.emit({ type: 'pulls.changed', ids: [snapshot.id] });

    const detail = this.detail(snapshot.id);

    if (!detail) throw new ReviewError('ACCOUNT_CHANGED', 409, 'GitHub account changed. Refresh.');

    return detail;
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

      if (remaining.length > 0) this.store.saveSnapshot(login, { ...cached, sources: remaining });
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
      const detected = await this.detect(ids);

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
            `${cached ? `${cached.repository}#${cached.number}` : id} is unavailable; its cached record was retained.`,
          );
          continue;
        }

        if (result && result.state !== 'OPEN') {
          // Closure or merge is confirmed by GitHub, so the PR can leave the list.
          if (cached) {
            const closed = { ...cached, state: result.state! };

            this.store.saveSnapshot(account.login, closed);
            this.store.recordActivity(
              account.login,
              extractActivity(closed, account.login, this.status.teams),
            );
            changed.add(id);
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
          this.store.saveSnapshot(account.login, { ...cached, sources });
          changed.add(id);
        }
      }

      let cursor = 0;
      const worker = async () => {
        while (cursor < fetches.length && !retryAt) {
          const { id, sources, cached, result } = fetches[cursor++];

          try {
            const snapshot = await this.github.snapshot(id, account.login, sources, cached);

            // Removed from the queue while it was being fetched: do not bring it back.
            if (cached && !this.store.snapshot(account.login, id)) continue;

            // Added or removed by hand during the fetch: keep that change.
            this.commitSnapshot(
              account.login,
              { ...snapshot, sources: this.withManual(account.login, id, snapshot.sources) },
              result?.fingerprint ?? null,
            );
            this.forced.delete(id);
            changed.add(id);
          } catch (error) {
            this.status.warnings.push(
              `${cached ? `${cached.repository}#${cached.number}` : id}: ${safeError(error)}`,
            );

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
        this.status.error =
          'GitHub rate limit reached. Refresh will resume automatically after the cooldown.';
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
  private async detect(ids: string[]): Promise<{
    results: Map<string, DetectResult> | null;
    lowBudget: boolean;
    retryAt: string | null;
  }> {
    if (ids.length === 0) return { results: new Map(), lowBudget: false, retryAt: null };

    try {
      const { results, budget } = await this.github.detect(ids);

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

  /** Saves a fresh snapshot with its sync bookkeeping, wake-ups and activity history. */
  private commitSnapshot(
    login: string,
    snapshot: PullRequestSnapshot,
    fingerprint: string | null,
  ): void {
    const now = Date.now();
    const jitter = Math.floor(Math.random() * RECONCILE_JITTER_MS);

    this.store.saveSnapshot(login, snapshot);
    this.store.saveSyncState(login, snapshot.id, {
      fingerprint,
      lastFullAt: new Date(now).toISOString(),
      nextFullAt: new Date(now + RECONCILE_MS + jitter).toISOString(),
    });
    this.store.recordActivity(login, extractActivity(snapshot, login, this.status.teams));

    const triage = this.store.triage(login, snapshot.id);
    const item = deriveItem(snapshot, triage, login, this.status.teams);
    const wokeFromSnooze = Boolean(triage.snoozedUntil && !item.snoozedUntil);
    const wokeFromDone = Boolean(triage.doneAt && !item.doneAt && !item.snoozedUntil);

    // New activity permanently ends a snooze or a "done" mark, even if it is later reviewed.
    if (wokeFromSnooze || wokeFromDone) {
      this.store.saveTriage(login, snapshot.id, {
        ...triage,
        ...(wokeFromSnooze ? { snoozedUntil: null, snoozedActivityKeys: [] } : {}),
        ...(wokeFromDone ? { doneAt: null, doneActivityKeys: [] } : {}),
      });
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

  private openSnapshots(account: string): PullRequestSnapshot[] {
    return this.store.snapshots(account).filter((pr) => pr.state === 'OPEN');
  }

  /** The reviewer inbox: PRs you review or were asked about, never your own. */
  list(): PullRequestList {
    const account = this.status.account?.login;

    if (!account) return { account: null, items: [] };

    const now = Date.now();
    const items = this.openSnapshots(account)
      .filter((pr) => !sameLogin(pr.author.login, account))
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
          .filter((pr) => sameLogin(pr.author.login, account))
          .map((pr) =>
            deriveAuthorItem(pr, account, this.store.triage(account, pr.id).note.trim().length > 0),
          ),
      ),
    };
  }

  detail(id: string): PullRequestDetail | null {
    const account = this.status.account?.login;
    const snapshot = account ? this.store.snapshot(account, id) : null;

    if (!account || !snapshot || snapshot.state !== 'OPEN') return null;

    const triage = this.store.triage(account, id);

    return {
      account,
      snapshot,
      triage,
      item: deriveItem(snapshot, triage, account, this.status.teams),
    };
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
