import { and, eq } from 'drizzle-orm';
import { batches } from '@/db/batches.js';
import { notificationLog } from '@/db/schema.js';
import type { Database } from '@/db/store.js';

/**
 * Notifications already delivered, so each one is sent at most once per account and key. Opens no
 * transaction of its own: the notifier records each delivery in one.
 */
export class NotificationLog {
  constructor(private readonly db: Database) {}

  /** True when a notification with this key was delivered to the account. */
  seen(account: string, key: string): boolean {
    return Boolean(
      this.db
        .select({ key: notificationLog.key })
        .from(notificationLog)
        .where(and(eq(notificationLog.account, account), eq(notificationLog.key, key)))
        .get(),
    );
  }

  /** Records `notifications` as delivered on `channel`; one already recorded stays as it was. */
  remember(
    account: string,
    notifications: { key: string; prId: string }[],
    channel: string,
    sentAt: string,
  ): void {
    for (const batch of batches(notifications)) {
      this.db
        .insert(notificationLog)
        .values(
          batch.map((notification) => ({
            account,
            key: notification.key,
            prId: notification.prId,
            channel,
            sentAt,
          })),
        )
        .onConflictDoNothing()
        .run();
    }
  }
}
