import { expect, vi } from 'vitest';
import { Backfill, BACKFILL_WORK } from '@/insights/backfill.js';
import { Scheduler } from '@/scheduler/scheduler.js';
import type { SyncService } from '@/sync/service.js';
import { RecordingClock } from '@test/fixtures/recording-clock.js';

/**
 * The history import, run by a scheduler whose timer fires only when a test fires it, on the
 * sync's wall time. `imported` asks for the account's import, as a sync (or a refresh) would, and
 * waits for that run to end.
 */
export function historyImporter(sync: SyncService, bootId = 'boot') {
  const clock = new RecordingClock(sync.clock);
  const scheduler = new Scheduler(sync.store, clock, bootId);
  const backfill = new Backfill(sync, sync.events, scheduler);

  scheduler.open();
  backfill.open();

  const row = (login: string) => sync.store.scheduledWork.get(BACKFILL_WORK, login);
  /** The account's run, fired, then ended: its claim settled. */
  const ran = async (login: string) => {
    clock.fire();
    await vi.waitFor(() => expect(row(login)?.claimedBy ?? null).toBe(null), { timeout: 5000 });
    // Its settlement re-arms and tells its handler in the same turn; let both happen.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const imported = async (login: string, options: { force?: boolean } = {}) => {
    if (options.force) backfill.refresh(login);
    else backfill.request(login);

    await ran(login);
  };
  const close = async () => {
    backfill.close();
    await scheduler.close();
  };

  return { clock, scheduler, backfill, row, ran, imported, close };
}
