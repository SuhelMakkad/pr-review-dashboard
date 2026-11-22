import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { Notifier } from '@/notify/notifier.js';
import { SyncService } from '@/sync/index.js';
import { defaultNotificationSettings, inQuietHours } from '@review-desk/shared/notify';
import type { ServerEvent } from '@review-desk/shared/events';

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function setup(options: { browser?: boolean } = {}) {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const events = new EventBus();
  const sync = new SyncService(store, github, events);
  const native = vi.fn(async (): Promise<'sent' | 'failed' | void> => undefined);
  const notifier = new Notifier(store, events, native);
  const received: ServerEvent[] = [];

  stores.push(store);

  if (options.browser !== false) events.subscribe((stored) => received.push(stored.event));

  sync.afterSync = async (login) => {
    await notifier.afterSync(
      login,
      sync.list().items,
      sync.mine().items,
      new Date(2026, 10, 5, 12, 0),
    );
  };

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
      expect.objectContaining({
        title: 'api#2041 · Product metadata schema with versioned migrations',
        body: 'New reply in a thread you joined',
        path: '/inbox/attention/acme/api/2041',
      }),
    );
  });

  it('remembers a native notification that could not be sent, so it is not resent', async () => {
    const { store, notifier, native, sync, github } = await setup({ browser: false });

    native.mockImplementation(async () => 'failed' as const);
    notifier.saveSettings({ ...defaultNotificationSettings(), macosWhenClosed: true });
    await sync.sync();
    github.advance();
    await sync.sync();

    const channels = store.db.$client
      .prepare("SELECT DISTINCT channel FROM notification_log WHERE channel LIKE 'macos%'")
      .all() as { channel: string }[];

    expect(native).toHaveBeenCalled();
    expect(channels.map((row) => row.channel)).toEqual(['macos-failed']);
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

  it('announces one-off events once, honouring kind toggles and quiet hours', async () => {
    const { notifier, notified, native } = await setup();
    const ready = (key: string) => ({
      key,
      kind: 'ai_review_ready' as const,
      prId: 'PR_1',
      title: 'web#1 · Change',
      body: 'AI review ready · no findings',
      path: '/inbox/attention/acme/web/1',
    });
    const noon = new Date(2026, 10, 5, 12, 0);

    expect(await notifier.announce('you', [ready('ai:1')], noon)).toHaveLength(1);
    expect(await notifier.announce('you', [ready('ai:1')], noon)).toEqual([]);

    notifier.saveSettings({
      ...defaultNotificationSettings(),
      quietHours: { start: '22:00', end: '08:00' },
    });
    expect(await notifier.announce('you', [ready('ai:2')], new Date(2026, 10, 5, 23, 0))).toEqual(
      [],
    );
    // Held back events cannot be rediscovered, so they are not replayed after quiet hours.
    expect(await notifier.announce('you', [ready('ai:2')], noon)).toEqual([]);

    notifier.saveSettings({
      ...defaultNotificationSettings(),
      kinds: { ...defaultNotificationSettings().kinds, ai_review_ready: false },
    });
    expect(await notifier.announce('you', [ready('ai:3')], noon)).toEqual([]);

    expect(notified()).toEqual([ready('ai:1')]);
    expect(native).not.toHaveBeenCalled();
  });
});
