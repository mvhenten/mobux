// telemetry.js — built-in client telemetry channel.
//
// A small, general-purpose diagnostic channel for the frontend. Always on:
// every telemetry.log() forwards a line to the server journal via
// POST /api/telemetry (fire-and-forget) and can render a toggleable
// on-screen overlay so you can watch events on the device itself. mobux is a
// self-hosted single-operator tool, so there's no privacy boundary to gate
// this behind — it ships live in every build, dev or not.
//
// Usage (from any module):
//   import telemetry from '/static/telemetry.js';
//   telemetry.log('ws-open', { session });        // structured
//   telemetry.log('resize', `${cols}x${rows}`);   // or a plain string
//
// Overlay: off by default, on when `?telemetry=1` is in the URL.
// `telemetry.overlay(true|false)` toggles it at runtime. The runtime toggle is
// in-memory only (mobux keeps no client-side storage), so it resets on reload;
// use the URL param for a choice that survives a reload.

// Per-page session id so lines from one page load are correlatable in the
// journal. Short random token; not security-sensitive.
const SESSION_ID = (() => {
  try {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID().slice(0, 8);
    }
  } catch (_) {
    /* fall through */
  }
  return Math.random().toString(36).slice(2, 10);
})();

let overlayEl = null;
// Runtime overlay state, in-memory for this page load only.
let overlayOn = false;

function overlayEnabled() {
  if (overlayOn) return true;
  try {
    if (new URLSearchParams(window.location.search).get('telemetry') === '1') {
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

function ensureOverlay() {
  if (overlayEl || !document.body) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.id = 'mobux-telemetry-overlay';
  // Inline styles keep the module self-contained (no CSS dependency).
  Object.assign(overlayEl.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    maxHeight: '40vh',
    overflowY: 'auto',
    margin: '0',
    padding: '4px 6px',
    font: '11px/1.35 monospace',
    color: '#9fe',
    background: 'rgba(0,0,0,0.78)',
    zIndex: '2147483647',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    pointerEvents: 'none',
  });
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function appendOverlay(line) {
  const el = ensureOverlay();
  if (!el) return;
  const row = document.createElement('div');
  row.textContent = line;
  el.appendChild(row);
  // Cap the DOM so a chatty page can't grow it unbounded.
  while (el.childNodes.length > 200) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function format(event, data) {
  let payload = '';
  if (data !== undefined) {
    if (typeof data === 'string') {
      payload = data;
    } else {
      try {
        payload = JSON.stringify(data);
      } catch (_) {
        payload = String(data);
      }
    }
  }
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  return `${ts} [${SESSION_ID}] ${event}${payload ? ' ' + payload : ''}`;
}

function log(event, data) {
  const line = format(event, data);

  // Fire-and-forget. Swallow all errors — never let telemetry break the page.
  try {
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: line,
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  } catch (_) {
    /* ignore */
  }

  if (overlayEnabled()) {
    try {
      appendOverlay(line);
    } catch (_) {
      /* ignore */
    }
  }
}

// Runtime overlay toggle (in-memory for this page load); pass nothing to flip.
function overlay(on) {
  const next = on === undefined ? !overlayEnabled() : !!on;
  overlayOn = next;
  if (next) {
    ensureOverlay();
  } else if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  return next;
}

const telemetry = {
  log,
  overlay,
  sessionId: SESSION_ID,
};

try {
  window.mobuxTelemetry = telemetry;
} catch (_) {
  /* ignore */
}

if (overlayEnabled()) {
  if (document.body) {
    ensureOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', () => ensureOverlay(), { once: true });
  }
}

export default telemetry;
export { log, overlay };
