import { and, eq } from 'drizzle-orm';
import type { AuthorItem } from '@review-desk/shared/author';
import {
  defaultNotificationSettings,
  inQuietHours,
  type NotificationKind,
  type NotificationSettings,
  type ReviewNotification,
} from '@review-desk/shared/notify';
import type { PullRequestItem } from '@review-desk/shared/types';
import { notificationLog } from '@/db/schema.js';
import { batches, type Store } from '@/db/store.js';
import type { EventBus } from '@/events.js';

const SETTINGS_KEY = 'notification-settings';

const pathFor = (item: { repository: string; number: number }, base: 'inbox/attention' | 'mine') =>
  `/${base}/${item.repository}/${item.number}`;

const reviewerCopy: Record<string, (item: PullRequestItem) => string> = {
  first_review: (item) => `${item.author.login} asked for your review`,
  changed: (item) => `${item.author.login} pushed after your review`,
  requested_again: (item) => `${item.author.login} asked you to review again`,
  reply: () => 'New reply in a thread you joined',
  mention: () => 'You were mentioned',
  dismissed: () => 'Your review was dismissed',
};

/** Everything currently worth telling the user, keyed so each fact is announced once. */
export function candidates(reviewing: PullRequestItem[], mine: AuthorItem[]): ReviewNotification[] {
  const list: ReviewNotification[] = [];

  for (const item of reviewing) {
    if (item.queue !== 'attention') continue;

    for (const reason of item.reasons) {
      list.push({
        key: `review:${item.id}:${reason.key}`,
        kind: reason.kind as NotificationKind,
        prId: item.id,
        title: `${item.repository.split('/')[1]}#${item.number} · ${item.title}`,
        body: reviewerCopy[reason.kind]?.(item) ?? reason.label,
        path: pathFor(item, 'inbox/attention'),
      });
    }
  }

  for (const item of mine) {
    const title = `${item.repository.split('/')[1]}#${item.number} · ${item.title}`;

    for (const blocker of item.blockers) {
      if (blocker.kind === 'changes_requested' || blocker.kind === 'ci_failing') {
        list.push({
          key: `mine:${item.id}:${blocker.kind}:${blocker.people?.join(',') ?? item.updatedAt}`,
          kind: blocker.kind,
          prId: item.id,
          title,
          body: blocker.label,
          path: pathFor(item, 'mine'),
        });
      }
    }

    if (item.group === 'ready') {
      list.push({
        key: `mine:${item.id}:ready:${item.approvals.join(',')}`,
        kind: 'approved',
        prId: item.id,
        title,
        body: `Approved by ${item.approvals.join(', ')} — ready to merge`,
        path: pathFor(item, 'mine'),
      });
    }
  }

  return list;
}

/**
 * Decides which notifications to send after a sync. The first run only records what already
 * exists, so starting the app never floods you; later runs announce each new fact once.
 */
export class Notifier {
  private primed = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly events: EventBus,
    private readonly macos: (title: string, body: string) => Promise<void>,
  ) {}

  /** Forget that an account was primed (demo reset), so its backlog is not announced as new. */
  reset(account: string): void {
    this.primed.delete(account);
  }

  settings(): NotificationSettings {
    const saved = this.store.getSetting<Partial<NotificationSettings>>(SETTINGS_KEY);
    const defaults = defaultNotificationSettings();

    return { ...defaults, ...saved, kinds: { ...defaults.kinds, ...saved?.kinds } };
  }

  saveSettings(settings: NotificationSettings): NotificationSettings {
    this.store.setSetting(SETTINGS_KEY, settings);

    return this.settings();
  }

  private seen(account: string, key: string): boolean {
    return Boolean(
      this.store.db
        .select({ key: notificationLog.key })
        .from(notificationLog)
        .where(and(eq(notificationLog.account, account), eq(notificationLog.key, key)))
        .get(),
    );
  }

  private remember(account: string, notifications: ReviewNotification[], channel: string) {
    const sentAt = new Date().toISOString();

    this.store.transaction(() => {
      for (const batch of batches(notifications)) {
        this.store.db
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
    });
  }

  /** Called after every sync with the current inbox and author view. */
  async afterSync(
    account: string,
    reviewing: PullRequestItem[],
    mine: AuthorItem[],
    now = new Date(),
  ): Promise<ReviewNotification[]> {
    const all = candidates(reviewing, mine);
    const fresh = all.filter((notification) => !this.seen(account, notification.key));

    if (!this.primed.has(account)) {
      this.primed.add(account);
      this.remember(account, fresh, 'primed');

      return [];
    }

    // Held back during quiet hours: the facts persist, so the next sync announces them.
    if (inQuietHours(this.settings().quietHours, now)) return [];

    return this.deliver(account, fresh);
  }

  /**
   * Announces one-off events, such as an automatic review finishing, that later syncs cannot
   * rediscover. Each key is announced once; quiet hours drop it, since it cannot be replayed.
   */
  async announce(
    account: string,
    notifications: ReviewNotification[],
    now = new Date(),
  ): Promise<ReviewNotification[]> {
    const fresh = notifications.filter((notification) => !this.seen(account, notification.key));

    if (fresh.length === 0) return [];

    if (inQuietHours(this.settings().quietHours, now)) {
      this.remember(account, fresh, 'quiet');

      return [];
    }

    return this.deliver(account, fresh);
  }

  private async deliver(
    account: string,
    fresh: ReviewNotification[],
  ): Promise<ReviewNotification[]> {
    const settings = this.settings();
    const wanted = fresh.filter((notification) => settings.kinds[notification.kind]);

    // Unwanted kinds are still remembered, so turning a kind on later does not replay history.
    this.remember(
      account,
      fresh.filter((notification) => !settings.kinds[notification.kind]),
      'muted',
    );

    if (wanted.length === 0) return [];

    if (this.events.subscriberCount > 0) {
      this.events.emit({ type: 'notify', notifications: wanted });
      this.remember(account, wanted, 'browser');
    } else if (settings.macosWhenClosed) {
      const first = wanted[0];
      const more = wanted.length > 1 ? ` (+${wanted.length - 1} more)` : '';

      await this.macos(first.title, `${first.body}${more}`);
      this.remember(account, wanted, 'macos');
    } else {
      this.remember(account, wanted, 'none');
    }

    return wanted;
  }
}
