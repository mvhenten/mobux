// In-page chime — plays a short bell sample whenever the SW receives a push.
// HTMLAudioElement is the simplest portable way to play a pre-encoded asset;
// browsers will use the audio decoder pipeline rather than synthesizing on
// the main thread, and a pre-baked OGG sounds nicer than what you can put
// together with Web Audio in a hurry.
//
// Browsers gate audio playback on a user gesture. We unlock the element on
// the first interaction with the page so subsequent push-driven plays work
// without a click.
//
// This is the one file here that cannot import base.js: the SPA appends it as
// a CLASSIC <script>, so there is no `import.meta.url` and no module scope.
// `document.currentScript.src` is the classic-script equivalent — the resolved
// URL of this very file — and the app root is the same one directory up from
// `<prefix>/static/` that base.js derives.

(function () {
  'use strict';

  if (!('serviceWorker' in navigator) || !('Audio' in window)) return;

  const base = new URL('../', document.currentScript.src);
  const audio = new Audio(new URL('static/chime.ogg', base).href);
  audio.preload = 'auto';
  audio.volume = 0.7;

  let unlocked = false;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    // Silently play-then-pause to satisfy the autoplay policy.
    audio.play().then(() => {
      audio.pause();
      audio.currentTime = 0;
    }).catch(() => {
      // Some browsers (e.g. iOS Safari) require a real audible play; ignore
      // the rejection — the next user gesture will get another chance.
      unlocked = false;
    });
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, unlock, { once: true, passive: true }),
  );

  function chime() {
    try {
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // Ignore — chime is best-effort.
    }
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'mobux-push') {
      chime();
    }
  });

  // Expose for debugging from the console.
  window.__mobuxChime = chime;
})();
