import { pullPath, shortRef } from '@review-desk/shared/accounts';
import { addedByHand } from '@review-desk/shared/attention';
import type { AuthorItem } from '@review-desk/shared/author';
import {
  defaultNotificationSettings,
  inQuietHours,
  type NotificationKind,
  type NotificationSettings,
  type ReviewNotification,
} from '@review-desk/shared/notify';
import type { PullRequestItem } from '@review-desk/shared/types';
import type { Store } from '@/db/store.js';
import type { EventBus } from '@/events.js';
import { NOTIFICATION_SETTINGS } from '@/db/settings.js';

const pathFor = (item: { repository: string; number: number }, base: 'inbox/attention' | 'mine') =>
  pullPath(base, item);

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
      // You added it yourself, so nobody "asked for your review".
      if (reason.kind === 'first_review' && addedByHand(item)) continue;

      list.push({
        key: `review:${item.id}:${reason.key}`,
        kind: reason.kind as NotificationKind,
        prId: item.id,
        title: `${shortRef(item)} · ${item.title}`,
        body: reviewerCopy[reason.kind]?.(item) ?? reason.label,
        path: pathFor(item, 'inbox/attention'),
      });
    }
  }

  for (const item of mine) {
    const title = `${shortRef(item)} · ${item.title}`;

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
    // Saved settings over the defaults, each field on its own (see `NOTIFICATION_SETTINGS`).
    return this.store.settings.get(NOTIFICATION_SETTINGS) ?? defaultNotificationSettings();
  }

  saveSettings(settings: NotificationSettings): NotificationSettings {
    this.store.settings.set(NOTIFICATION_SETTINGS, settings);

    return this.settings();
  }

  private seen(account: string, key: string): boolean {
    return this.store.notificationLog.seen(account, key);
  }

  private remember(account: string, notifications: ReviewNotification[], channel: string) {
    const sentAt = new Date().toISOString();

    this.store.transaction(() =>
      this.store.notificationLog.remember(account, notifications, channel, sentAt),
    );
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
