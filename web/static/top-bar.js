// top-bar.js — slim desktop top bar.
//
// On a non-touch browser the user types straight into xterm.js, which
// captures the keyboard — so the touch-only affordances (attach, dictate,
// the reader and read-mode toggles) have no keyboard shortcut and nowhere to
// live.
// This bar surfaces them as icon buttons. It's the desktop counterpart to
// the mobile input bar (input-bar.js); the two are mutually exclusive via
// the isMobile gate in terminal.js.
//
// Attach + dictate reuse the SAME shared actions the mobile bar uses
// (input-actions.js) — one upload path, one mic/transcribe flow, one set of
// `mic.*` telemetry events. The mic button reflects recording state via the
// same `.mic-recording` class the mobile bar uses.
//
// House style: muted, low-contrast, minimal. Self-contained — styles inject
// once, no external CSS dependency (mirrors mic-overlay.js). The bar is a
// flex child at the TOP of `.term-body` so #terminal / #reader reflow below
// it and it never overlaps terminal output.

import { createAttachAction, createDictateAction } from './input-actions.js';

const STYLE_ID = 'mobux-top-bar-style';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#mobux-top-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: #14161a;
  border-bottom: 1px solid #262a30;
  font-family: -apple-system, system-ui, sans-serif;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}
#mobux-top-bar button {
  flex-shrink: 0;
  min-width: 32px;
  height: 28px;
  border: 1px solid #353a42;
  border-radius: 4px;
  background: #1d2127;
  color: #aab0ac;
  font-size: 14px;
  line-height: 1;
  padding: 0 8px;
  cursor: pointer;
}
#mobux-top-bar button:hover { background: #262b32; color: #c8ccc9; }
#mobux-top-bar button:active { background: #2e333b; }
/* Recording state — muted clay, matches the mic-overlay palette (not the
   bright red the mobile ribbon uses). The shared action toggles
   .mic-recording on this button. */
#mobux-top-bar button.mic-recording {
  background: #5a3a3a;
  color: #e3cccc;
  border-color: #7a5050;
  animation: mobuxTopMicPulse 1.4s ease-in-out infinite;
}
@keyframes mobuxTopMicPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(176, 106, 106, 0.45); }
  50%      { box-shadow: 0 0 0 4px rgba(176, 106, 106, 0); }
}
/* Failure state — same red tint + toast pattern as the mobile input bar's
   #uploadBtn.rec-error / .input-toast (style.css), so an attach failure
   looks and behaves identically on both surfaces. Without this the desktop
   attach button was a dead button: the server can now fail a remote upload
   (ssh down, remote mkdir denied, disk full) where the old local-only write
   effectively never did, and there was nowhere on this bar to show it. */
#mobux-top-bar button.rec-error {
  border-color: #ff6b6b;
  background: #5a1f1f;
  color: #ffd2d2;
  animation: mobuxTopRecErrorFlash 0.5s ease-in-out 2;
}
@keyframes mobuxTopRecErrorFlash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 80, 80, 0.0); }
  50%      { box-shadow: 0 0 0 3px rgba(255, 80, 80, 0.55); }
}
#mobux-top-bar-toast {
  position: fixed;
  top: 40px;
  right: 8px;
  max-width: 320px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-family: monospace;
  line-height: 1.3;
  background: #5a1f1f;
  color: #ffd2d2;
  border: 1px solid #ff6b6b;
  z-index: 50;
}
#mobux-top-bar-toast.hidden { display: none; }`;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

// createTopBar({ send, toggleReader, isReader, toggleRead, isRead, node })
//   → { destroy(), sync() }
//   send(str)        inject text/path into the terminal.
//   toggleReader()   flip the view — the SPA owns view state (#206 D3). When
//                    null, no reader toggle is shown (engine runs standalone).
//   isReader()       current view is reader → reflect the toggle icon.
//   toggleRead()     the same pair for read mode (#235); null ⇒ no button.
//   isRead()         current view is read mode → reflect the toggle icon.
//   node             current remote node name ("" ⇒ local host) — passed
//                     through to the shared attach action.
//   sync()           re-read isReader()/isRead() and update the toggle icons;
//                    the owner calls it after a view change (there is no
//                    `mobux:viewchange` event anymore — the SPA drives the
//                    labels directly).
export function createTopBar({
  send,
  toggleReader,
  isReader,
  toggleRead,
  isRead,
  node,
} = {}) {
  ensureStyles();

  const bar = document.createElement('div');
  bar.id = 'mobux-top-bar';

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.title = 'Attach file';
  attachBtn.textContent = '📎';

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.title = 'Dictate (speech to text)';
  micBtn.textContent = '🎤';

  const readerBtn = document.createElement('button');
  readerBtn.type = 'button';
  readerBtn.hidden = !toggleReader;

  const readBtn = document.createElement('button');
  readBtn.type = 'button';
  readBtn.hidden = !toggleRead;

  function syncToggleBtns() {
    const reader = !!isReader?.();
    readerBtn.textContent = reader ? '▣' : '📖';
    readerBtn.title = reader ? 'Switch to terminal view' : 'Switch to reader view';
    const read = !!isRead?.();
    readBtn.textContent = read ? '▣' : '💬';
    readBtn.title = read ? 'Switch to terminal view' : 'Switch to read mode';
  }
  syncToggleBtns();

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.title = 'Settings';
  settingsBtn.textContent = '⚙';

  const toast = document.createElement('div');
  toast.id = 'mobux-top-bar-toast';
  toast.className = 'hidden';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  bar.append(attachBtn, micBtn, readerBtn, readBtn, settingsBtn, toast);

  // Visible failure feedback — mirrors input-bar.js's showError(): tint the
  // button briefly and show a short, accessible message. A failed upload
  // must never be silent (dead-button rule); the mic action already routes
  // its own faults through mic-overlay.js, so this is attach-only for now.
  let toastTimer = null;
  function showError(msg, btn) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
    if (btn) {
      btn.classList.add('rec-error');
      setTimeout(() => btn.classList.remove('rec-error'), 1500);
    }
  }

  const attach = createAttachAction({
    send,
    node,
    onError: (msg) => showError(msg, attachBtn),
  });
  const dictate = createDictateAction({ send, button: micBtn });

  attachBtn.addEventListener('click', (e) => { e.preventDefault(); attach.trigger(); });
  micBtn.addEventListener('click', (e) => { e.preventDefault(); dictate.toggle(); });
  readerBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleReader?.();
    syncToggleBtns();
  });

  readBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleRead?.();
    syncToggleBtns();
  });

  settingsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/settings';
  });

  // Mount at the TOP of the flex column so #terminal / #reader reflow below.
  const body = document.querySelector('.term-body') || document.body;
  body.insertBefore(bar, body.firstChild);
  // The terminal sizes to its host's clientHeight; shrinking it by the bar's
  // row needs a resize so the backend recomputes cols/rows.
  window.dispatchEvent(new Event('resize'));

  return {
    // Full teardown for a same-document engine remount: an active
    // dictation's mic stream + full-viewport overlay live outside `bar`
    // (mic-overlay.js mounts its own root on document.body), so `bar.remove()`
    // alone would leave both behind.
    destroy() {
      attach.destroy?.();
      dictate.destroy?.();
      bar.remove();
      window.dispatchEvent(new Event('resize'));
    },
    // Re-read isReader()/isRead() and update the toggle icons. Called by the
    // owner after a view change (boot default, per-window override, ribbon
    // toggle).
    sync: syncToggleBtns,
  };
}
