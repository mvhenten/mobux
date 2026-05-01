// Minimal push-only service worker.
// No fetch handler, no precache — mobux relies on the cache_bust query param
// for static asset versioning instead.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'mobux';
  const options = {
    body: data.body || '',
    tag: data.tag,
    data: { url: data.url || '/' },
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    // Two-pulse vibration. Universal "noticed it" signal that works even
    // when the device is on silent. Sound itself is OS-channel-controlled
    // and can't be set from the SW; users who want a chime configure the
    // Mobux app's notification channel in Android Settings.
    vibrate: [180, 80, 180],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((all) => {
      for (const client of all) {
        if (client.url.includes(url)) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
