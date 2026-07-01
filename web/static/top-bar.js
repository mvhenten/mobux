// top-bar.js — slim desktop top bar.
//
// On a non-touch browser the user types straight into xterm.js, which
// captures the keyboard — so the three touch-only affordances (attach,
// dictate, reader toggle) have no keyboard shortcut and nowhere to live.
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
}`;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

// createTopBar({ send, toggleReader, isReader }) → { destroy() }
//   send(str)        inject text/path into the terminal.
//   toggleReader()   flip xterm <-> reader (terminal.js owns swapView).
//   isReader()       current view is reader → reflect the toggle icon.
export function createTopBar({ send, toggleReader, isReader } = {}) {
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

  function syncReaderBtn() {
    const reader = !!isReader?.();
    readerBtn.textContent = reader ? '▣' : '📖';
    readerBtn.title = reader ? 'Switch to terminal view' : 'Switch to reader view';
  }
  syncReaderBtn();

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.title = 'Settings';
  settingsBtn.textContent = '⚙';

  bar.append(attachBtn, micBtn, readerBtn, settingsBtn);

  const attach = createAttachAction({ send });
  const dictate = createDictateAction({ send, button: micBtn });

  attachBtn.addEventListener('click', (e) => { e.preventDefault(); attach.trigger(); });
  micBtn.addEventListener('click', (e) => { e.preventDefault(); dictate.toggle(); });
  readerBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleReader?.();
    syncReaderBtn();
  });

  settingsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/settings';
  });
  // Keep the toggle icon in sync when the view changes elsewhere
  // (boot default, mobile path, future shortcuts).
  window.addEventListener('mobux:viewchange', syncReaderBtn);

  // Mount at the TOP of the flex column so #terminal / #reader reflow below.
  const body = document.querySelector('.term-body') || document.body;
  body.insertBefore(bar, body.firstChild);
  // The terminal sizes to its host's clientHeight; shrinking it by the bar's
  // row needs a resize so the backend recomputes cols/rows.
  window.dispatchEvent(new Event('resize'));

  return {
    destroy() {
      window.removeEventListener('mobux:viewchange', syncReaderBtn);
      bar.remove();
      window.dispatchEvent(new Event('resize'));
    },
  };
}
