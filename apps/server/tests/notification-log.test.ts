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
  it('remembers a notification per account and key, keeping the first', () => {
    const store = memoryStore();
    const notifications = Array.from({ length: 250 }, (_, index) => ({
      key: `reply:${index}`,
      prId: `pr-${index}`,
    }));
    const row = (account: string, key: string) =>
      store.db.$client
        .prepare(
          'SELECT pr_id AS prId, channel, sent_at AS sentAt FROM notification_log WHERE account = ? AND key = ?',
        )
        .get(account, key);

    store.notificationLog.remember('you', notifications, 'app', '2026-11-21T10:00:00.000Z');
    store.notificationLog.remember(
      'other',
      [{ key: 'reply:0', prId: 'pr-other' }],
      'macos',
      '2026-11-21T10:30:00.000Z',
    );
    // A second record of the same key changes nothing.
    store.notificationLog.remember(
      'you',
      [{ key: 'reply:0', prId: 'pr-changed' }],
      'macos',
      '2026-11-21T11:00:00.000Z',
    );

    expect(store.notificationLog.seen('you', 'reply:249')).toBe(true);
    expect(store.notificationLog.seen('other', 'reply:1')).toBe(false);
    expect(row('you', 'reply:0')).toEqual({
      prId: 'pr-0',
      channel: 'app',
      sentAt: '2026-11-21T10:00:00.000Z',
    });
    expect(row('other', 'reply:0')).toEqual({
      prId: 'pr-other',
      channel: 'macos',
      sentAt: '2026-11-21T10:30:00.000Z',
    });
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
