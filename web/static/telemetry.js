// telemetry.js — dev-only client telemetry channel.
//
// A small, general-purpose diagnostic channel for the frontend. It forwards
// lines to the server journal via POST /api/telemetry (fire-and-forget) and
// can render a toggleable on-screen overlay so you can watch events on the
// device itself.
//
// HARD GATE: everything is a no-op unless dev mode is on (`window.MOBUX_DEV`,
// injected by the server when MOBUX_DEV=1). In production the flag is false,
// so importing this module has no side effects, nothing posts, and no overlay
// renders — the /api/telemetry route is itself a 404 in prod anyway.
//
// Usage (from any module):
//   import telemetry from '/static/telemetry.js';
//   telemetry.log('ws-open', { session });        // structured
//   telemetry.log('resize', `${cols}x${rows}`);   // or a plain string
//
// Overlay: on when dev mode is on AND (`?telemetry=1` in the URL OR
// localStorage['mobux:telemetry'] === '1'). `telemetry.overlay(true|false)`
// toggles it at runtime (and persists the choice).

const DEV = (() => {
  try {
    return window.MOBUX_DEV === true;
  } catch (_) {
    return false;
  }
})();

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

const OVERLAY_KEY = 'mobux:telemetry';

let overlayEl = null;

function overlayEnabled() {
  if (!DEV) return false;
  try {
    if (new URLSearchParams(window.location.search).get('telemetry') === '1') {
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  try {
    return localStorage.getItem(OVERLAY_KEY) === '1';
  } catch (_) {
    return false;
  }
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
  if (!DEV) return; // no-op in production
  const line = format(event, data);

  // Fire-and-forget. Swallow all errors — never recurse on failure, never let
  // telemetry break the page.
  try {
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: line,
      // same-origin so the auth cookie rides along; the server gates on dev.
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

// Runtime overlay toggle. Persists the choice; pass nothing to flip.
function overlay(on) {
  if (!DEV) return false;
  const next = on === undefined ? !overlayEnabled() : !!on;
  try {
    localStorage.setItem(OVERLAY_KEY, next ? '1' : '0');
  } catch (_) {
    /* ignore */
  }
  if (next) {
    ensureOverlay();
  } else if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  return next;
}

const telemetry = { log, overlay, enabled: DEV, sessionId: SESSION_ID };

// Convenience: expose on window in dev so you can poke it from the console
// (`window.mobuxTelemetry.log('hi')`). Never attached in production.
if (DEV) {
  try {
    window.mobuxTelemetry = telemetry;
  } catch (_) {
    /* ignore */
  }
  // If the overlay was already requested for this page, materialise it once
  // the DOM is ready, without waiting for the first log() call.
  if (overlayEnabled()) {
    if (document.body) {
      ensureOverlay();
    } else {
      document.addEventListener('DOMContentLoaded', () => ensureOverlay(), { once: true });
    }
  }
}

export default telemetry;
export { log, overlay };
