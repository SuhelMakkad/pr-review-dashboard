// Review Desk service worker: an offline notice when the local server is down, and desktop
// notifications that open the right PR. API responses are never cached.
const CACHE = 'review-desk-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/offline.html', '/icons/icon-192.png'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.mode !== 'navigate') return;

  event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const path = (event.notification.data && event.notification.data.path) || '/inbox/attention';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );

      if (existing) {
        existing.postMessage({ type: 'navigate', path });

        return existing.focus();
      }

      return self.clients.openWindow(path);
    }),
  );
});
