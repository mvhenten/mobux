// Minimal push-only service worker.
// No fetch handler, no precache — mobux relies on the cache_bust query param
// for static asset versioning instead.
// The Rust handler at /sw.js appends a per-restart version comment so this
// file's bytes differ on every release, forcing Chrome to re-install the
// SW and run skipWaiting + clients.claim.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Everything the SW points at resolves against its own registration scope, so
// a mobux mounted under a path prefix keeps its icons and deep links inside
// that prefix. At the empty prefix the scope is the origin root, which makes
// every result identical to the old absolute paths.
const SCOPE = self.registration.scope;
const resolve = (url) => {
  try { return new URL(url, SCOPE).href; }
  catch (_) { return SCOPE; }
};

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'mobux';
  const url = resolve(data.url || './');
  const options = {
    body: data.body || '',
    tag: data.tag,
    data: { url },
    icon: resolve('static/icon-192.png'),
    badge: resolve('static/icon-192.png'),
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
            c.postMessage({ type: 'mobux-push', title, body: data.body, url }),
          ),
        ),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // `url` is exactly the deep link the server chose when it sent the push
  // (push.rs::session_url), only anchored to the scope — the SW picks no
  // destination of its own, so there's no separate node-correctness question
  // here: whatever push.rs/terminal_page decided is what opens (issue #210).
  const target = new URL(resolve(event.notification.data?.url || './'));
  // Match an open client by session pathname (the `?w=N` query holds
  // the originating tmux window). On a hit, focus the existing tab and
  // post `mobux-navigate` so it can switch windows internally — no
  // duplicate tab, no full reload.
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      for (const client of all) {
        let cu;
        try { cu = new URL(client.url); } catch (_) { continue; }
        if (cu.pathname === target.pathname) {
          client.postMessage({ type: 'mobux-navigate', url: target.href });
          return client.focus();
        }
      }
      return clients.openWindow(target.href);
    })
  );
});
