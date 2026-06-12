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
//   createDictateAction({ send, button, onText }) → { toggle(), isRecording() }
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
    processor: null,
    chunks: [],
    inputRate: 0,
    timer: null,
    deadline: null,
    startedAt: 0,
  };

  function micLabel(text) {
    if (button) button.textContent = text;
  }

  // Full-viewport overlay (recording indicator + fault state). Tapping the
  // recording overlay routes back through stopRecording (stop & send).
  const micOverlay = createMicOverlay(() => {
    if (mic.recording) stopRecording();
  });

  // Show a fault: emit telemetry AND render the overlay so logs and UI agree.
  function micFault(kind, extra) {
    telemetry.log('mic.fault', extra ? { kind, extra } : { kind });
    button?.classList.remove('mic-recording');
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
    button?.classList.add('mic-recording');
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
    button?.classList.remove('mic-recording');
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
        onText?.();
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

  return {
    toggle() {
      const starting = !mic.recording;
      telemetry.log('mic.click', { action: starting ? 'start' : 'stop' });
      if (mic.recording) stopRecording();
      else startRecording();
    },
    isRecording() { return mic.recording; },
  };
}
