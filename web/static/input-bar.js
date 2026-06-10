// ── Mobile Input Bar ─────────────────────────────────────────────────
//
// Bottom bar with control-key ribbon + text input.
// Replaces direct xterm.js textarea interaction on mobile.
//
// - Ribbon buttons send control chars / escape sequences directly to PTY
// - Text input: native keyboard with autocomplete/voice. Enter sends + clears.
// - Bar appears on tap, hides when keyboard dismisses.

import telemetry from '/static/telemetry.js';
import { createMicOverlay } from '/static/mic-overlay.js';

export function createInputBar(term, send) {
  const bar = document.getElementById('inputBar');
  const ribbon = document.getElementById('inputRibbon');
  const input = document.getElementById('inputText');
  const sendBtn = document.getElementById('inputSend');
  // Complete no-op shape: callers invoke .show()/.hide(), so a partial stub
  // would throw. Mirror the real public API below.
  if (!bar || !input) return { show() {}, hide() {}, destroy() {} };

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

  // ── Shared upload helper ──────────────────────────────────────────
  // POSTs a File/Blob to /api/upload and drops the returned path into
  // the terminal via send(). Used by both the attach button and the
  // audio record button.
  async function uploadFile(file) {
    const form = new FormData();
    form.append('file', file);

    // Upload to whichever host drives the terminal: the returned path is only
    // meaningful on that host's filesystem, so it must go through the relay.
    const res = await window.MobuxMesh.apiFetch('/api/upload', { method: 'POST', body: form });
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
      showError('Attach failed: upload error', uploadBtn);
    }

    // Reset so the same file can be re-selected
    fileInput.value = '';
  });

  // ── Speech-to-text (dictation) ────────────────────────────────────
  // Capture mic audio with Web Audio (NOT MediaRecorder — we need raw PCM),
  // downsample to 16 kHz mono, encode a 16-bit WAV client-side, POST it to
  // /transcribe (same-origin, so the session cookie auth other requests use
  // rides along automatically), then inject the returned text into the
  // terminal exactly like the green send button (sendWithoutEnter path).
  const micBtn = document.getElementById('micBtn');
  const TARGET_RATE = 16000;
  const MAX_SECONDS = 60;
  const mic = {
    recording: false,
    busy: false,
    stream: null,
    ctx: null,
    source: null,
    processor: null,
    chunks: [],
    inputRate: 0,
    timer: null,
    deadline: null,
    startedAt: 0,
  };

  function micLabel(text) {
    if (micBtn) micBtn.textContent = text;
  }

  // Full-viewport overlay (recording indicator + fault state). Tapping the
  // recording overlay routes back through stopRecording (stop & send).
  const micOverlay = createMicOverlay(() => {
    if (mic.recording) stopRecording();
  });

  // Show a fault: emit telemetry AND render the overlay so logs and UI agree.
  function micFault(kind, extra) {
    telemetry.log('mic.fault', extra ? { kind, extra } : { kind });
    micBtn?.classList.remove('mic-recording');
    micLabel('🎤');
    micOverlay.showFault(kind, extra);
  }

  // Merge captured Float32 chunks, downsample to 16 kHz, and PCM-encode a WAV.
  function encodeWav(chunks, inputRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }

    // Linear-interpolation downsample to 16 kHz (input is typically 44.1/48k).
    let samples = merged;
    if (inputRate !== TARGET_RATE) {
      const ratio = inputRate / TARGET_RATE;
      const outLen = Math.floor(merged.length / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, merged.length - 1);
        const frac = pos - i0;
        out[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
      }
      samples = out;
    }

    // 16-bit PCM WAV: 44-byte header + interleaved (mono) samples.
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    const dataLen = samples.length * 2;
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);        // PCM chunk size
    view.setUint16(20, 1, true);         // PCM format
    view.setUint16(22, 1, true);         // mono
    view.setUint32(24, TARGET_RATE, true);
    view.setUint32(28, TARGET_RATE * 2, true); // byte rate
    view.setUint16(32, 2, true);         // block align
    view.setUint16(34, 16, true);        // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataLen, true);
    let p = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function stopTracks() {
    if (mic.processor) { try { mic.processor.disconnect(); } catch (_) {} mic.processor.onaudioprocess = null; }
    if (mic.source) { try { mic.source.disconnect(); } catch (_) {} }
    if (mic.ctx) { try { mic.ctx.close(); } catch (_) {} }
    if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
    if (mic.timer) { clearInterval(mic.timer); mic.timer = null; }
    mic.processor = mic.source = mic.ctx = mic.stream = null;
  }

  async function startRecording() {
    if (mic.busy) return;
    // Secure-context / mediaDevices availability. getUserMedia is undefined on
    // http: (non-localhost) and in unsupported webviews.
    const secure = window.isSecureContext !== false;
    const hasGUM = !!navigator.mediaDevices?.getUserMedia;
    telemetry.log('mic.secure.check', { secure, hasGetUserMedia: hasGUM });
    if (!hasGUM) {
      micFault('insecure');
      return;
    }
    telemetry.log('mic.getusermedia.req');
    try {
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err?.name || 'Error';
      telemetry.log('mic.getusermedia.denied', { name, message: err?.message || '' });
      // Map the DOMException to a fault kind.
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        micFault('notfound', name);
      } else if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        micFault('denied', name);
      } else {
        micFault('mic', name + ': ' + (err?.message || ''));
      }
      return;
    }
    telemetry.log('mic.getusermedia.ok');
    const AC = window.AudioContext || window.webkitAudioContext;
    mic.ctx = new AC();
    mic.inputRate = mic.ctx.sampleRate;
    mic.source = mic.ctx.createMediaStreamSource(mic.stream);
    mic.processor = mic.ctx.createScriptProcessor(4096, 1, 1);
    mic.chunks = [];
    mic.processor.onaudioprocess = (e) => {
      mic.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    mic.source.connect(mic.processor);
    mic.processor.connect(mic.ctx.destination);

    mic.recording = true;
    mic.startedAt = Date.now();
    micBtn?.classList.add('mic-recording');
    micOverlay.showRecording();
    telemetry.log('mic.recording.start', { inputRate: mic.inputRate });
    mic.deadline = Date.now() + MAX_SECONDS * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((mic.deadline - Date.now()) / 1000));
      micLabel('⏺' + left);
      if (left <= 0) stopRecording();
    };
    tick();
    mic.timer = setInterval(tick, 250);
  }

  async function stopRecording() {
    if (!mic.recording) return;
    mic.recording = false;
    mic.busy = true;
    micBtn?.classList.remove('mic-recording');
    micLabel('…');

    const chunks = mic.chunks;
    const inputRate = mic.inputRate;
    const durationMs = mic.startedAt ? Date.now() - mic.startedAt : 0;
    stopTracks();
    mic.chunks = [];
    telemetry.log('mic.recording.stop', { durationMs, chunkCount: chunks.length });

    try {
      const wav = encodeWav(chunks, inputRate);
      const form = new FormData();
      form.append('audio', wav, 'speech.wav');
      telemetry.log('mic.transcribe.req', { bytes: wav.size, durationMs });

      let res;
      try {
        res = await fetch('/transcribe', { method: 'POST', body: form });
      } catch (netErr) {
        telemetry.log('mic.transcribe.err', { stage: 'network', message: netErr?.message || '' });
        micFault('network', netErr?.message || 'network error');
        return;
      }
      telemetry.log('mic.transcribe.resp', { status: res.status });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        telemetry.log('mic.transcribe.err', { stage: 'http', status: res.status, body: bodyText.slice(0, 200) });
        // 503 = STT model not loaded on this host; everything else is generic.
        if (res.status === 503) {
          micFault('model', '503 ' + bodyText.slice(0, 120));
        } else {
          micFault('http', res.status + ' ' + (bodyText.slice(0, 120) || res.statusText));
        }
        return;
      }

      const { text } = await res.json();
      if (text && text.trim()) {
        telemetry.log('mic.transcribe.ok', { textLength: text.trim().length });
        micOverlay.dismiss();
        // Inject without Enter, same path as the green send button.
        send(text.trim());
        input.focus();
        micLabel('🎤');
      } else {
        telemetry.log('mic.transcribe.empty');
        micOverlay.dismiss();
        // Empty transcription: brief neutral state, no injection.
        micLabel('∅');
        setTimeout(() => micLabel('🎤'), 1200);
      }
    } catch (err) {
      console.error('Transcription failed:', err);
      telemetry.log('mic.transcribe.err', { stage: 'exception', message: err?.message || String(err) });
      micFault('mic', err?.message || 'encode/transcribe error');
    } finally {
      mic.busy = false;
    }
  }

  if (micBtn) {
    micBtn.addEventListener('mousedown', (e) => e.preventDefault());
    micBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const starting = !mic.recording;
      telemetry.log('mic.click', { action: starting ? 'start' : 'stop' });
      if (mic.recording) stopRecording();
      else startRecording();
    });
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
