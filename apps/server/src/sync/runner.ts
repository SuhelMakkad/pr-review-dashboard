import { AccountUnavailable, unattributed } from '@/forge/account.js';
import { isoNow, type Cancel, type Clock } from '@/clock.js';
import { isLegacySnapshot } from '@review-desk/shared/snapshot';
import {
  FEED_SOURCES,
  type FeedSource,
  type PullRequestSnapshot,
  type Source,
  type SyncStatus,
} from '@review-desk/shared/types';
import { forgeOf, forgeTerms, fullRef, parseAccount } from '@review-desk/shared/accounts';
import { performance } from 'node:perf_hooks';
import type { Store } from '@/db/store.js';
import { log } from '@/log.js';
import type { EventBus } from '@/events.js';
import type { DetectResult, GitHubApi } from '@/github/api.js';
import { type GitHubAccounts, unscoped } from '@/github/credentials.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { ReviewError } from '@/review/errors.js';
import { laterDeadline, sameAccount, type AccountState } from '@/sync/accounts.js';
import type { PullReads } from '@/sync/reads.js';
import type { SnapshotCoordinator } from '@/sync/snapshots.js';
import { ordered } from '@/sync/sources.js';
import { SELECTED_ACCOUNT } from '@/db/settings.js';

const signInCommand = (account: string) => {
  const { forge, host } = parseAccount(account);

  return forge === 'gitlab' ? `glab auth login --hostname ${host}` : 'gh auth login';
};

/** How often each discovery feed runs on the background schedule. Manual syncs run them all. */
const FEED_INTERVAL_MS: Record<FeedSource, number> = {
  requested: 60_000,
  authored: 120_000,
  assigned: 300_000,
  reviewed: 300_000,
  mentioned: 300_000,
};

/** What the sync calls out to: `SyncService`, so a hook keeps the receiver it always had. */
export interface SyncHooks {
  /** Runs after every sync with the active login (used for notifications). */
  afterSync: ((login: string) => Promise<unknown>) | null;
}

const SYNC_INTERVAL_MS = 60_000;
/** Snapshots a GitLab sync reads before checking glab's sign-in and saving them. */
const GITLAB_SAVE_BATCH = 20;
const TEAMS_REFRESH_MS = 30 * 60_000;
const QUEUE_SAMPLE_MS = 60 * 60_000;

/**
 * The background sync and account switches, which share one slot: a sync joins the work in
 * progress, a switch waits for it, and `stop` drains it.
 */
export class SyncRunner {
  private running: Promise<void> | null = null;
  private stopSchedule: Cancel | null = null;
  private stopped = false;
  private readonly feedRuns = new Map<string, number>();
  private readonly teamsFetched = new Map<string, number>();

  constructor(
    /** Holds the `afterSync` hook, which runs as its method, as it always has. */
    private readonly hooks: SyncHooks,
    private readonly store: Store,
    private readonly github: GitHubApi,
    private readonly events: EventBus,
    private readonly accounts: GitHubAccounts | null,
    private readonly clock: Clock,
    private readonly state: AccountState,
    private readonly reads: PullReads,
    /** Every write of a cached PR goes through here, so reads are saved in order. */
    private readonly snapshots: SnapshotCoordinator,
  ) {}

  start(): void {
    if (this.stopped) return;

    void this.sync({ trigger: 'start' });
    // A second start replaces the schedule instead of leaving the first one running.
    this.stopSchedule?.();
    this.stopSchedule = this.clock.every(SYNC_INTERVAL_MS, () => {
      void this.sync({ scheduled: true });
    });
  }

  /** Stops the schedule and waits for a sync in progress; no sync starts after this. */
  async stop(): Promise<void> {
    this.stopped = true;

    this.stopSchedule?.();
    this.stopSchedule = null;

    await this.running?.catch(() => undefined);
  }

