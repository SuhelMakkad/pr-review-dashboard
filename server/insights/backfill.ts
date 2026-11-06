import { eq } from 'drizzle-orm';
import { activityEvents } from '../db/schema.js';
import type { EventBus } from '../events.js';
import { safeError } from '../github/errors.js';
import type { SyncService } from '../sync/service.js';
import { extractActivity } from './extract.js';

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
 * Fills review history for the last 90 days from GitHub, a month at a time (each search stays
 * under GitHub's 1,000-result cap). Progress is saved after each window, so it resumes.
 */
export class Backfill {
  private running: Promise<void> | null = null;

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
      running: Boolean(this.running),
    };
  }

  /** Starts (or joins) a run; returns immediately. `force` re-reads every window. */
  start(login: string, options: { force?: boolean } = {}): Promise<void> {
    if (this.running) return this.running;

    this.running = this.run(login, Boolean(options.force)).finally(() => {
      this.running = null;
      this.events.emit({ type: 'insights.updated' });
    });

    return this.running;
  }

  private async run(login: string, force: boolean): Promise<void> {
    const state = this.state(login);
    const done = new Set(force ? [] : state.doneWindows);
    const now = Date.now();
    const known = new Set(
      this.sync.store.db
        .selectDistinct({ prId: activityEvents.prId })
        .from(activityEvents)
        .where(eq(activityEvents.account, login))
        .all()
        .map((row) => row.prId),
    );
    const save = (patch: Partial<Omit<BackfillState, 'running'>>) =>
      this.sync.store.setSetting(this.key(login), {
        doneWindows: [...done],
        finishedAt: state.finishedAt,
        lastError: null,
        ...patch,
      });

    try {
      for (let end = now; end > now - SPAN_DAYS * DAY; end -= WINDOW_DAYS * DAY) {
        const start = Math.max(now - SPAN_DAYS * DAY, end - WINDOW_DAYS * DAY);
        const window = `${day(start)}..${day(end)}`;

        // The newest window is always re-read: it is still filling up.
        if (done.has(window) && end !== now) continue;

        const ids = [
          ...new Set([
            ...(await this.sync.github.searchPullIds(
              `is:pr reviewed-by:${login} updated:${window}`,
            )),
            ...(await this.sync.github.searchPullIds(`is:pr author:${login} created:${window}`)),
          ]),
        ].filter((id) => force || !known.has(id));

        for (const snapshot of await this.sync.github.history(ids, login)) {
          this.sync.store.recordActivity(
            login,
            extractActivity(snapshot, login, this.sync.status.teams),
          );
          known.add(snapshot.id);
        }

        if (end !== now) done.add(window);

        save({});
        this.events.emit({ type: 'insights.updated' });
      }

      save({ finishedAt: new Date().toISOString() });
    } catch (error) {
      save({ lastError: safeError(error) });
    }
  }
}
