// ── Web Push subscription toggle ──────────────────────────────────────
//
// Wires the #pushToggleBtn in the terminal page input ribbon to the mobux
// push API. Bell-icon button: 🔔 = not subscribed, 🔕 = subscribed.
//
// Vanilla JS, no build step. Bails out silently if the browser lacks
// service worker or PushManager support (e.g. desktop Firefox without
// notifications, or any browser over plain HTTP).

(function () {
  'use strict';

  const btn = document.getElementById('pushToggleBtn');
  if (!btn) return;

  const supported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  if (!supported) {
    // Leave the button hidden. Nothing to wire up.
    return;
  }

  btn.hidden = false;

  // ── base64url <-> Uint8Array ────────────────────────────────────────
  // VAPID applicationServerKey wants raw bytes; the wire format is base64url.
  function b64urlToBytes(b64url) {
    const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
    const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    let bin = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
    return btoa(bin)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  // ── UI state ────────────────────────────────────────────────────────
  function paint(subscribed) {
    btn.textContent = subscribed ? '🔕' : '🔔';
    btn.dataset.subscribed = subscribed ? '1' : '0';
    btn.title = subscribed ? 'Disable notifications' : 'Enable notifications';
  }

  function setBusy(busy) {
    btn.disabled = busy;
    btn.style.opacity = busy ? '0.5' : '';
  }

  // ── Subscribe flow ──────────────────────────────────────────────────
  async function subscribe() {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      throw new Error('notification permission denied');
    }

    const keyRes = await fetch('/api/push/vapid-public-key');
    if (!keyRes.ok) throw new Error('vapid key fetch failed: ' + keyRes.status);
    const { key } = await keyRes.json();
    if (!key) throw new Error('vapid key response missing "key"');

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToBytes(key),
    });

    const json = sub.toJSON();
    const p256dh = json.keys && json.keys.p256dh;
    const auth = json.keys && json.keys.auth;
    if (!p256dh || !auth) throw new Error('subscription missing p256dh/auth');

    // toJSON already gives us base64url-encoded keys; pass through to server.
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        p256dh,
        auth,
        label: deviceLabel(),
      }),
    });
    if (!res.ok) {
      throw new Error('subscribe POST failed: ' + res.status);
    }
  }

  // ── Unsubscribe flow ────────────────────────────────────────────────
  async function unsubscribe() {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      // Best-effort DELETE — even if the server roundtrip fails, the local
      // unsubscribe already happened, so the button state is correct.
      try {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
      } catch (_) {
        // ignore
      }
    }
  }

  function deviceLabel() {
    // Cheap label hint so the future "manage devices" UI has something
    // human-readable. UA strings are noisy but better than nothing.
    return navigator.userAgent.slice(0, 120);
  }

  // ── Wire button + reflect existing state on load ────────────────────
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    setBusy(true);
    try {
      const isSub = btn.dataset.subscribed === '1';
      if (isSub) {
        await unsubscribe();
        paint(false);
      } else {
        await subscribe();
        paint(true);
      }
    } catch (err) {
      console.error('[push] toggle failed:', err);
      // No console on a phone — surface the error directly so the user can
      // see what went wrong. Notifications are an explicit user action,
      // so a short alert is fine.
      try {
        alert('Notifications: ' + (err && err.message ? err.message : String(err)));
      } catch (_) {
        // Some embedded contexts disallow alert; ignore.
      }
      // Re-sync from real state in case we partially succeeded.
      try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        paint(!!sub);
      } catch (_) {
        paint(false);
      }
    } finally {
      setBusy(false);
    }
  });

  // Don't let the ribbon's mousedown handler swallow our click on mobile,
  // and don't steal focus from the text input.
  btn.addEventListener('mousedown', (e) => e.preventDefault());

  (async function init() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      paint(!!sub);
    } catch (err) {
      console.warn('[push] state probe failed:', err);
      paint(false);
    }
  })();
})();
