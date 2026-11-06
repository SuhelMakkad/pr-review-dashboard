import { toast } from 'sonner';
import type { ReviewNotification } from '../../../../packages/shared/src/notify';

let leader = false;
let navigateTo: (path: string) => void = (path) => window.location.assign(path);

/**
 * One window shows notifications even when several are open: the first to take the lock leads
 * until it closes. Notification clicks from the service worker navigate this window.
 */
export function startNotifications(navigate: (path: string) => void): void {
  navigateTo = navigate;

  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    void navigator.locks.request('review-desk-notifications', () => {
      leader = true;

      return new Promise<void>(() => {});
    });
  } else {
    leader = true;
  }

  navigator.serviceWorker?.addEventListener(
    'message',
    (event: MessageEvent<{ type?: string; path?: string }>) => {
      if (event.data?.type === 'navigate' && event.data.path) navigateTo(event.data.path);
    },
  );
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** In-app toasts while you are looking at Review Desk; desktop notifications otherwise. */
export async function present(notifications: ReviewNotification[]): Promise<void> {
  if (!leader || notifications.length === 0) return;

  const looking = document.visibilityState === 'visible' && document.hasFocus();

  if (looking || !notificationsSupported() || Notification.permission !== 'granted') {
    for (const notification of notifications.slice(0, 3)) {
      toast(notification.title, {
        description: notification.body,
        action: { label: 'Open', onClick: () => navigateTo(notification.path) },
      });
    }

    return;
  }

  const registration = await navigator.serviceWorker?.getRegistration();

  for (const notification of notifications.slice(0, 5)) {
    const options = {
      body: notification.body,
      tag: notification.key,
      icon: '/icons/icon-192.png',
      data: { path: notification.path },
    };

    if (registration) await registration.showNotification(notification.title, options);
    else
      new Notification(notification.title, options).onclick = () => navigateTo(notification.path);
  }
}

/** The dock / taskbar badge on the installed app, where the browser supports it. */
export function setBadge(count: number): void {
  const target = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };

  if (!target.setAppBadge) return;

  void (count > 0 ? target.setAppBadge(count) : target.clearAppBadge?.())?.catch(() => undefined);
}
