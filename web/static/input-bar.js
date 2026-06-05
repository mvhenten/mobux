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
  // The bar is now a flex item (see style.css), so `.hidden` toggles
  // `display: none`. Showing/hiding the bar resizes the flex children
  // (#terminal / #reader); fire a synchronous resize so terminal-core
  // and reader-view recompute their bounds in the same task.
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
  }

  // Also hide on Escape
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });

  // ── Shared upload helper ──────────────────────────────────────────
  // POSTs a File/Blob to /api/upload and drops the returned path into
  // the terminal via send(). Used by both the attach button and the
  // audio record button.
  async function uploadFile(file) {
    const form = new FormData();
    form.append('file', file);

    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    const { path } = await res.json();

    // Send path directly to terminal, ready to use
    send(path);
  }

  // ── File attach (any file type) ───────────────────────────────────
  const uploadBtn = document.getElementById('uploadBtn');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '*/*';
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

    try {
      await uploadFile(file);
    } catch (err) {
      console.error('Upload failed:', err);
    }

    // Reset so the same file can be re-selected
    fileInput.value = '';
  });

  // ── Audio record (MediaRecorder → /api/upload) ────────────────────
  const recBtn = document.getElementById('recBtn');
  let mediaRecorder = null;
  let chunks = [];
  let recStream = null;

  function recCleanup() {
    if (recStream) {
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
    }
    mediaRecorder = null;
    if (recBtn) recBtn.classList.remove('recording');
  }

  function recFlashError() {
    if (!recBtn) return;
    recBtn.classList.add('rec-error');
    setTimeout(() => recBtn.classList.remove('rec-error'), 1500);
  }

  function extForMime(mime) {
    if (!mime) return 'webm';
    if (mime.includes('mp4')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('webm')) return 'webm';
    return 'webm';
  }

  function pickMimeType() {
    const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const t of prefs) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return ''; // let the browser pick a default
  }

  async function startRecording() {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('Microphone access failed:', err);
      recCleanup();
      recFlashError();
      return;
    }

    chunks = [];
    const mimeType = pickMimeType();
    try {
      mediaRecorder = mimeType
        ? new MediaRecorder(recStream, { mimeType })
        : new MediaRecorder(recStream);
    } catch (err) {
      console.error('MediaRecorder init failed:', err);
      recCleanup();
      recFlashError();
      return;
    }

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });

    mediaRecorder.addEventListener('stop', async () => {
      const type = mediaRecorder?.mimeType || 'audio/webm';
      const ext = extForMime(type);
      const blob = new Blob(chunks, { type });
      chunks = [];
      // Release the mic before the upload round-trip.
      recCleanup();

      if (blob.size === 0) return;
      const file = new File([blob], 'recording-' + Date.now() + '.' + ext, { type });
      try {
        await uploadFile(file);
      } catch (err) {
        console.error('Upload failed:', err);
        recFlashError();
      }
    });

    mediaRecorder.start();
    if (recBtn) recBtn.classList.add('recording');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop(); // triggers onstop → upload + cleanup
    } else {
      recCleanup();
    }
  }

  if (recBtn) {
    const recSupported =
      !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
    if (!recSupported) {
      recBtn.style.display = 'none';
    } else {
      recBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          stopRecording();
        } else {
          startRecording();
        }
      });
      // Prevent focus steal
      recBtn.addEventListener('mousedown', (e) => e.preventDefault());
    }
  }

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
