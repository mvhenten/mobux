// Renderer picker on the settings page. Reads + writes
// `localStorage['mobux:renderer']` ('xterm' | 'sterk'). Default 'xterm'.
//
// The page-level boot script in render_terminal_page reads this on
// load and document.write()s the matching bundle script tag. So a
// change here doesn't apply to any already-open terminal tab until
// it reloads — we show a hint to that effect.

(function () {
  'use strict';

  const KEY = 'mobux:renderer';
  const VALID = new Set(['xterm', 'sterk']);
  const DEFAULT = 'xterm';

  const select = document.getElementById('rendererSelect');
  const status = document.getElementById('rendererStatus');
  if (!select) return;

  function showStatus(text) {
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
      status.hidden = true;
    }, 3000);
  }

  function read() {
    try {
      const v = localStorage.getItem(KEY);
      if (VALID.has(v)) return v;
    } catch (_) {}
    return DEFAULT;
  }

  select.value = read();

  select.addEventListener('change', () => {
    const v = VALID.has(select.value) ? select.value : DEFAULT;
    try { localStorage.setItem(KEY, v); } catch (_) {}
    showStatus(`Saved. Reload any open terminal tab to switch to ${v}.`);
  });
})();
