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
  // Notify any open client tabs so they can play the in-page chime
  // (HTMLAudioElement isn't available inside the SW).
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((cs) =>
          cs.forEach((c) =>
            c.postMessage({ type: 'mobux-push', title, body: data.body, url: data.url || '/' }),
          ),
        ),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  // Match an open client by session pathname (the `?w=N` query holds
  // the originating tmux window). On a hit, focus the existing tab and
  // post `mobux-navigate` so it can switch windows internally — no
  // duplicate tab, no full reload.
  let target;
  try { target = new URL(url, self.location.origin); }
  catch (_) { target = new URL('/', self.location.origin); }
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      for (const client of all) {
        let cu;
        try { cu = new URL(client.url); } catch (_) { continue; }
        if (cu.pathname === target.pathname) {
          client.postMessage({ type: 'mobux-navigate', url });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
