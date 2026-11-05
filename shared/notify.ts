/** Desktop notification contract. */

export type NotificationKind =
  | 'first_review'
  | 'changed'
  | 'requested_again'
  | 'reply'
  | 'mention'
  | 'dismissed'
  | 'changes_requested'
  | 'approved'
  | 'ci_failing';

export interface ReviewNotification {
  key: string;
  kind: NotificationKind;
  prId: string;
  title: string;
  body: string;
  /** In-app path to open when the notification is clicked. */
  path: string;
}

export interface NotificationSettings {
  kinds: Record<NotificationKind, boolean>;
  /** Local times "HH:MM"; notifications are held back in between. */
  quietHours: { start: string; end: string } | null;
  /** Native macOS notifications when no Review Desk window is open. */
  macosWhenClosed: boolean;
  /** Count your own PRs that need you in the dock badge. */
  badgeIncludesMine: boolean;
}

export const notificationKindLabels: Record<NotificationKind, string> = {
  first_review: 'New review requests',
  changed: 'New commits after your review',
  requested_again: 'Review requested again',
  reply: 'Replies in your threads',
  mention: 'Mentions',
  dismissed: 'Your review dismissed',
  changes_requested: 'Changes requested on your PRs',
  approved: 'Your PRs approved and ready',
  ci_failing: 'Checks failing on your PRs',
};

export const defaultNotificationSettings = (): NotificationSettings => ({
  kinds: {
    first_review: true,
    changed: true,
    requested_again: true,
    reply: true,
    mention: true,
    dismissed: false,
    changes_requested: true,
    approved: true,
    ci_failing: true,
  },
  quietHours: null,
  macosWhenClosed: false,
  badgeIncludesMine: false,
});

/** True when `now` (local time) falls inside quiet hours, including spans across midnight. */
export function inQuietHours(quiet: NotificationSettings['quietHours'], now = new Date()): boolean {
  if (!quiet) return false;

  const minutes = (value: string) => {
    const [hours, mins] = value.split(':').map(Number);

    return hours * 60 + mins;
  };
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);

  return start <= end ? current >= start && current < end : current >= start || current < end;
}
