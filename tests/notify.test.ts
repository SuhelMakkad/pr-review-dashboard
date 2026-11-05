import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/db/store';
import { FixtureGitHub } from '../server/demo/fixture-github';
import { defaultScenario } from '../server/demo/scenario';
import { EventBus } from '../server/events';
import { Notifier } from '../server/notify/notifier';
import { SyncService } from '../server/sync';
import { defaultNotificationSettings, inQuietHours } from '../shared/notify';
import type { ServerEvent } from '../shared/events';

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function setup(options: { browser?: boolean } = {}) {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events);
  const native = vi.fn(async () => undefined);
  const notifier = new Notifier(store, events, native);
  const received: ServerEvent[] = [];

  stores.push(store);

  if (options.browser !== false) events.subscribe((stored) => received.push(stored.event));

  sync.afterSync = (login) =>
    notifier.afterSync(login, sync.list().items, sync.mine().items, new Date(2026, 10, 5, 12, 0));

  const notified = () =>
    received.flatMap((event) => (event.type === 'notify' ? event.notifications : []));

  return { store, github, sync, notifier, native, notified };
}

describe('notifications', () => {
  it('stays quiet about the existing backlog, then announces each new fact once', async () => {
    const { github, sync, notified } = await setup();

    await sync.sync();
    expect(notified()).toEqual([]);

    github.advance();
    await sync.sync();
    await sync.sync();

    expect(notified()).toEqual([
      expect.objectContaining({
        kind: 'reply',
        body: 'New reply in a thread you joined',
        path: '/inbox/attention/acme/api/2041',
      }),
    ]);
  });

  it('never replays muted kinds and respects quiet hours', async () => {
    const { github, sync, notifier, notified } = await setup();

    await sync.sync();
    notifier.saveSettings({
      ...defaultNotificationSettings(),
      kinds: { ...defaultNotificationSettings().kinds, reply: false },
    });
    github.advance();
    await sync.sync();

    notifier.saveSettings(defaultNotificationSettings());
    await sync.sync();

    expect(notified()).toEqual([]);
    expect(inQuietHours({ start: '22:00', end: '08:00' }, new Date(2026, 10, 5, 23, 30))).toBe(
      true,
    );
    expect(inQuietHours({ start: '22:00', end: '08:00' }, new Date(2026, 10, 5, 7, 59))).toBe(true);
    expect(inQuietHours({ start: '22:00', end: '08:00' }, new Date(2026, 10, 5, 12, 0))).toBe(
      false,
    );
    expect(inQuietHours({ start: '12:00', end: '13:00' }, new Date(2026, 10, 5, 12, 30))).toBe(
      true,
    );
  });

  it('falls back to native notifications only when enabled and no window is open', async () => {
    const quiet = await setup({ browser: false });

    await quiet.sync.sync();
    quiet.github.advance();
    await quiet.sync.sync();
    expect(quiet.native).not.toHaveBeenCalled();

    const native = await setup({ browser: false });

    native.notifier.saveSettings({ ...defaultNotificationSettings(), macosWhenClosed: true });
    await native.sync.sync();
    native.github.advance();
    await native.sync.sync();

    expect(native.native).toHaveBeenCalledWith(
      'api#2041 · Product metadata schema with versioned migrations',
      'New reply in a thread you joined',
    );
  });

  it('tells you when your own PR is approved', async () => {
    const { github, sync, notified } = await setup();

    await sync.sync();

    const pull = github.scenario.world.pulls.find(
      (candidate) => candidate.snapshot.number === 882,
    )!;

    pull.snapshot.reviewRequests = [];
    pull.snapshot.verdicts = [
      {
        login: 'jonas',
        state: 'APPROVED',
        submittedAt: '2026-11-05T09:59:00.000Z',
        commitOid: pull.snapshot.headOid,
      },
    ];
    pull.snapshot.mergeStateStatus = 'CLEAN';
    pull.snapshot.reviewDecision = 'APPROVED';
    pull.snapshot.updatedAt = '2026-11-05T09:59:00.000Z';
    await sync.sync();

    expect(notified()).toEqual([
      expect.objectContaining({
        kind: 'approved',
        body: 'Approved by jonas — ready to merge',
        path: '/mine/acme/web/882',
      }),
    ]);
  });
});
