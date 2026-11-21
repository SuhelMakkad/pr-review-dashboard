import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@/db/store.js';

const cleanups: (() => unknown)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function memoryStore() {
  const store = new Store(':memory:');

  cleanups.push(() => store.close());

  return store;
}

describe('the notification log', () => {
  it('remembers a delivery per account and key, keeping the first', () => {
    const store = memoryStore();
    const notifications = Array.from({ length: 250 }, (_, index) => ({
      key: `reply:${index}`,
      prId: `pr-${index}`,
    }));

    store.notificationLog.remember('you', notifications, 'app', '2026-11-21T10:00:00.000Z');
    store.notificationLog.remember(
      'you',
      notifications.slice(0, 1),
      'macos',
      '2026-11-21T11:00:00.000Z',
    );

    expect(store.notificationLog.seen('you', 'reply:0')).toBe(true);
    expect(store.notificationLog.seen('you', 'reply:249')).toBe(true);
    expect(store.notificationLog.seen('other', 'reply:0')).toBe(false);
    expect(
      store.db.$client.prepare('SELECT channel FROM notification_log WHERE key = ?').get('reply:0'),
    ).toEqual({ channel: 'app' });
  });
});

describe('activity', () => {
  it("names each PR the account has activity for once, and no other account's", () => {
    const store = memoryStore();
    const event = (key: string, prId: string) => ({
      key,
      prId,
      repository: 'acme/repo',
      number: 1,
      kind: 'comment_posted' as const,
      actor: 'ann',
      at: '2026-11-21T10:00:00.000Z',
    });

    store.recordActivity('you', [event('a', 'pr-1'), event('b', 'pr-1'), event('c', 'pr-2')]);
    store.recordActivity('other', [event('d', 'pr-3')]);

    expect(store.activityPullIds('you').sort()).toEqual(['pr-1', 'pr-2']);
  });
});