  /**
   * Runs one sync. Scheduled runs respect per-feed cadences; explicit runs (startup, "Sync now",
   * tests) run every feed. Concurrent calls share the run in progress.
   */
  sync(
    options: { scheduled?: boolean; trigger?: 'start' | 'switch' | 'manual' } = {},
  ): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped || this.state.cooldown()) return Promise.resolve();

    const trigger = options.scheduled ? 'interval' : (options.trigger ?? 'manual');
    // Always as the selected account, whatever account the caller's work is scoped to.
    const run = unscoped(() => this.perform(Boolean(options.scheduled), trigger)).finally(() => {
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

      this.state.applySwitch(from, target.login);
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
    void this.sync({ trigger: 'switch' });

    return this.state.sentStatus;
  }

  private async perform(
    scheduled: boolean,
    trigger: 'interval' | 'start' | 'switch' | 'manual',
  ): Promise<void> {
    this.state.beginSync();

    let retryAt: string | null = null;
    /** Deadlines from phases whose reads were confirmed as this account's (GitHub: all of them). */
    let confirmedRetryAt: string | null = null;
    const confirm = () => {
      confirmedRetryAt = laterDeadline(this.clock.now(), confirmedRetryAt, retryAt);
    };
    const changed = new Set<string>();
    // Wall time per phase, and the fetches' own durations (they overlap: concurrent work, not a
    // share of the phase).
    const timing = {
      started: performance.now(),
      discovered: 0,
      detected: 0,
      fetched: 0,
      candidates: 0,
      fetches: 0,
      failed: 0,
      fetchSumMs: 0,
      fetchMaxMs: 0,
      concurrency: 0,
      forge: 'github' as 'github' | 'gitlab',
      outcome: 'ok',
    };

    try {
      const account = await this.github.identity();
      const chosen = this.store.settings.get(SELECTED_ACCOUNT);

      timing.forge = forgeOf(account.login) === 'gitlab' ? 'gitlab' : 'github';

      // glab signed in to the chosen GitLab account's host as someone else: read nothing as them.
      if (chosen && forgeOf(chosen) === 'gitlab' && !sameAccount(account.login, chosen))
        throw new AccountUnavailable(chosen, account.login);

      /**
       * For GitLab, whose CLI reads its own sign-in for each request, a phase writes only between two
       * checks that glab is still signed in as this account: the one before its reads (the check
       * above, then each previous phase's) and this one, after them. A sign-in change during a phase
       * stops the sync before that phase writes anything. (A change and a change back inside one
       * phase are not seen: Review Desk never reads the GitLab token.) GitHub calls each carry the
       * account's own token, so they need no check.
       */
      const verify =
        timing.forge === 'gitlab' && this.github.verifyAccount
          ? () =>
              this.github.verifyAccount!(account.login)
                // A limit met by the check could be someone else's: never this account's status.
                .catch((error: unknown) => Promise.reject(unattributed(error)))
          : null;

      if (account.login !== this.state.status.account?.login) {
        const waiting = this.state.adoptIdentity(account);

        if (waiting) {
          retryAt = waiting;
          confirm();
          timing.outcome = 'rate_limit';
          this.state.setError(
            this.state.worded(
              'GitHub rate limit reached. Refresh will resume automatically after the cooldown.',
            ),
          );

          return;
        }
      } else {
        this.state.setProfile(account);
      }

      const target = this.state.readTarget();

      // Kept from the last sync when it cannot be read now.
      target.setCapabilities(
        (await this.github.capabilities?.().catch(() => this.state.status.capabilities)) ??
          this.state.status.capabilities,
      );

      await this.refreshTeams(account.login, scheduled);

      retryAt = await this.discover(account.login, scheduled, verify);
      // Discovery checked its reads before writing them: its deadline is the account's.
      confirm();
      timing.discovered = performance.now();

      const membership = this.store.membership(account.login);
      const previous = new Map(this.store.openSnapshots(account.login).map((pr) => [pr.id, pr]));
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

      // Before detection writes anything: closures, merges and source changes included.
      await verify?.();
      timing.detected = performance.now();
      timing.candidates = ids.length;
      // The later deadline stands: detection's can be shorter than discovery's.
      if (detected.retryAt) retryAt = laterDeadline(this.clock.now(), retryAt, detected.retryAt);
      // Detection was checked above, before this deadline was taken from it.
      confirm();

      const fetches: {
        id: string;
        sources: Source[];
        cached?: PullRequestSnapshot;
        result: DetectResult | null;
      }[] = [];
      const now = this.clock.now();

      for (const id of ids) {
        const cached = previous.get(id);
        const result = detected.results?.get(id) ?? null;
        const sources = ordered(membership.get(id) ?? cached?.sources ?? []);

        if (result && result.state === null) {
          this.state.warn(
            `${cached ? fullRef(cached) : id} is unavailable; its cached record was retained.`,
          );
          continue;
        }

        if (result && result.state !== 'OPEN') {
          // Closure or merge is confirmed by GitHub, so the PR can leave the list. Recorded also
          // when nothing is stored yet or the row is newer than this sync's list of open PRs (a
          // first add that finished meanwhile), so neither keeps it open.
          const outcome = this.snapshots.commitState(observations.get(id)!, result.state!);

          if (outcome.status === 'committed') changed.add(id);

          continue;
        }

        const sync = this.store.syncState(account.login, id);
        const reconcileDue =
          !detected.lowBudget && (!sync?.nextFullAt || Date.parse(sync.nextFullAt) <= now);
        const needsSnapshot =
          !cached ||
          !result ||
          isLegacySnapshot(cached) ||
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

      /** Reads one PR; the returned save is run at once or, for GitLab, with its batch. */
      const read = async ({ id, sources, cached, result }: (typeof fetches)[number]) => {
        try {
          const observation = this.snapshots.observe(account.login, id);
          const latest = this.store.snapshot(account.login, id) ?? undefined;

          // Removed from the queue since this sync read it: do not bring it back.
          if (cached && !latest) return null;

          const fetchStarted = performance.now();

          timing.fetches += 1;

          const snapshot = await this.github
            .snapshot(id, account.login, sources, latest)
            .finally(() => {
              const ms = performance.now() - fetchStarted;

              timing.fetchSumMs += ms;
              timing.fetchMaxMs = Math.max(timing.fetchMaxMs, ms);
            });

          return () => {
            try {
              // The observation was taken when the read began, so a read that started later
              // (such as a refresh) and was saved first still wins, however long this one waited.
              const outcome = this.snapshots.commit(observation, snapshot, {
                fingerprint: result?.fingerprint ?? null,
                // Removed from the queue while it was being fetched: do not bring it back.
                requireStored: Boolean(cached),
                // Added or removed by hand during the fetch: keep that change.
                sources: () => this.withManual(account.login, id, snapshot.sources),
              });

              // A later read was saved first, or the PR was removed: this read is older.
              if (outcome.status !== 'committed') return;

              changed.add(id);
            } catch (error) {
              // As a failed read: counted, and the other reads go on.
              timing.failed += 1;
              this.state.warn(`${cached ? fullRef(cached) : id}: ${safeError(error)}`);
            }
          };
        } catch (error) {
          timing.failed += 1;
          this.state.warn(`${cached ? fullRef(cached) : id}: ${safeError(error)}`);

          if (error instanceof GitHubError && error.retryAt) retryAt = error.retryAt;

          return null;
        }
      };
      /** Reads `batch` three at a time, saving each read at once unless `deferred` collects it. */
      const readAll = async (batch: typeof fetches, deferred?: (() => void)[]) => {
        let cursor = 0;
        const worker = async () => {
          while (cursor < batch.length && !retryAt) {
            const save = await read(batch[cursor++]);

            if (!save) continue;
            if (deferred) deferred.push(save);
            else save();
          }
        };

        // Every worker settles before the batch counts as done, so none still saves after it.
        await Promise.allSettled(Array.from({ length: Math.min(3, batch.length) }, () => worker()));
      };

      timing.concurrency = Math.min(3, fetches.length);

      if (!verify) {
        await readAll(fetches);
        confirm();
      } else
        for (let start = 0; start < fetches.length && !retryAt; start += GITLAB_SAVE_BATCH) {
          const saves: (() => void)[] = [];

          await readAll(fetches.slice(start, start + GITLAB_SAVE_BATCH), saves);
          await verify();
          confirm();

          for (const save of saves) save();
        }

      timing.fetched = performance.now();

      this.sampleQueue(account.login);

      if (this.hooks.afterSync) {
        // Hooks (notifications) must never break a sync.
        await this.hooks.afterSync(account.login).catch(() => undefined);
      }

      this.state.succeeded();

      if (retryAt)
        this.state.setError(
          this.state.worded(
            'GitHub rate limit reached. Refresh will resume automatically after the cooldown.',
          ),
        );
    } catch (error) {
      this.state.setError(safeError(error));
      // A failed phase's own deadline goes with it; those of phases checked before it stand.
      retryAt = laterDeadline(
        this.clock.now(),
        confirmedRetryAt,
        error instanceof GitHubError ? error.retryAt : null,
      );
      timing.outcome =
        error instanceof GitHubError
          ? error.outcome
          : error instanceof AccountUnavailable
            ? error.code
            : 'error';
    } finally {
      const now = isoNow(this.clock);
      const ended = performance.now();
      const phase = (from: number, to: number) => (from && to ? to - from : undefined);

      log.event('info', 'sync.completed', {
        forge: timing.forge,
        trigger,
        // A sync that went on past a failed feed, team read or fetch did only part of its work.
        outcome:
          timing.outcome !== 'ok'
            ? timing.outcome
            : retryAt
              ? 'rate_limit'
              : this.state.status.warnings.length > 0
                ? 'partial'
                : 'ok',
        discoveryMs: phase(timing.started, timing.discovered),
        detectionMs: phase(timing.discovered, timing.detected),
        fetchMs: phase(timing.detected, timing.fetched),
        totalMs: ended - timing.started,
        candidates: timing.candidates,
        fetched: timing.fetches,
        changed: changed.size,
        failed: timing.failed,
        concurrency: timing.concurrency,
        fetchSumMs: timing.fetchSumMs,
        fetchMaxMs: timing.fetchMaxMs,
      });

      const login = this.state.finishSync({
        retryAt,
        completedAt: now,
        intervalMs: SYNC_INTERVAL_MS,
      });

      if (login && changed.size > 0)
        this.events.emit({ type: 'pulls.changed', account: login, ids: [...changed] });
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
    // Never fetched is due now, whatever the clock reads.
    const fetchedAt = this.teamsFetched.get(login) ?? -Infinity;

    if (scheduled && this.clock.now() - fetchedAt < TEAMS_REFRESH_MS) return;

    try {
      const target = this.state.readTarget();

      target.setTeams(await this.github.teams());
      this.teamsFetched.set(login, this.clock.now());
    } catch (error) {
      if (error instanceof GitHubError && error.retryAt) throw error;

      this.state.warn(
        `Team membership could not be refreshed. Team request details may be incomplete. ${safeError(error)}`,
      );
    }
  }

  /**
   * Runs due discovery feeds. A successful feed replaces its membership; a failed feed leaves its
   * previous membership untouched, so a transient search failure never drops a PR's source.
   */
  private async discover(
    login: string,
    scheduled: boolean,
    verify: (() => Promise<void>) | null = null,
  ): Promise<string | null> {
    const now = this.clock.now();
    const due = FEED_SOURCES.filter(
      (source) =>
        !scheduled ||
        now - (this.feedRuns.get(`${login}:${source}`) ?? -Infinity) >= FEED_INTERVAL_MS[source],
    );
    const feeds = await Promise.allSettled(
      due.map((source) => this.github.discover(login, source)),
    );
    let retryAt: string | null = null;

    await verify?.();

    feeds.forEach((feed, index) => {
      const source = due[index];

      if (feed.status === 'fulfilled') {
        this.store.replaceFeed(login, source, feed.value, isoNow(this.clock));
        this.feedRuns.set(`${login}:${source}`, now);
        return;
      }

      this.state.warn(`${source} search incomplete: ${safeError(feed.reason)}`);

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
        this.state.warn(`Change detection paused: ${safeError(error)}`);

        return { results: new Map(), lowBudget: true, retryAt: error.retryAt };
      }

      this.state.warn(`Change detection unavailable; refetching every PR. ${safeError(error)}`);

      return { results: null, lowBudget: false, retryAt: null };
    }
  }

  /** Hourly queue-size samples feed the insights page. */
  private sampleQueue(login: string): void {
    const last = this.store.lastQueueSampleAt(login);

    if (last && this.clock.now() - Date.parse(last) < QUEUE_SAMPLE_MS) return;

    const items = this.reads.listFor(login).items;
    const attention = items.filter((item) => item.queue === 'attention');

    this.store.saveQueueSample(login, {
      at: isoNow(this.clock),
      attention: attention.length,
      waiting: items.filter((item) => item.queue === 'waiting').length,
      authoredBlocked: this.reads.mineFor(login).items.filter((item) => item.group === 'needs_you')
        .length,
      oldestAttentionAt: attention.map((item) => item.attentionAt).sort()[0] ?? null,
    });
  }
}
