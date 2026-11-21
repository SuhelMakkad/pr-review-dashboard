import { randomUUID } from 'node:crypto';
import type { EventBus } from '@/events.js';
import { isoNow, type Clock } from '@/clock.js';
import { AccountUnavailable, unattributed } from '@/forge/account.js';
import { accountCheck, bindForge } from '@/forge/bind.js';
import { GitHubError, safeError } from '@/github/errors.js';
import type { SyncService } from '@/sync/service.js';
import { extractActivity } from '@/insights/extract.js';
import { BACKFILL, type ForcedBackfill, type SavedBackfill } from '@/db/settings.js';
import { deadlineOf } from '@/db/scheduled-work.js';
import type { GitHubApi } from '@/github/api.js';
import { Aborted, Defer, type Scheduler } from '@/scheduler/scheduler.js';

const DAY = 24 * 60 * 60_000;
const WINDOW_DAYS = 30;
const SPAN_DAYS = 90;

/** The kind of `scheduled_work` row that imports an account's history. */
export const BACKFILL_WORK = 'insights.backfill';

export interface BackfillState {
  doneWindows: string[];
  finishedAt: string | null;
  lastError: string | null;
  running: boolean;
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

const EMPTY: SavedBackfill = { doneWindows: [], finishedAt: null, lastError: null, force: null };

/**
 * Fills review history for the last 90 days from the forge, a month at a time (each search stays
 * under GitHub's 1,000-result cap). Progress is saved after each window, so it resumes. Each
 * account has its own import, run by the scheduler (`BACKFILL_WORK`, one per account at a time):
 * one starts only for the account in use, and goes on as that account after a switch.
 */
export class Backfill {
  /** Stops listening for the account in use changing; set once open. */
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly sync: SyncService,
    private readonly events: EventBus,
    private readonly scheduler: Scheduler,
  ) {
    scheduler.register(BACKFILL_WORK, {
      class: 'history',
      run: (work, signal) => this.run(work.key, signal),
      // Once its end is saved: shown as no longer running, unless it runs again at once.
      settled: (work) => this.changed(work.key),
    });
  }

  /** The app's clock, shared with the sync. */
  private get clock(): Clock {
    return this.sync.clock;
  }

  state(login: string): BackfillState {
    const saved = this.saved(login);

    return {
      doneWindows: saved.doneWindows,
      finishedAt: saved.finishedAt,
      lastError: saved.lastError,
      running: this.running(login),
    };
  }

  /**
   * After a sync: imports what is new, joining an import in progress. Returns immediately, and
   * never throws: one that cannot be asked for now is asked for by the next sync.
   */
  request(login: string): void {
    try {
      this.sync.store.transaction(() => {
        this.scheduler.request(BACKFILL_WORK, login, {
          account: login,
          at: isoNow(this.clock),
          join: true,
        });
        this.sync.store.afterCommit(() => this.changed(login));
      });
    } catch {
      // Never breaks a sync's follow-up work, nor hides what else it started.
    }
  }

  /**
   * Re-reads every window, once any import in progress ends. The ask is kept with the account's
   * progress, so a refresh stopped by a restart or a cooldown resumes where it was.
   */
  refresh(login: string): void {
    const at = isoNow(this.clock);

    this.sync.store.transaction(() => {
      this.write(login, (live) => ({ ...live, force: { id: randomUUID(), at, windows: [] } }));
      this.scheduler.request(BACKFILL_WORK, login, { account: login, at });
      // Told only once it is saved: a refresh rolled back was never asked for.
      this.sync.store.afterCommit(() => this.changed(login));
    });
  }

  /**
   * Asks again for a refresh still to finish, for the account in use now and whenever another
   * comes into use, its cooldown as the gate. Called once the scheduler is open.
   */
  open(): void {
    if (this.unsubscribe) return;

    let active = this.sync.status.account?.login ?? null;

    this.resume(active);
    this.unsubscribe = this.sync.events.subscribe(({ event }) => {
      if (event.type !== 'status') return;

      const now = event.status.account?.login ?? null;

      if (now === active) return;

      active = now;
      this.resume(now);
    });
  }

  /** Stops asking again on a switch; what runs stops with the scheduler. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private resume(login: string | null): void {
    if (!login || !this.saved(login).force) return;

    try {
      this.sync.store.transaction(() => {
        this.scheduler.request(BACKFILL_WORK, login, {
          account: login,
          at: isoNow(this.clock),
          notBefore: this.sync.cooldown(login),
          join: true,
        });
        this.sync.store.afterCommit(() => this.changed(login));
      });
    } catch {
      // Never breaks a status change; the next sync asks again.
    }
  }

  /** Running, or asked for and able to start now. */
  private running(login: string): boolean {
    if (this.scheduler.running(BACKFILL_WORK, login)) return true;

    const row = this.sync.store.scheduledWork.get(BACKFILL_WORK, login);
    const deadline = row && row.claimedBy === null ? deadlineOf(row) : null;

    return (
      deadline !== null &&
      this.scheduler.accepting &&
      Date.parse(deadline) <= this.clock.now() &&
      login === this.sync.status.account?.login &&
      this.sync.cooldown(login) === null
    );
  }

  private changed(login: string): void {
    this.events.emit({ type: 'insights.updated', account: login });
  }

  private saved(login: string): SavedBackfill {
    return { ...EMPTY, ...this.sync.store.settings.get(BACKFILL.of(login)) };
  }

