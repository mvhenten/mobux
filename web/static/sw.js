// Minimal service worker — required for PWA installability.
// Network-first: always fetch from server, no offline caching
// (terminal needs a live connection anyway).

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
