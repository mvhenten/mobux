// input-actions.js — shared 📎 attach and 🎤 dictate actions.
//
// These two actions are the "unreachable on a non-touch browser" features:
// xterm.js owns the keyboard on desktop, so there are no shortcuts for them.
// Both the mobile input bar (input-bar.js) and the desktop top bar
// (top-bar.js) drive the SAME flows from here — one upload path, one mic
// capture/transcribe path, one set of `mic.*` telemetry events.
//
// Each factory returns a small handle with a trigger and (for dictation) the
// recording state. Callers own their own button DOM and pass it in so the
// action can reflect state (label / `.mic-recording`) on whichever button is
// visible; UI-only details (focus restore, error toasts) are injected via
// callbacks so behavior stays identical per surface.

import telemetry from '/static/telemetry.js';
import { createMicOverlay } from '/static/mic-overlay.js';

// ── File attach (any file type) ─────────────────────────────────────
// Owns a hidden <input type=file>, POSTs the picked file to /api/upload via
// the mesh relay (the returned path is only valid on the terminal's host),
// and drops the path into the terminal via send().
//
//   createAttachAction({ send, onError }) → { trigger() }
//     onError(message)  optional — surface an upload failure in the UI.
export function createAttachAction({ send, onError } = {}) {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '*/*';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  async function uploadFile(file) {
    const form = new FormData();
    form.append('file', file);
    // Upload to whichever host drives the terminal: the returned path is only
    // meaningful on that host's filesystem, so it must go through the relay.
    const res = await window.MobuxMesh.apiFetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    const { path } = await res.json();
    // Send path directly to terminal, ready to use.
    send(path);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await uploadFile(file);
    } catch (err) {
      console.error('Upload failed:', err);
      onError?.('Attach failed: upload error');
    }
    // Reset so the same file can be re-selected.
    fileInput.value = '';
  });

  return {
    trigger() { fileInput.click(); },
  };
}

// ── Speech-to-text (dictation) ──────────────────────────────────────
// Capture mic audio with Web Audio (NOT MediaRecorder — we need raw PCM),
// downsample to 16 kHz mono, encode a 16-bit WAV client-side, POST it to
// /transcribe (same-origin, so the session cookie rides along), then inject
// the returned text into the terminal exactly like the green send button.
//
//   createDictateAction({ send, button, onText }) → { trigger(), isRecording() }
//     button   the 🎤 button element — gets `.mic-recording` + label updates.
//     onText() optional — invoked after a successful injection (e.g. refocus
//              the mobile text input). The injection itself always happens.
const TARGET_RATE = 16000;
const MAX_SECONDS = 60;

