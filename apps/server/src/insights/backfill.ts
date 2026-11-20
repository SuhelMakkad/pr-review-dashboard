import { eq } from 'drizzle-orm';
import { activityEvents } from '@/db/schema.js';
import type { EventBus } from '@/events.js';
import { AccountUnavailable, unattributed } from '@/forge/account.js';
import { asAccount } from '@/github/credentials.js';
import { GitHubError, safeError } from '@/github/errors.js';
import type { SyncService } from '@/sync/service.js';
import { extractActivity } from '@/insights/extract.js';

const DAY = 24 * 60 * 60_000;
const WINDOW_DAYS = 30;
const SPAN_DAYS = 90;

export interface BackfillState {
  doneWindows: string[];
  finishedAt: string | null;
  lastError: string | null;
  running: boolean;
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Fills review history for the last 90 days from the forge, a month at a time (each search stays
 * under GitHub's 1,000-result cap). Progress is saved after each window, so it resumes. Each
 * account has its own import; one starts only for the account in use, and goes on as that
 * account after a switch.
 */
export class Backfill {
  private readonly running = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly sync: SyncService,
    private readonly events: EventBus,
  ) {}

  private key(login: string) {
    return `backfill:${login}`;
  }

  state(login: string): BackfillState {
    const saved = this.sync.store.getSetting<Omit<BackfillState, 'running'>>(this.key(login));

    return {
      doneWindows: saved?.doneWindows ?? [],
      finishedAt: saved?.finishedAt ?? null,
      lastError: saved?.lastError ?? null,
      running: this.running.has(login),
    };
  }

  /** Starts (or joins) the account's import; returns immediately. `force` re-reads every window. */
  start(login: string, options: { force?: boolean } = {}): Promise<void> {
    const current = this.running.get(login);

    if (current) return current;
    if (this.closed) return Promise.resolve();

    // History is read as this account even if you switch accounts while it runs.
    const run = asAccount(login, () => this.run(login, Boolean(options.force))).finally(() => {
      this.running.delete(login);
      this.events.emit({ type: 'insights.updated', account: login });
    });

    this.running.set(login, run);
    // Shown as running at once, before its first read returns.
    this.events.emit({ type: 'insights.updated', account: login });

    return run;
  }

  /**
   * Starts no further imports and lets those in progress stop after their current window. Saved
   * windows are kept, so the next start resumes where each stopped.
   */
  async close(): Promise<void> {
    this.closed = true;

    await Promise.all([...this.running.values()].map((run) => run.catch(() => undefined)));
  }

  private async run(login: string, force: boolean): Promise<void> {
    const state = this.state(login);
    // The account in use when it started, which is the import's account.
    const teams = this.sync.status.teams;
    // Windows saved as complete, kept whatever this import does; `force` only reads them again.
    const saved = new Set(state.doneWindows);
    const now = Date.now();
    const known = new Set(
      this.sync.store.db
        .selectDistinct({ prId: activityEvents.prId })
        .from(activityEvents)
        .where(eq(activityEvents.account, login))
        .all()
        .map((row) => row.prId),
    );
    const save = (patch: Partial<Omit<BackfillState, 'running'>>, windows = saved) =>
      this.sync.store.setSetting(this.key(login), {
        doneWindows: [...windows],
        finishedAt: state.finishedAt,
        lastError: null,
        ...patch,
      });
    const github = this.sync.github;
    // Where the forge cannot carry the account with each call (GitLab), its sign-in is checked
    // before a window's reads and again before they are saved. A limit met by a check itself
    // cannot be tied to the account.
    const verify = github.verifyAccount?.bind(github);
    const check = async () => {
      if (verify)
        await verify(login).catch((error: unknown) => Promise.reject(unattributed(error)));
    };

    try {
      for (let end = now; end > now - SPAN_DAYS * DAY; end -= WINDOW_DAYS * DAY) {
        const start = Math.max(now - SPAN_DAYS * DAY, end - WINDOW_DAYS * DAY);
        const window = `${day(start)}..${day(end)}`;

        // Shutting down: what is saved so far resumes on the next start.
        if (this.closed) return;

        // The newest window is always re-read: it is still filling up.
        if (!force && saved.has(window) && end !== now) continue;

        // A cooldown already saved is refused here, asking the forge nothing, not even who it is.
        try {
          this.sync.assertNotCoolingDown(login);
        } catch (error) {
          save({ lastError: safeError(error) });
          return;
        }

        await check();

        const snapshots = await this.read(login, window, force, known);

        await check();

        // The window's activity and its checkpoint together, or neither; this run counts the
        // window done, and its PRs known, only once both are committed.
        const windows = end !== now ? new Set([...saved, window]) : saved;

        this.sync.store.transaction(() => {
          for (const snapshot of snapshots)
            this.sync.store.recordActivity(login, extractActivity(snapshot, login, teams));

          save({}, windows);
        });

        if (end !== now) saved.add(window);
        for (const snapshot of snapshots) known.add(snapshot.id);
        this.events.emit({ type: 'insights.updated', account: login });
      }

      save({ finishedAt: new Date().toISOString() });
    } catch (error) {
      await this.keepLimit(login, error, verify);
      save({ lastError: error instanceof AccountUnavailable ? error.message : safeError(error) });
    }
  }

  private async read(login: string, window: string, force: boolean, known: Set<string>) {
    const github = this.sync.github;
    const ids = [
      ...new Set([
        ...(await github.searchPullIds(`is:pr reviewed-by:${login} updated:${window}`)),
        ...(await github.searchPullIds(`is:pr author:${login} created:${window}`)),
      ]),
    ].filter((id) => force || !known.has(id));

    return github.history(ids, login);
  }

  /**
   * Saves a rate limit the account met as its cooldown, so the next window or import waits. On
   * GitLab only once glab is confirmed to still be the account; a limit that cannot be tied to it
   * is nobody's.
   */
  private async keepLimit(
    login: string,
    error: unknown,
    verify: ((account: string) => Promise<void>) | undefined,
  ): Promise<void> {
    if (!(error instanceof GitHubError) || error.outcome !== 'rate_limit' || !error.retryAt) return;

    const confirmed = verify
      ? await verify(login).then(
          () => true,
          () => false,
        )
      : true;

    if (confirmed) this.sync.deferUntil(error.retryAt, login);
  }
}
