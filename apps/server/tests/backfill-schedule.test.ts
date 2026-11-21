import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestClock } from '@/clock.js';
import { BACKFILL } from '@/db/settings.js';
import { Store } from '@/db/store.js';
import { DEMO_SECOND_ACCOUNT, FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { GitHubError } from '@/github/errors.js';
import { SyncService } from '@/sync/index.js';
import { historyImporter } from './history-importer.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

/** The app's test clock follows real time: a delay it computed is off by a few ms. */
const about = (ms: number) => expect.closeTo(ms, -3);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const app = new TestClock(Date.parse('2026-11-05T10:00:00Z'));
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, fixture, events, fixture, app);

  cleanups.push(() => store.close());
  cleanups.push(() => sync.stop());
  await sync.sync();

  const importer = historyImporter(sync);

  cleanups.push(importer.close);

  /** The windows read, in order, as `from..to`: one entry for each window's first search. */
  const searched: string[] = [];
  const search = fixture.searchPullIds.bind(fixture);

  vi.spyOn(fixture, 'searchPullIds').mockImplementation(async (query) => {
    if (query.kind === 'reviewed') searched.push(`${query.from}..${query.to}`);

    return search(query);
  });

  const saved = () => store.settings.get(BACKFILL.of('you'));
  const stamp = (offsetMs = 0) => new Date(app.now() + offsetMs).toISOString();
  /** Its claim released: the run in progress has ended. */
  const ended = async () => {
    await vi.waitFor(() => expect(importer.row('you')?.claimedBy ?? null).toBe(null));
    await flush();
  };

  return { app, store, fixture, events, sync, searched, saved, stamp, ended, ...importer };
}

/** Holds the next search until `release`; `reached` is called once it is asked. */
function hold(fixture: FixtureGitHub) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const reached = vi.fn();
  const search = vi.mocked(fixture.searchPullIds).getMockImplementation()!;

  vi.mocked(fixture.searchPullIds).mockImplementationOnce(async (query) => {
    reached();
    await held;

    return search(query);
  });

  return { release, reached };
}

describe('history imports on the scheduler', () => {
  it('joins routine requests to an import in progress, and runs a refresh after it', async () => {
    const { fixture, backfill, clock, row, ran, searched, saved, ended } = await setup();
    const { release, reached } = hold(fixture);

    backfill.request('you');
    clock.fire();
    await vi.waitFor(() => expect(reached).toHaveBeenCalled());

    // A sync's ask while it imports: covered by the import in progress.
    backfill.request('you');
    backfill.request('you');

    expect(row('you')).toMatchObject({ rearmAt: null });

    backfill.refresh('you');

    expect(row('you')!.rearmAt).not.toBeNull();

    release();
    await ended();

    // The refresh runs next, once, and reads every window.
    expect(clock.wakes()).toEqual([100]);

    const before = searched.length;

    await ran('you');

    expect(searched.length - before).toBe(3);
    expect(saved()?.force).toBeNull();
    expect(clock.wakes()).toEqual([]);
  });

  it('keeps a newer refresh asked for while an older one reads', async () => {
    const { fixture, backfill, clock, ran, saved, ended } = await setup();

    backfill.refresh('you');

    const older = saved()!.force!.id;
    const { release, reached } = hold(fixture);

    clock.fire();
    await vi.waitFor(() => expect(reached).toHaveBeenCalled());
    backfill.refresh('you');

    const newer = saved()!.force!.id;

    expect(newer).not.toBe(older);

    release();
    await ended();

    // The older one's windows never count for the newer, which is still to run.
    expect(saved()!.force).toMatchObject({ id: newer, windows: [] });

    await ran('you');

    expect(saved()!.force).toBeNull();
  });

  it('resumes a refresh stopped by a rate limit after its cooldown, at the window it stopped at', async () => {
    const { app, fixture, sync, row, ran, imported, searched, saved, stamp } = await setup();
    const search = vi.mocked(fixture.searchPullIds).getMockImplementation()!;
    let calls = 0;

    vi.mocked(fixture.searchPullIds).mockImplementation(async (query) => {
      // The second window's first search meets the limit.
      if (++calls === 3) throw new GitHubError('Rate limited.', stamp(60_000), 403, 'rate_limit');

      return search(query);
    });

    await imported('you', { force: true });

    const [done] = saved()!.force!.windows;

    expect(saved()!.force!.windows).toEqual([done]);
    expect(row('you')).toMatchObject({ notBefore: sync.cooldown('you'), attempts: 0 });

    // Days later: its windows are still those it was asked for, never ones from now.
    app.advance(2 * 86_400_000);

    const before = searched.length;

    await ran('you');

    // The windows it had not read, never the one it had.
    expect(searched.slice(before)).toHaveLength(2);
    expect(searched.slice(before)).not.toContain(done);
    expect(saved()!.force).toBeNull();
  });

  it('parks an import for an account not in use, and asks again for its refresh once in use', async () => {
    const { sync, backfill, row, ran, saved, searched } = await setup();

    backfill.refresh('you');
    await sync.switchAccount('you', DEMO_SECOND_ACCOUNT);

    // Asked for, but for an account not in use: not running.
    expect(backfill.state('you').running).toBe(false);

    await ran('you');

    expect(searched).toEqual([]);
    expect(row('you')).toBeUndefined();
    expect(saved()!.force).not.toBeNull();

    await sync.switchAccount(DEMO_SECOND_ACCOUNT, 'you');

    expect(row('you')).toBeDefined();

    await ran('you');

    expect(searched).toHaveLength(3);
    expect(saved()!.force).toBeNull();
  });

  it('asks again at startup for a refresh still to finish, once its cooldown ends', async () => {
    const { store, sync, stamp } = await setup();

    store.settings.set(BACKFILL.of('you'), {
      doneWindows: [],
      finishedAt: null,
      lastError: null,
      force: { id: 'refresh-1', at: stamp(), windows: [] },
    });
    sync.deferUntil(stamp(120_000), 'you');

    const next = historyImporter(sync, 'boot-2');

    cleanups.push(next.close);

    expect(next.row('you')).toMatchObject({ notBefore: sync.cooldown('you') });
    expect(next.clock.wakes()).toEqual([about(120_000)]);
  });

  it('shows an import asked for during a cooldown as not running', async () => {
    const { sync, backfill, stamp } = await setup();

    backfill.request('you');

    expect(backfill.state('you').running).toBe(true);

    sync.deferUntil(stamp(60_000), 'you');

    expect(backfill.state('you').running).toBe(false);
  });

  it('tells the page an import stopped only once its end is saved, a retried save included', async () => {
    const { events, store, backfill, clock, row, imported } = await setup();
    const running: boolean[] = [];

    events.subscribe(({ event }) => {
      if (event.type === 'insights.updated' && event.account === 'you')
        running.push(backfill.state('you').running);
    });

    await imported('you');

    expect(running[0]).toBe(true);
    expect(running.at(-1)).toBe(false);

    running.length = 0;

    const remove = store.scheduledWork.delete.bind(store.scheduledWork);
    let failures = 1;

    vi.spyOn(store.scheduledWork, 'delete').mockImplementation((target) => {
      if (failures-- > 0) throw new Error('disk I/O error');

      remove(target);
    });
    backfill.request('you');
    clock.fire();
    await vi.waitFor(() => expect(clock.wakes()).toEqual([1000]));

    // Its end not saved yet: still shown running.
    expect(running.at(-1)).toBe(true);

    clock.fire();
    await flush();

    expect(row('you')).toBeUndefined();
    expect(running.at(-1)).toBe(false);
  });
});