  /** Saves the account's progress from what is saved now, so nothing written meanwhile is lost. */
  private write(login: string, next: (live: SavedBackfill) => SavedBackfill): void {
    this.sync.store.transaction(() =>
      this.sync.store.settings.set(BACKFILL.of(login), next(this.saved(login))),
    );
  }

  /**
   * The import (`BACKFILL_WORK`): of the account in use when it starts, as that account
   * throughout. A refresh still to finish is read once, at the start: it re-reads its windows,
   * from when it was asked for, skipping those it already read.
   */
  private async run(login: string, signal: AbortSignal): Promise<{ next: string | null }> {
    // Parked until its account is in use again, which asks again for a refresh still to finish.
    if (login !== this.sync.status.account?.login) return { next: null };

    this.changed(login);

    const saved = this.saved(login);
    const force: ForcedBackfill | null = saved.force ?? null;
    // Windows end at the refresh's own time, the same on every resume; else at now.
    const now = force ? Date.parse(force.at) : this.clock.now();
    const teams = this.sync.teamsOf(login);
    const known = new Set(this.sync.store.activityPullIds(login));
    const ours = (live: SavedBackfill) => force !== null && live.force?.id === force.id;
    // Every read is this account's, whatever is selected meanwhile.
    const github = bindForge(this.sync.github, login);
    // Where the forge cannot carry the account with each call (GitLab), its sign-in is checked
    // before a window's reads and again before they are saved. A limit met by a check itself
    // cannot be tied to the account.
    const verify = accountCheck(github);
    const check = async () => {
      if (verify)
        await verify(login).catch((error: unknown) => Promise.reject(unattributed(error)));
    };

    try {
      for (let end = now; end > now - SPAN_DAYS * DAY; end -= WINDOW_DAYS * DAY) {
        const start = Math.max(now - SPAN_DAYS * DAY, end - WINDOW_DAYS * DAY);
        const window = `${day(start)}..${day(end)}`;
        // Still filling up: never a done window, re-read by every import that is not a refresh.
        const newest = end === now;

        // Shutting down: what is saved so far resumes on the next start.
        if (signal.aborted) throw new Aborted();

        if (force ? force.windows.includes(window) : saved.doneWindows.includes(window) && !newest)
          continue;

        // A cooldown already saved is refused here, asking the forge nothing, not even who it is.
        try {
          this.sync.assertNotCoolingDown(login);
        } catch (error) {
          this.write(login, (live) => ({ ...live, lastError: safeError(error) }));

          const until = this.sync.cooldown(login);

          if (until) throw new Defer(until);

          return { next: null };
        }

        await check();

        const snapshots = await this.read(github, login, window, force !== null, known);

        await check();

        // The window's activity and its checkpoint together, or neither.
        this.sync.store.transaction(() => {
          for (const snapshot of snapshots)
            this.sync.store.recordActivity(login, extractActivity(snapshot, login, teams));

          this.write(login, (live) => ({
            ...live,
            doneWindows:
              newest || live.doneWindows.includes(window)
                ? live.doneWindows
                : [...live.doneWindows, window],
            lastError: null,
            // A newer refresh asked for meanwhile keeps its own progress.
            force: ours(live)
              ? { ...live.force!, windows: [...live.force!.windows, window] }
              : (live.force ?? null),
          }));
        });

        for (const snapshot of snapshots) known.add(snapshot.id);
        this.changed(login);
      }

      this.write(login, (live) => ({
        ...live,
        finishedAt: isoNow(this.clock),
        lastError: null,
        // Done with this refresh, unless a newer one was asked for meanwhile.
        force: ours(live) ? null : (live.force ?? null),
      }));

      return { next: null };
    } catch (error) {
      if (error instanceof Aborted || error instanceof Defer) throw error;

      const confirmed = await this.keepLimit(login, error, verify);

      this.write(login, (live) => ({
        ...live,
        lastError: error instanceof AccountUnavailable ? error.message : safeError(error),
      }));

      // A limit that is the account's: resumed once its cooldown ends. Any other failure is
      // tried again by the next sync.
      const until = confirmed ? this.sync.cooldown(login) : null;

      if (until) throw new Defer(until);

      return { next: null };
    }
  }

  private async read(
    /** The import's own binding to `login`, kept for every window. */
    github: GitHubApi,
    login: string,
    window: string,
    force: boolean,
    known: Set<string>,
  ) {
    // A window is `from..to`, both inclusive days.
    const [from, to] = window.split('..');
    const ids = [
      ...new Set([
        ...(await github.searchPullIds({ kind: 'reviewed', login, from, to })),
        ...(await github.searchPullIds({ kind: 'authored', login, from, to })),
      ]),
    ].filter((id) => force || !known.has(id));

    return github.history(ids, login);
  }

  /**
   * Saves a rate limit the account met as its cooldown, so the next window or import waits. On
   * GitLab only once glab is confirmed to still be the account; a limit that cannot be tied to it
   * is nobody's. True when it was saved.
   */
  private async keepLimit(
    login: string,
    error: unknown,
    verify: ((account: string) => Promise<void>) | null,
  ): Promise<boolean> {
    if (!(error instanceof GitHubError) || error.outcome !== 'rate_limit' || !error.retryAt)
      return false;

    const confirmed = verify
      ? await verify(login).then(
          () => true,
          () => false,
        )
      : true;

    if (confirmed) this.sync.deferUntil(error.retryAt, login);

    return confirmed;
  }
}