export function createDictateAction({ send, button, onText } = {}) {
  const mic = {
    recording: false,
    busy: false,
    stream: null,
    ctx: null,
    source: null,
    analyser: null,
    processor: null,
    chunks: [],
    inputRate: 0,
    timer: null,
    deadline: null,
    startedAt: 0,
    paused: false,
    pendingChunks: null,
    pendingRate: 0,
    pendingDurationMs: 0,
  };

  function micLabel(text) {
    if (button) button.textContent = text;
  }

  // Full-viewport overlay with five states.
  const micOverlay = createMicOverlay({
    onStop: () => { if (mic.recording) captureStop(); },
    onPause: () => {
      mic.paused = true;
      telemetry.log('mic.pause');
    },
    onResume: () => {
      mic.paused = false;
      telemetry.log('mic.resume');
    },
    onCancel: () => { cancelRecording(); },
    onDismiss: () => {
      // Overlay already removed itself; just reset mic state so the next tap works.
      mic.recording = false;
      mic.busy = false;
      mic.paused = false;
      mic.pendingChunks = null;
      stopTracks();
      button?.classList.remove('mic-recording');
      micLabel('🎤');
    },
    onRetry: () => { retryFresh(); },
    onSubmit: (text) => { submitText(text); },
    retryTranscription: async () => {
      if (!mic.pendingChunks || !mic.pendingChunks.length) return;
      const chunks = mic.pendingChunks;
      const inputRate = mic.pendingRate;
      const durationMs = mic.pendingDurationMs;
      mic.pendingChunks = null;
      try {
        const wav = encodeWav(chunks, inputRate);
        const form = new FormData();
        form.append('audio', wav, 'speech.wav');
        micLabel('…');
        micOverlay.showTranscribing();
        const res = await fetch('/transcribe', { method: 'POST', body: form });
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          if (res.status === 503) { micFault('model', '503 ' + bodyText.slice(0, 120)); }
          else { micFault('http', res.status + ' ' + (bodyText.slice(0, 120) || res.statusText)); }
          return;
        }
        const { text } = await res.json();
        micOverlay.showReview(text && text.trim() ? text : '');
      } catch (err) {
        micFault('mic', err?.message || 'retry error');
      } finally {
        mic.busy = false;
      }
    },
  });

  // Show a fault: emit telemetry AND render the overlay so logs and UI agree.
  function micFault(kind, extra) {
    telemetry.log('mic.fault', extra ? { kind, extra } : { kind });
    button?.classList.remove('mic-recording');
    mic.recording = false;
    mic.busy = false;
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
    if (mic.analyser) { try { mic.analyser.disconnect(); } catch (_) {} mic.analyser = null; }
    if (mic.source) { try { mic.source.disconnect(); } catch (_) {} }
    if (mic.ctx) { try { mic.ctx.close(); } catch (_) {} }
    if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
    if (mic.timer) { clearInterval(mic.timer); mic.timer = null; }
    mic.processor = mic.source = mic.ctx = mic.stream = null;
  }

  async function startRecording() {
    if (mic.busy) return;
    mic.paused = false;
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

    // Insert AnalyserNode between source and processor so waveform taps the
    // graph without affecting the PCM capture.
    mic.analyser = mic.ctx.createAnalyser();
    mic.analyser.fftSize = 1024;
    mic.source.connect(mic.analyser);

    mic.processor = mic.ctx.createScriptProcessor(4096, 1, 1);
    mic.analyser.connect(mic.processor);
    mic.processor.connect(mic.ctx.destination);

    mic.chunks = [];
    mic.processor.onaudioprocess = (e) => {
      if (!mic.paused) {
        mic.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
    };

    mic.recording = true;
    mic.busy = true;
    mic.startedAt = Date.now();
    button?.classList.add('mic-recording');
    micOverlay.showRecording(mic.analyser);
    telemetry.log('mic.recording.start', { inputRate: mic.inputRate });
    mic.deadline = Date.now() + MAX_SECONDS * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((mic.deadline - Date.now()) / 1000));
      micLabel('⏺' + left);
      if (left <= 0) captureStop();
    };
    tick();
    mic.timer = setInterval(tick, 250);
  }

  async function captureStop() {
    if (!mic.recording) return;
    mic.recording = false;
    button?.classList.remove('mic-recording');
    micLabel('…');
    telemetry.log('mic.stop');

    const chunks = mic.chunks;
    const inputRate = mic.inputRate;
    const durationMs = mic.startedAt ? Date.now() - mic.startedAt : 0;
    mic.pendingChunks = chunks;
    mic.pendingRate = inputRate;
    mic.pendingDurationMs = durationMs;
    stopTracks();
    mic.chunks = [];
    telemetry.log('mic.recording.stop', { durationMs, chunkCount: chunks.length });

    micOverlay.showTranscribing();

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
        if (res.status === 503) {
          micFault('model', '503 ' + bodyText.slice(0, 120));
        } else {
          micFault('http', res.status + ' ' + (bodyText.slice(0, 120) || res.statusText));
        }
        return;
      }

      const { text } = await res.json();
      telemetry.log('mic.transcribe.ok', { textLength: (text || '').trim().length });
      micOverlay.showReview(text && text.trim() ? text : '');
    } catch (err) {
      console.error('Transcription failed:', err);
      telemetry.log('mic.transcribe.err', { stage: 'exception', message: err?.message || String(err) });
      micFault('mic', err?.message || 'encode/transcribe error');
    }
    // Note: mic.busy stays true until submit/cancel/retry resolves
  }

  function cancelRecording() {
    mic.recording = false;
    mic.busy = false;
    mic.paused = false;
    stopTracks();
    mic.chunks = [];
    mic.pendingChunks = null;
    button?.classList.remove('mic-recording');
    micLabel('🎤');
    micOverlay.dismiss();
  }

  async function retryFresh() {
    telemetry.log('mic.retry');
    stopTracks();
    mic.chunks = [];
    mic.pendingChunks = null;
    mic.recording = false;
    mic.busy = false;
    mic.paused = false;
    micOverlay.dismiss();
    await startRecording();
  }

  function submitText(text) {
    telemetry.log('mic.submit');
    send(text.trim());
    send('\r');
    onText?.();
    mic.busy = false;
    micLabel('🎤');
  }

  return {
    trigger() {
      if (mic.busy) return;
      telemetry.log('mic.click', { action: 'start' });
      startRecording();
    },
    // Legacy compat
    toggle() {
      if (mic.busy) return;
      telemetry.log('mic.click', { action: mic.recording ? 'stop' : 'start' });
      if (mic.recording) captureStop();
      else startRecording();
    },
    isRecording() { return mic.recording; },
  };
}
