// ── Mobile Input Bar ─────────────────────────────────────────────────
//
// Bottom bar with control-key ribbon + text input.
// Replaces direct xterm.js textarea interaction on mobile.
//
// - Ribbon buttons send control chars / escape sequences directly to PTY
// - Text input: native keyboard with autocomplete/voice. Enter sends + clears.
// - Bar appears on tap, hides when keyboard dismisses.

import { createAttachAction, createDictateAction } from './input-actions.js';
import telemetry from './telemetry.js';

export function createInputBar(engine, send, node = '') {
  const bar = document.getElementById('inputBar');
  const ribbon = document.getElementById('inputRibbon');
  const input = document.getElementById('inputText');
  const sendBtn = document.getElementById('inputSend');
  // Complete no-op shape: callers invoke .show()/.hide(), so a partial stub
  // would throw. Mirror the real public API below.
  if (!bar || !input) return { show() {}, hide() {}, destroy() {} };

  // ── Disable the renderer's native input on mobile ─────────────────
  // We own input now. Tell the renderer to release its native input surface
  // so it can't steal focus / pop the soft keyboard (R15). The engine routes
  // this to the live adapter — the input bar never touches renderer internals.
  engine.setNativeInputEnabled(false);

  // ── Parse escape sequences from data-key attributes ───────────────
  function parseKey(raw) {
    return raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
              .replace(/\\t/g, '\t')
              .replace(/\\n/g, '\n')
              .replace(/\\r/g, '\r');
  }

  // ── Show/hide bar ─────────────────────────────────────────────────
  // The bar is now a flex item (see style.css), so `.hidden` toggles
  // `display: none`. Showing/hiding the bar resizes the flex children
  // (#terminal / #reader); fire a synchronous resize so the engine
  // and reader recompute their bounds in the same task.
  function show() {
    bar.classList.remove('hidden');
    resizeTerminal();
  }

  function hide() {
    bar.classList.add('hidden');
    // terminal.js owns body.style.height tracking (renderer-agnostic
    // visualViewport handler). It will clear the inline height the
    // next time the viewport grows back; we don't touch it here so a
    // hide() while the keyboard is still up doesn't cause body to snap
    // to 100vh and re-cover the keyboard space.
    input.blur();
    resizeTerminal();
  }

  function computeKeyboardOffset(innerHeight, vvHeight, vvOffsetTop) {
    return Math.max(0, innerHeight - vvHeight - vvOffsetTop);
  }

  function resizeTerminal() {
    // Notify synchronously so layout-dependent consumers (engine resize,
    // reader re-pin) read the freshly-shrunk host height
    // in the same task — no visible jump on the next frame.
    window.dispatchEvent(new Event('resize'));
  }

  // ── Ribbon: send control chars directly to PTY ────────────────────
  ribbon.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    e.preventDefault();
    const seq = parseKey(btn.dataset.key);
    send(seq);
    // Keep focus on input so keyboard stays up
    input.focus();
  });

  // Prevent ribbon buttons from stealing focus, but allow scroll
  ribbon.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  // Don't preventDefault touchstart — it kills ribbon scrolling.
  // Instead, prevent focus steal via mousedown only.

  // ── Text input: two send modes ────────────────────────────────────
  // Keyboard Enter: send text + \r (execute in shell)
  // Green button: send text WITHOUT \r (inject into readline, still editable)
  function sendAndExecute() {
    const text = input.value;
    if (text) send(text);
    send('\r');
    input.value = '';
  }

  function sendWithoutEnter() {
    const text = input.value;
    if (text) send(text);
    input.value = '';
    input.focus();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendAndExecute();
    }
  });

  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    sendWithoutEnter();
    input.focus();
  });

  // ── Activate on touch/tap overlay ─────────────────────────────────
  // Double-tap on terminal area shows the input bar
  const overlay = document.getElementById('touchOverlay');

  function activateInput() {
    show();
    // Small delay so the bar renders before focusing (avoids layout jump)
    setTimeout(() => input.focus(), 50);
  }

  // ── Auto-hide bar when the keyboard dismisses ─────────────────────
  // Body-height tracking (i.e. shrinking the layout to match
  // visualViewport.height when the soft keyboard opens) is owned by
  // terminal.js's renderer-agnostic visualViewport handler — it must
  // work whether or not the input bar is mounted. This listener only
  // handles bar UX: when the keyboard dismisses (viewport grows back
  // by > 50px), tuck the bar away too so the user gets terminal-full
  // space back.
  let removeViewportListeners = null;
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let lastHeight = vv.height;
    const onViewportChange = () => {
      const h = vv.height;
      if (h > lastHeight + 50 && !bar.classList.contains('hidden')) {
        hide();
      }
      lastHeight = h;
    };
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
    removeViewportListeners = () => {
      vv.removeEventListener('resize', onViewportChange);
      vv.removeEventListener('scroll', onViewportChange);
    };
  }

  // Also hide on Escape
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });

  // ── Visible failure feedback ──────────────────────────────────────
  // The old `.rec-error` tint was near-invisible and the attach path gave
  // no UI feedback at all. Show a brief, clearly visible state on the
  // relevant button plus a short, accessible message in the input bar.
  const toast = document.getElementById('inputToast');
  let toastTimer = null;
  function showError(msg, btn) {
    if (toast) {
      toast.textContent = msg;
      toast.classList.remove('hidden');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
    }
    if (btn) {
      btn.classList.add('rec-error');
      setTimeout(() => btn.classList.remove('rec-error'), 1500);
    }
  }

  // ── File attach (any file type) ───────────────────────────────────
  // Shared with the desktop top bar (input-actions.js). The button just
  // triggers the action; the action owns the hidden file input + upload.
  const uploadBtn = document.getElementById('uploadBtn');
  const attach = createAttachAction({
    send,
    node,
    onError: (msg) => showError(msg, uploadBtn),
  });
  if (uploadBtn) {
    uploadBtn.addEventListener('click', (e) => { e.preventDefault(); attach.trigger(); });
    // Prevent focus steal
    uploadBtn.addEventListener('mousedown', (e) => e.preventDefault());
  }

  // ── Speech-to-text (dictation) ────────────────────────────────────
  // Shared with the desktop top bar. The action owns capture/transcribe +
  // overlay + telemetry; here we wire it to the mobile mic button and
  // re-focus the text input after a successful injection.
  const micBtn = document.getElementById('micBtn');
  const dictate = createDictateAction({
    send,
    button: micBtn,
    onText: () => input.focus(),
  });
  if (micBtn) {
    micBtn.addEventListener('mousedown', (e) => e.preventDefault());
    micBtn.addEventListener('click', (e) => {
      telemetry.log('mic.tap', {
        hasButton: true,
        isSecureContext: window.isSecureContext,
        hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
        pointerType: e.pointerType || null,
      });
      e.preventDefault();
      dictate.toggle();
    });
  } else {
    telemetry.log('mic.wire.missing');
  }

  // Settings gear — direct navigation to /settings. Phones can't always rely
  // on Back to return here (incognito back-stack is flaky), so the bar needs
  // its own way in, mirroring the desktop top bar's gear.
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('mousedown', (e) => e.preventDefault());
    settingsBtn.addEventListener('click', (e) => { e.preventDefault(); window.location.href = '/settings'; });
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    _computeKeyboardOffset: computeKeyboardOffset,
    // show() — show the bar AND focus the text input (the double-tap /
    // engagement path — see terminal.js's `onDoubleTap` handlers, #201).
    show: activateInput,
    hide,
    // Full teardown for a same-document engine remount: everything wired
    // OUTSIDE the host subtree (visualViewport listeners, the attach
    // action's hidden file input on document.body, an active dictation's
    // mic stream + full-viewport overlay) must go — the subtree listeners
    // die with the DOM, but none of those live in the subtree.
    destroy() {
      removeViewportListeners?.();
      attach.destroy?.();
      dictate.destroy?.();
      engine.setNativeInputEnabled(true);
    }
  };
}
