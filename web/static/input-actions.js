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

import telemetry from './telemetry.js';
import { createMicOverlay, faultMessage } from './mic-overlay.js';
import { openExternal } from './external-link.js';

// ── File attach (any file type) ─────────────────────────────────────
// Owns a hidden <input type=file>, POSTs the picked file to /api/upload, and
// drops the returned path into the terminal via send().
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
    const res = await fetch('/api/upload', { method: 'POST', body: form });
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
    onFastSubmit: () => { if (mic.recording) captureStopAndSubmit(); },
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
    // REVIEW state: user wants a different take — discard and record again.
    onRetry: () => { retryFresh(); },
    // FAULT state: reuse the captured audio if the failure happened after
    // recording; only fall back to a fresh recording when there is nothing
    // to resend (e.g. permission/secure-context faults raised before capture).
    onFaultRetry: () => {
      // pendingChunks is an array (possibly empty, if Stop landed before any
      // audio buffer had fired) whenever a stop-capture already happened —
      // only null once discarded/consumed. Check presence, not chunk count.
      if (mic.pendingChunks !== null) retryPendingTranscription();
      else retryFresh();
    },
    onSubmit: (text) => { submitText(text); },
    retryTranscription: () => { retryPendingTranscription(); },
    openExternal,
  });

  // Show a fault: emit telemetry AND render the overlay so logs and UI agree.
  // Never a no-op: if the overlay itself is missing or fails to render, fall
  // back to a native alert so the failure is still loud, never silent.
  function micFault(kind, extra, opts) {
    telemetry.log('mic.fault', extra ? { kind, extra } : { kind });
    button?.classList.remove('mic-recording');
    mic.recording = false;
    mic.busy = false;
    micLabel('🎤');
    try {
      if (!micOverlay || typeof micOverlay.showFault !== 'function') {
        throw new Error('mic overlay unavailable');
      }
      micOverlay.showFault(kind, extra, opts);
    } catch (err) {
      telemetry.log('mic.fault.overlay.err', { message: err?.message || String(err) });
      window.alert(faultMessage(kind, extra).title);
    }
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

  // Probe /transcribe's backend before opening the mic, so a dead network STT
  // provider is surfaced immediately instead of after the user has already
  // talked into a recording that was never going to transcribe. Reuses the
  // same /api/stt/status endpoint the Settings → Speech-to-text card polls.
  // Bounded by PROBE_TIMEOUT_MS so a hung request can't leave the tap looking
  // dead — a timeout is treated the same as any other probe failure (proceed
  // to getUserMedia; the real /transcribe call surfaces its own fault).
  const PROBE_TIMEOUT_MS = 6000;

  // getUserMedia can hang forever — never resolve, never reject — in a
  // TWA/WebView missing the Android RECORD_AUDIO permission, which leaves
  // attemptStartRecording's try/catch with nothing to catch and the mic tap
  // looking dead. Race it against a timeout so a hang always surfaces a
  // fault. If the real promise settles after the timeout already fired,
  // any stream it hands back is stopped immediately so it doesn't leak.
  const GETUSERMEDIA_TIMEOUT_MS = 8000;

  // /transcribe forwards to the STT backend, which can hang indefinitely if
  // the backend is broken (e.g. it accepts the connection but never answers
  // POST /v1/audio/transcriptions — /health can look fine while this is
  // stuck). CPU transcription of a short clip normally takes a few seconds;
  // this is generous headroom, not a normal-case budget. AbortController
  // actually cancels the in-flight request instead of just abandoning it.
  const TRANSCRIBE_TIMEOUT_MS = 30000;

  function getUserMediaWithTimeout(constraints) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error('getUserMedia timed out'), { name: 'TimeoutError' }));
      }, GETUSERMEDIA_TIMEOUT_MS);

      navigator.mediaDevices.getUserMedia(constraints).then(
        (stream) => {
          clearTimeout(timer);
          if (settled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          settled = true;
          resolve(stream);
        },
        (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
    });
  }

  async function probeSttBackend() {
    let status = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch('/api/stt/status', { signal: controller.signal });
        status = await res.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Probe itself failed or timed out (e.g. offline) — don't block
      // recording on that; the real /transcribe call will surface its own
      // fault if needed.
      telemetry.log('mic.probe.err', { message: err?.message || 'network error' });
      return true;
    }
    telemetry.log('mic.probe', { kind: status?.kind, reachable: !!status?.reachable });
    if (status?.reachable) return true;
    micFault('model', (status?.kind || 'unknown') + ' backend unreachable', {
      onProceedAnyway: () => { startRecording({ skipProbe: true }); },
    });
    return false;
  }

  // Every branch of the mic-open pipeline (secure-context check, backend
  // probe, getUserMedia, AudioContext wiring) is expected to either start
  // recording or call micFault — never fall through silently. This wrapper
  // is the last line of defense: any unexpected throw still resets mic state
  // and renders a loud, reportable fault instead of leaving a dead button.
  async function startRecording(opts) {
    if (mic.busy) return;
    // Claim busy immediately so a second tap during the probe/getUserMedia
    // await can't race into a second concurrent recording attempt.
    mic.busy = true;
    try {
      await attemptStartRecording(opts);
    } catch (err) {
      telemetry.log('mic.start.err', { message: err?.message || String(err) });
      stopTracks();
      micFault('mic', err?.message || 'unexpected recording error');
    }
  }

  async function attemptStartRecording(opts) {
    // Dismiss the soft keyboard — the text input keeps focus otherwise and the
    // on-screen keyboard covers the recording overlay on mobile.
    document.activeElement?.blur?.();
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
    if (!opts?.skipProbe && !(await probeSttBackend())) return;
    telemetry.log('mic.getusermedia.req');
    try {
      mic.stream = await getUserMediaWithTimeout({ audio: true });
    } catch (err) {
      const name = err?.name || 'Error';
      telemetry.log('mic.getusermedia.denied', { name, message: err?.message || '' });
      // Map the DOMException (or our synthetic TimeoutError) to a fault kind.
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        micFault('notfound', name);
      } else if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        micFault('denied', name);
      } else if (name === 'TimeoutError') {
        micFault('timeout', name);
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

  // Stop capture and stash the audio in mic.pending* — kept around (never
  // cleared on a transcription failure) so a fault can be retried against the
  // same recording instead of forcing the user through a full re-record.
  function stopCapture() {
    if (!mic.recording) return false;
    mic.recording = false;
    button?.classList.remove('mic-recording');
    micLabel('…');
    telemetry.log('mic.stop');

    const chunks = mic.chunks;
    const durationMs = mic.startedAt ? Date.now() - mic.startedAt : 0;
    mic.pendingChunks = chunks;
    mic.pendingRate = mic.inputRate;
    mic.pendingDurationMs = durationMs;
    stopTracks();
    mic.chunks = [];
    telemetry.log('mic.recording.stop', { durationMs, chunkCount: chunks.length });
    return true;
  }

  // POST mic.pendingChunks to /transcribe. Resolves the transcript (possibly
  // '') on success and clears mic.pendingChunks; on any failure it raises the
  // matching fault (leaving mic.pendingChunks intact for a retry) and
  // resolves null.
  async function transcribePending() {
    micLabel('…');
    micOverlay.showTranscribing();

    try {
      const wav = encodeWav(mic.pendingChunks, mic.pendingRate);
      const form = new FormData();
      form.append('audio', wav, 'speech.wav');
      telemetry.log('mic.transcribe.req', { bytes: wav.size, durationMs: mic.pendingDurationMs });

      let res;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
      try {
        res = await fetch('/transcribe', { method: 'POST', body: form, signal: controller.signal });
      } catch (netErr) {
        if (netErr?.name === 'AbortError') {
          telemetry.log('mic.transcribe.err', { stage: 'timeout' });
          micFault('transcribe-timeout');
          return null;
        }
        telemetry.log('mic.transcribe.err', { stage: 'network', message: netErr?.message || '' });
        micFault('network', netErr?.message || 'network error');
        return null;
      } finally {
        clearTimeout(timer);
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
        return null;
      }

      const { text } = await res.json();
      telemetry.log('mic.transcribe.ok', { textLength: (text || '').trim().length });
      mic.pendingChunks = null;
      return text && text.trim() ? text : '';
    } catch (err) {
      console.error('Transcription failed:', err);
      telemetry.log('mic.transcribe.err', { stage: 'exception', message: err?.message || String(err) });
      micFault('mic', err?.message || 'encode/transcribe error');
      return null;
    }
  }

  // Stop → preview: transcribe, then show REVIEW for the user to edit/confirm.
  async function captureStop() {
    if (!stopCapture()) return;
    const text = await transcribePending();
    if (text === null) return; // fault already shown, audio preserved
    micOverlay.showReview(text);
    // Note: mic.busy stays true until submit/cancel/retry resolves
  }

  // Stop → submit in one tap: transcribe and send straight through, no
  // preview. Falls back to REVIEW when there's nothing to submit.
  async function captureStopAndSubmit() {
    if (!stopCapture()) return;
    const text = await transcribePending();
    if (text === null) return; // fault already shown, audio preserved
    if (!text) {
      micOverlay.showReview(text);
      return;
    }
    submitText(text);
    micOverlay.dismiss();
  }

  // Retry a transcription against already-captured audio (FAULT-state Retry
  // with pending audio, and the auto-retry after installing/starting a local
  // STT server). Always lands back on REVIEW — never auto-submits — so a
  // second failure or an unexpected transcript still gets a human look.
  async function retryPendingTranscription() {
    if (mic.pendingChunks === null) return;
    const text = await transcribePending();
    if (text === null) return; // fault already shown, audio preserved
    micOverlay.showReview(text);
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
      telemetry.log('mic.toggle', { busy: mic.busy, recording: mic.recording });
      if (mic.busy) return;
      telemetry.log('mic.click', { action: mic.recording ? 'stop' : 'start' });
      if (mic.recording) captureStop();
      else startRecording();
    },
    isRecording() { return mic.recording; },
  };
}
