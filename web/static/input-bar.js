// ── Mobile Input Bar ─────────────────────────────────────────────────
//
// Bottom bar with control-key ribbon + text input.
// Replaces direct xterm.js textarea interaction on mobile.
//
// - Ribbon buttons send control chars / escape sequences directly to PTY
// - Text input: native keyboard with autocomplete/voice. Enter sends + clears.
// - Bar appears on tap, hides when keyboard dismisses.

import { createAttachAction, createDictateAction } from './input-actions.js';
import { getInputMode, setInputMode } from './input-mode.js';
import telemetry from './telemetry.js';

export function createInputBar(term, send) {
  const bar = document.getElementById('inputBar');
  const ribbon = document.getElementById('inputRibbon');
  const input = document.getElementById('inputText');
  const sendBtn = document.getElementById('inputSend');
  const streamModeBtn = document.getElementById('streamModeBtn');
  const ribbonToggleBtn = document.getElementById('ribbonToggleBtn');
  // Complete no-op shape: callers invoke .show()/.hide(), so a partial stub
  // would throw. Mirror the real public API below.
  if (!bar || !input) return { show() {}, hide() {}, destroy() {} };

  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');

  let mode = getInputMode();
  let streamPrev = '';
  let composing = false;

  function getComposerText() {
    return input.value.replace(/\r?\n/g, '');
  }

  function setComposerText(text) {
    input.value = text.replace(/\r?\n/g, '');
  }

  function insertComposerText(text) {
    if (!text) return;
    const flat = text.replace(/[\r\n]+/g, '');
    const start = input.selectionStart ?? getComposerText().length;
    const end = input.selectionEnd ?? start;
    const val = getComposerText();
    input.value = val.slice(0, start) + flat + val.slice(end);
    const caret = start + flat.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── Disable xterm.js textarea on mobile ───────────────────────────
  // We own input now. Keep the renderer textarea inert so Chrome Android does
  // not treat it as a second autofill target above Gboard.
  const textarea = term.textarea;
  if (textarea) {
    textarea.setAttribute('tabindex', '-1');
    textarea.setAttribute('readonly', 'true');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.pointerEvents = 'none';
    textarea.style.opacity = '0';
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
  }

  function focusComposer() {
    if (textarea && document.activeElement === textarea) textarea.blur();
    input.focus();
  }

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
  // (#terminal / #reader); fire a synchronous resize so terminal-core
  // and reader-view recompute their bounds in the same task.
  function show() {
    bar.classList.remove('hidden');
    updateCompact();
    resizeTerminal();
  }

  function hide() {
    bar.classList.add('hidden');
    bar.classList.remove('compact', 'compact-expanded');
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
    // Notify synchronously so layout-dependent consumers (terminal-core
    // resize, reader-view re-pin) read the freshly-shrunk host height
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
    focusComposer();
  });

  // Prevent ribbon buttons from stealing focus, but allow scroll
  ribbon.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  // Don't preventDefault touchstart — it kills ribbon scrolling.
  // Instead, prevent focus steal via mousedown only.

  // ── Text input: buffered vs stream ────────────────────────────────
  // Buffered (default upstream): hold text locally; Enter sends the line.
  // Stream: each keystroke goes to the PTY so TUIs (/menus, tab complete) work.
  function sendAndExecute() {
    const text = getComposerText();
    if (text) send(text);
    send('\r');
    setComposerText('');
    streamPrev = '';
  }

  function sendWithoutEnter() {
    const text = getComposerText();
    if (text) send(text);
    setComposerText('');
    streamPrev = '';
    focusComposer();
  }

  function flushStreamDiff() {
    const val = getComposerText();
    if (val.length > streamPrev.length) {
      send(val.slice(streamPrev.length));
    } else if (val.length < streamPrev.length) {
      for (let i = 0; i < streamPrev.length - val.length; i++) send('\x7f');
    }
    streamPrev = val;
  }

  function applyInputModeUi() {
    const streaming = mode === 'stream';
    if (streamModeBtn) {
      streamModeBtn.classList.toggle('stream-active', streaming);
      streamModeBtn.title = streaming
        ? 'Live typing on — tap to buffer locally'
        : 'Live typing off — tap to stream keys to terminal';
      streamModeBtn.setAttribute('aria-pressed', streaming ? 'true' : 'false');
    }
    input.dataset.placeholder = streaming ? 'Live typing…' : 'Type here…';
    input.placeholder = input.dataset.placeholder;
    input.enterKeyHint = streaming ? 'enter' : 'send';
    if (sendBtn) sendBtn.classList.toggle('hidden', streaming);
  }

  function setMode(next) {
    if (next === mode) return;
    if (next === 'stream') {
      const text = getComposerText();
      if (text) {
        send(text);
        streamPrev = text;
      } else {
        streamPrev = '';
      }
    } else {
      setComposerText('');
      streamPrev = '';
    }
    mode = next;
    setInputMode(mode);
    applyInputModeUi();
  }

  function toggleStreamMode() {
    setMode(mode === 'stream' ? 'buffered' : 'stream');
    focusComposer();
  }

  applyInputModeUi();

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (mode === 'stream') flushStreamDiff();
  });

  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    insertComposerText(text);
  });

  input.addEventListener('input', () => {
    if (mode !== 'stream' || composing) return;
    flushStreamDiff();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'stream') {
        send('\r');
        setComposerText('');
        streamPrev = '';
      } else {
        sendAndExecute();
      }
    }
  });

  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendWithoutEnter();
      focusComposer();
    });
  }

  if (streamModeBtn) {
    streamModeBtn.addEventListener('mousedown', (e) => e.preventDefault());
    streamModeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleStreamMode();
    });
  }

  // ── Compact keyboard: hide ribbon + overlay slim input ────────────
  // The ribbon + text row consume ~90px above the OS keyboard. On mobile
  // keep the ribbon collapsed by default (tap ⌃ to expand) and overlay the
  // slim input row so the PTY keeps as many rows as possible.
  const isMobileInput =
    window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 620;
  const COMPACT_KEYBOARD_KEY = 'mobux.input.compactKeyboard';
  let layoutFullHeight = Math.max(window.innerHeight, window.visualViewport?.height ?? 0);

  function compactKeyboardEnabled() {
    try {
      return localStorage.getItem(COMPACT_KEYBOARD_KEY) !== '0';
    } catch (_) {
      return true;
    }
  }

  function noteLayoutFullHeight() {
    if (!document.activeElement || document.activeElement !== input) {
      layoutFullHeight = Math.max(
        layoutFullHeight,
        window.innerHeight,
        window.visualViewport?.height ?? 0,
      );
    }
  }

  function keyboardLikelyUp() {
    if (document.activeElement === input) return true;
    // resizes-content (Android): innerHeight shrinks with the keyboard, so
    // vv.height ≈ innerHeight and a vv-vs-inner diff never fires.
    const h = Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
    return h < layoutFullHeight - 80;
  }

  function updateRibbonToggle() {
    if (!ribbonToggleBtn) return;
    const compact = bar.classList.contains('compact');
    const expanded = bar.classList.contains('compact-expanded');
    ribbonToggleBtn.classList.toggle('hidden', !compact);
    ribbonToggleBtn.title = expanded ? 'Hide control keys' : 'Show control keys';
    ribbonToggleBtn.textContent = expanded ? '⌄' : '⌃';
    ribbonToggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function updateCompact() {
    if (!compactKeyboardEnabled() || bar.classList.contains('hidden')) {
      bar.classList.remove('compact', 'compact-expanded');
      updateRibbonToggle();
      return;
    }
    if (!isMobileInput) {
      bar.classList.remove('compact', 'compact-expanded');
      updateRibbonToggle();
      return;
    }
    const shouldCompact =
      document.activeElement === input || keyboardLikelyUp();
    bar.classList.toggle('compact', shouldCompact);
    if (!shouldCompact) bar.classList.remove('compact-expanded');
    if (!shouldCompact) noteLayoutFullHeight();
    updateRibbonToggle();
    resizeTerminal();
  }

  input.addEventListener('focus', () => {
    requestAnimationFrame(updateCompact);
  });
  input.addEventListener('blur', () => setTimeout(updateCompact, 120));

  if (window.visualViewport) {
    const vv = window.visualViewport;
    vv.addEventListener('resize', updateCompact);
    vv.addEventListener('scroll', updateCompact);
  }
  window.addEventListener('resize', noteLayoutFullHeight);

  if (ribbonToggleBtn) {
    ribbonToggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    ribbonToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      bar.classList.toggle('compact-expanded');
      updateRibbonToggle();
      resizeTerminal();
      focusComposer();
    });
  }

  updateCompact();

  // ── Activate on touch/tap overlay ─────────────────────────────────
  // Double-tap on terminal area shows the input bar
  const overlay = document.getElementById('touchOverlay');

  function activateInput() {
    show();
    // Small delay so the bar renders before focusing (avoids layout jump)
    setTimeout(() => {
      focusComposer();
      updateCompact();
    }, 50);
  }

  // ── Auto-hide bar when the keyboard dismisses ─────────────────────
  // Body-height tracking (i.e. shrinking the layout to match
  // visualViewport.height when the soft keyboard opens) is owned by
  // terminal.js's renderer-agnostic visualViewport handler — it must
  // work whether or not the input bar is mounted. This listener only
  // handles bar UX: when the keyboard dismisses (viewport grows back
  // by > 50px), tuck the bar away too so the user gets terminal-full
  // space back.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let lastHeight = vv.height;
    const onViewportChange = () => {
      updateCompact();
      const h = vv.height;
      if (h > lastHeight + 50 && !bar.classList.contains('hidden')) {
        hide();
      }
      lastHeight = h;
    };
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
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
    onText: () => focusComposer(),
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
    getInputMode: () => mode,
    setInputMode: setMode,
    _computeKeyboardOffset: computeKeyboardOffset,
    // reveal() — show the bar without focusing the text input.  Used for
    // the eager mobile mount so #micBtn is visible from the start without
    // popping the soft keyboard.
    reveal: show,
    // show() — show the bar AND focus the text input (the double-tap path).
    show: activateInput,
    hide,
    destroy() {
      if (textarea) {
        textarea.removeAttribute('tabindex');
        textarea.style.pointerEvents = '';
      }
    }
  };
}
