// ── Mobile Input Bar ─────────────────────────────────────────────────
//
// Bottom bar with control-key ribbon + text input.
// Replaces direct xterm.js textarea interaction on mobile.
//
// - Ribbon buttons send control chars / escape sequences directly to PTY
// - Text input: native keyboard with autocomplete/voice. Enter sends + clears.
// - Bar appears on tap, hides when keyboard dismisses.

export function createInputBar(term, send) {
  const bar = document.getElementById('inputBar');
  const ribbon = document.getElementById('inputRibbon');
  const input = document.getElementById('inputText');
  const sendBtn = document.getElementById('inputSend');
  if (!bar || !input) return { destroy() {} };

  // ── Disable xterm.js textarea on mobile ───────────────────────────
  // We own input now. Prevent xterm's textarea from stealing focus.
  const textarea = term.textarea;
  if (textarea) {
    textarea.setAttribute('tabindex', '-1');
    textarea.style.pointerEvents = 'none';
    textarea.style.opacity = '0';
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
  }

  // ── Parse escape sequences from data-key attributes ───────────────
  function parseKey(raw) {
    return raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
              .replace(/\\t/g, '\t')
              .replace(/\\n/g, '\n')
              .replace(/\\r/g, '\r');
  }

  // ── Show/hide bar ─────────────────────────────────────────────────
  function show() {
    bar.classList.remove('hidden');
    resizeTerminal();
  }

  function hide() {
    bar.style.transform = '';
    bar.classList.add('hidden');
    document.body.style.height = '';
    input.blur();
    resizeTerminal();
  }

  function computeKeyboardOffset(innerHeight, vvHeight, vvOffsetTop) {
    return Math.max(0, innerHeight - vvHeight - vvOffsetTop);
  }

  function resizeTerminal() {
    // Give the CSS transition a frame to settle
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
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

  // ── Track on-screen keyboard via visualViewport ───────────────────
  // Translate the bar up by the keyboard height so it sits above the
  // software keyboard (Android Chrome doesn't shrink the layout vp).
  // Also shrink the layout container (.term-body) to match the visual
  // viewport so #reader / #terminal don't render content underneath
  // the lifted bar.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let lastHeight = vv.height;
    let lastOffset = 0;

    const applyOffset = () => {
      const offset = computeKeyboardOffset(window.innerHeight, vv.height, vv.offsetTop);
      if (bar.classList.contains('hidden')) {
        document.body.style.height = '';
        lastOffset = 0;
        return offset;
      }
      bar.style.transform = offset > 0 ? `translateY(${-offset}px)` : '';
      // Shrink .term-body (the body itself) so flex children pick up
      // the new viewport height. .term-body has explicit `height:
      // 100vh`, which overrides `bottom:0` — so we override `height`
      // directly when the keyboard is up. Reader's ResizeObserver and
      // the dispatched window 'resize' below take care of relayout.
      document.body.style.height = offset > 0 ? `${vv.height}px` : '';
      if (offset !== lastOffset) {
        lastOffset = offset;
        resizeTerminal();
      }
      return offset;
    };

    const onViewportChange = () => {
      applyOffset();
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

  // ── Image upload ───────────────────────────────────────────────
  const uploadBtn = document.getElementById('uploadBtn');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  if (uploadBtn) {
    uploadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });
    // Prevent focus steal
    uploadBtn.addEventListener('mousedown', (e) => e.preventDefault());
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const form = new FormData();
    form.append('file', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const { path } = await res.json();

      // Send path directly to terminal, ready to use
      send(path);
    } catch (err) {
      console.error('Upload failed:', err);
    }

    // Reset so the same file can be re-selected
    fileInput.value = '';
  });

  // ── Public API ────────────────────────────────────────────────────
  return {
    _computeKeyboardOffset: computeKeyboardOffset,
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
