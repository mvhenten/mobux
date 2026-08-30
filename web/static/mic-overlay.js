// mic-overlay.js — full-viewport recording / fault overlay for dictation.
//
// Five states:
//   RECORDING   — waveform canvas, running timer, primary Submit (stop +
//                 transcribe + submit in one tap) plus Pause/Resume/Stop/Cancel
//                 (Stop still routes through the preview below, for editing)
//   TRANSCRIBING — spinner, no buttons
//   REVIEW      — returned text (or "Nothing captured"), Retry/Submit or Retry/Dismiss
//   FAULT       — human error message, Retry + optional install/start flow.
//                 If reached with captured audio still pending, Retry re-sends
//                 that audio instead of forcing a fresh recording. A pre-record
//                 probe fault additionally offers "Record anyway"; a fault
//                 raised with audio already captured and no speech backend to
//                 transcribe it offers "Submit as audio file" instead.
//
// House style: muted, low-contrast palette. Android-only target.

import { u } from './base.js';

// One place for the fault-reason mapping so logs and UI agree. `kind` is a
// stable short code; the overlay shows {title, detail}. Pass `extra` to fill
// the technical detail line for the generic/network cases.
export function faultMessage(kind, extra) {
  switch (kind) {
    case 'insecure':
      return {
        title: 'Mic needs a trusted, secure connection.',
        detail:
          'The browser will not expose the microphone on this connection. Open mobux over HTTPS with a trusted certificate (a self-signed cert is not enough).',
      };
    case 'denied': // NotAllowedError / SecurityError
      return {
        title: 'Microphone permission is blocked.',
        detail:
          "If you are using the installed app, it may be missing the Android microphone permission — reinstall the latest app to re-grant it. In a browser, check the site's microphone permission (tap the lock icon → Permissions → Microphone).",
      };
    case 'notfound': // NotFoundError
      return { title: 'No microphone found.', detail: extra || 'NotFoundError' };
    case 'timeout': // getUserMedia never resolved or rejected
      return {
        title: 'Microphone access timed out.',
        detail:
          'The app may be missing microphone permission — reinstall the latest app, or check the app\'s microphone permission.',
      };
    case 'transcribe-timeout': // /transcribe never responded
      return {
        title: 'Transcription backend did not respond.',
        detail:
          'The speech-to-text backend accepted the audio but never returned a transcript. Check the backend status in Settings, or switch to a local provider.',
      };
    case 'model': // /transcribe 503
      return {
        title: 'Speech provider not available.',
        detail: extra || 'Configure a provider in settings, or install a local server.',
      };
    case 'audio-upload': // /api/upload rejected the raw recording
      return {
        title: 'Could not hand over the recording.',
        detail: extra || 'upload error',
      };
    case 'http': // other non-200
      return { title: 'Transcription failed.', detail: extra || 'server error' };
    case 'network':
      return { title: 'Transcription failed.', detail: extra || 'network error' };
    case 'mic': // generic getUserMedia / recorder failure
    default:
      return {
        title: 'Could not start recording.',
        detail: extra || 'microphone unavailable',
      };
  }
}

// ── Report-issue link ────────────────────────────────────────────────
// Every fault gets a prefilled GitHub issue link so a dead mic is never a
// dead end — the user can hand the exact context to a maintainer in one tap.
const REPORT_REPO = 'mvhenten/mobux';

function reportContextLines(kind, extra, buildInfo) {
  const lines = [
    `Fault kind: ${kind}`,
    `Error: ${extra || '(none)'}`,
  ];
  if (buildInfo) {
    lines.push(`App version: ${buildInfo.version || 'unknown'} (server bundle ${buildInfo.serverHash || 'unknown'}, loaded bundle ${buildInfo.feHash || 'unknown'})`);
  }
  lines.push(
    `User agent: ${navigator.userAgent}`,
    `Secure context: ${window.isSecureContext}`,
    `getUserMedia available: ${!!navigator.mediaDevices?.getUserMedia}`,
    `URL: ${location.href}`,
  );
  return lines;
}

function buildReportUrl(kind, extra, buildInfo) {
  const errName = extra ? String(extra).slice(0, 80) : 'unknown';
  const title = `[dictation] ${kind} — ${errName}`;
  const body = reportContextLines(kind, extra, buildInfo).join('\n');
  const params = new URLSearchParams({ title, body });
  return `https://github.com/${REPORT_REPO}/issues/new?${params.toString()}`;
}

// Best-effort build/version info for the report body. Never throws — a
// failed or slow fetch just means the link ships without version fields.
async function fetchBuildInfo() {
  const info = {};
  await Promise.all([
    fetch(u('api/build-info'))
      .then((r) => r.json())
      .then((d) => {
        info.version = d?.version;
        info.serverHash = d?.build_hash;
      })
      .catch(() => {}),
    fetch(u('static/build-info.json'))
      .then((r) => r.json())
      .then((d) => {
        info.feHash = d?.hash;
      })
      .catch(() => {}),
  ]);
  return info;
}

const STYLE_ID = 'mobux-mic-overlay-style';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#mobux-mic-overlay {
  position: fixed; inset: 0; z-index: 2147483646;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 18px; padding: 24px;
  font-family: -apple-system, system-ui, sans-serif;
  color: #c8ccc9;
  background: rgba(20, 22, 24, 0.92);
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  overflow: hidden;
}
#mobux-mic-overlay.review {
  justify-content: flex-start;
  padding-top: 48px;
}
#mobux-mic-overlay .mo-dot {
  width: 14px; height: 14px; border-radius: 50%;
  display: inline-block; vertical-align: middle; margin-right: 8px;
}
#mobux-mic-overlay.recording .mo-dot {
  background: #b06a6a;
  animation: moPulse 1.4s ease-in-out infinite;
}
#mobux-mic-overlay .mo-status {
  font-size: 19px; letter-spacing: 0.3px; color: #b8bdb9;
}
#mobux-mic-overlay .mo-timer {
  font-family: monospace; font-size: 34px; color: #a9b0ac;
  font-variant-numeric: tabular-nums;
}
#mobux-mic-overlay .mo-hint {
  font-size: 14px; color: #7e857f; text-align: center; max-width: 22em;
}
/* Fault state — muted amber/clay, loud through contrast/weight, not color. */
#mobux-mic-overlay.fault {
  background: rgba(28, 22, 20, 0.96);
  border-top: 3px solid rgba(201, 180, 141, 0.55);
}
#mobux-mic-overlay.fault .mo-dot { background: #9a7b50; }
#mobux-mic-overlay.fault .mo-status {
  color: #ddc79a; font-size: 19px; font-weight: 600; letter-spacing: 0.4px;
}
#mobux-mic-overlay .mo-title {
  font-size: 19px; font-weight: 600; color: #e2d3ae; text-align: center;
  max-width: 22em; line-height: 1.4;
}
#mobux-mic-overlay .mo-detail {
  font-family: monospace; font-size: 12px; color: #a4998a;
  text-align: center; max-width: 26em; word-break: break-word;
}
/* Selector needs the .mo-btn.mo-report-link compound (not just
   .mo-report-link) to out-rank the plain .mo-btn rule declared below it. */
#mobux-mic-overlay .mo-btn.mo-report-link {
  font-size: 13px;
  color: #cdbfa6;
  border: 1px solid rgba(201, 180, 141, 0.4);
}
@keyframes moPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(176, 106, 106, 0.5); }
  50%      { box-shadow: 0 0 0 9px rgba(176, 106, 106, 0); }
}
#mobux-mic-overlay .mo-action {
  display: inline-block;
  padding: 8px 20px;
  border-radius: 6px;
  background: rgba(255,255,255,0.08);
  color: #c8ccc9;
  text-decoration: none;
  font-size: 14px;
}
#mobux-mic-overlay .mo-install-btn {
  display: inline-block;
  padding: 8px 20px;
  border-radius: 6px;
  background: rgba(255,255,255,0.08);
  color: #c8ccc9;
  border: 1px solid rgba(255,255,255,0.12);
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
}
#mobux-mic-overlay .mo-install-log {
  font-size: 11px;
  color: #7e857f;
  max-height: 6em;
  overflow-y: auto;
  background: rgba(0,0,0,0.2);
  padding: 6px;
  border-radius: 4px;
  max-width: 26em;
  white-space: pre-wrap;
  word-break: break-all;
}
#mobux-mic-overlay .mo-install-hint {
  font-size: 13px;
  color: #7e857f;
}
/* New shared elements */
#mobux-mic-overlay .mo-btn-row {
  display: flex;
  flex-direction: row;
  gap: 12px;
  justify-content: center;
}
#mobux-mic-overlay .mo-btn {
  display: inline-block;
  padding: 8px 20px;
  border-radius: 6px;
  background: rgba(255,255,255,0.08);
  color: #c8ccc9;
  border: 1px solid rgba(255,255,255,0.12);
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
}
#mobux-mic-overlay .mo-primary-row {
  margin-top: 4px;
}
#mobux-mic-overlay .mo-btn-primary {
  padding: 10px 30px;
  font-size: 15px;
  background: rgba(106, 138, 106, 0.2);
  border: 1px solid rgba(106, 138, 106, 0.45);
  color: #d3ddd3;
}
#mobux-mic-overlay .mo-canvas {
  width: 100%;
  max-width: 320px;
  height: 60px;
  display: block;
}
#mobux-mic-overlay .mo-review-text {
  font-family: monospace;
  font-size: 12px;
  color: #a9b0ac;
  max-height: 40vh;
  overflow-y: auto;
  background: rgba(0,0,0,0.2);
  padding: 8px;
  border-radius: 4px;
  max-width: 26em;
  white-space: pre-wrap;
  word-wrap: break-word;
  word-break: break-word;
}
/* Transcribing spinner */
#mobux-mic-overlay .mo-spinner {
  width: 28px; height: 28px;
  border: 3px solid rgba(169, 176, 172, 0.2);
  border-top-color: #6a8a6a;
  border-radius: 50%;
  animation: moSpin 0.9s linear infinite;
}
@keyframes moSpin {
  to { transform: rotate(360deg); }
}`;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// createMicOverlay(handlers) → { showRecording(analyser), showTranscribing(), showReview(text), showFault(kind, extra, opts), dismiss() }
//   handlers = { onStop, onFastSubmit, onPause, onResume, onCancel, onRetry,
//                onFaultRetry, onSubmit, onDismiss, retryTranscription }
//   onRetry       — REVIEW state's Retry: discard and record again.
//   onFaultRetry  — FAULT state's Retry: caller decides fresh vs re-send
//                   already-captured audio (see createDictateAction).
//   showFault(kind, extra, { onProceedAnyway, onSubmitAudio }) —
//   onProceedAnyway renders a "Record anyway" action for faults raised before
//   any audio was captured; onSubmitAudio renders a "Submit as audio file"
//   action for faults raised after, where the recording can still be handed
//   over as an uploaded file instead of a transcript.
export function createMicOverlay(handlers) {
  // Support legacy two-arg call: createMicOverlay(onStop, retryTranscription)
  if (typeof handlers === 'function') {
    const onStop = handlers;
    const retryTranscription = arguments[1]; // eslint-disable-line prefer-rest-params
    handlers = { onStop, retryTranscription };
  }
  handlers = handlers || {};

  ensureStyles();
  let root = null;
  let timerHandle = null;
  let startedAt = 0;
  let rafId = null;

  function stopRaf() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function teardown() {
    stopRaf();
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    if (root) {
      root.remove();
      root = null;
    }
  }

  function dismiss() {
    teardown();
  }

  // ── RECORDING state ──────────────────────────────────────────────────
  function showRecording(analyser) {
    teardown();
    root = document.createElement('div');
    root.id = 'mobux-mic-overlay';
    root.className = 'recording';

    // Status row
    const statusEl = document.createElement('div');
    statusEl.className = 'mo-status';
    statusEl.innerHTML = '<span class="mo-dot"></span>Recording';

    // Timer
    const timerEl = document.createElement('div');
    timerEl.className = 'mo-timer';
    timerEl.textContent = '00:00';

    // Waveform canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'mo-canvas';
    canvas.width = 320;
    canvas.height = 60;

    // Primary row: one-tap Submit — stop + transcribe + submit, no preview.
    const primaryRow = document.createElement('div');
    primaryRow.className = 'mo-btn-row mo-primary-row';

    const submitBtn = document.createElement('button');
    submitBtn.className = 'mo-btn mo-btn-primary';
    submitBtn.textContent = '✓ Submit';

    primaryRow.appendChild(submitBtn);

    // Button row: Pause (visible initially), Resume (hidden), Stop, Cancel
    const btnRow = document.createElement('div');
    btnRow.className = 'mo-btn-row';

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'mo-btn';
    pauseBtn.textContent = '⏸ Pause';

    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'mo-btn';
    resumeBtn.textContent = '▶ Resume';
    resumeBtn.style.display = 'none';

    const stopBtn = document.createElement('button');
    stopBtn.className = 'mo-btn';
    stopBtn.textContent = '⏹ Stop';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mo-btn';
    cancelBtn.textContent = '✕ Cancel';

    btnRow.appendChild(pauseBtn);
    btnRow.appendChild(resumeBtn);
    btnRow.appendChild(stopBtn);
    btnRow.appendChild(cancelBtn);

    root.appendChild(statusEl);
    root.appendChild(canvas);
    root.appendChild(timerEl);
    root.appendChild(primaryRow);
    root.appendChild(btnRow);
    document.body.appendChild(root);

    // Timer
    startedAt = Date.now();
    timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timerEl.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
    }, 250);

    // Waveform RAF
    const ctx2d = canvas.getContext('2d');
    let paused = false;

    function drawWaveform() {
      if (!root) return;
      if (paused || !analyser) {
        // Flat line when paused or no analyser
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        ctx2d.beginPath();
        ctx2d.strokeStyle = '#6a8a6a';
        ctx2d.lineWidth = 1.5;
        ctx2d.moveTo(0, canvas.height / 2);
        ctx2d.lineTo(canvas.width, canvas.height / 2);
        ctx2d.stroke();
        if (!paused) rafId = requestAnimationFrame(drawWaveform);
        return;
      }
      const bufLen = analyser.frequencyBinCount;
      const data = new Uint8Array(bufLen);
      analyser.getByteTimeDomainData(data);

      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.beginPath();
      ctx2d.strokeStyle = '#6a8a6a';
      ctx2d.lineWidth = 1.5;

      const sliceW = canvas.width / bufLen;
      let x = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = data[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
        x += sliceW;
      }
      ctx2d.lineTo(canvas.width, canvas.height / 2);
      ctx2d.stroke();

      rafId = requestAnimationFrame(drawWaveform);
    }

    if (analyser) {
      rafId = requestAnimationFrame(drawWaveform);
    } else {
      drawWaveform();
    }

    // Button handlers
    submitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof handlers.onFastSubmit === 'function') handlers.onFastSubmit();
    });

    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      paused = true;
      stopRaf();
      drawWaveform(); // draw flat line
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = '';
      if (typeof handlers.onPause === 'function') handlers.onPause();
    });

    resumeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      paused = false;
      resumeBtn.style.display = 'none';
      pauseBtn.style.display = '';
      rafId = requestAnimationFrame(drawWaveform);
      if (typeof handlers.onResume === 'function') handlers.onResume();
    });

    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof handlers.onStop === 'function') handlers.onStop();
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof handlers.onCancel === 'function') handlers.onCancel();
    });
  }

  // ── TRANSCRIBING state ───────────────────────────────────────────────
  function showTranscribing() {
    stopRaf();
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (root) { root.remove(); root = null; }

    root = document.createElement('div');
    root.id = 'mobux-mic-overlay';
    root.className = 'transcribing';

    const spinner = document.createElement('div');
    spinner.className = 'mo-spinner';

    const statusEl = document.createElement('div');
    statusEl.className = 'mo-status';
    statusEl.textContent = 'Transcribing…';

    root.appendChild(spinner);
    root.appendChild(statusEl);
    document.body.appendChild(root);
  }

  // ── REVIEW state ─────────────────────────────────────────────────────
  function showReview(text) {
    stopRaf();
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (root) { root.remove(); root = null; }

    root = document.createElement('div');
    root.id = 'mobux-mic-overlay';
    root.className = 'review';

    const isEmpty = !text || !text.trim();

    const statusEl = document.createElement('div');
    statusEl.className = 'mo-status';
    statusEl.textContent = isEmpty ? 'Nothing captured' : 'Review';

    const textBox = document.createElement('div');
    textBox.className = 'mo-review-text';
    textBox.textContent = isEmpty ? 'Nothing captured' : text;

    const btnRow = document.createElement('div');
    btnRow.className = 'mo-btn-row';

    const retryBtn = document.createElement('button');
    retryBtn.className = 'mo-btn';
    retryBtn.textContent = '↻ Retry';

    const actionBtn = document.createElement('button');
    actionBtn.className = 'mo-btn';

    if (isEmpty) {
      actionBtn.textContent = '✕ Dismiss';
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
        if (typeof handlers.onDismiss === 'function') handlers.onDismiss();
      });
    } else {
      actionBtn.textContent = '✓ Submit';
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof handlers.onSubmit === 'function') handlers.onSubmit(text);
        dismiss();
      });
    }

    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof handlers.onRetry === 'function') handlers.onRetry();
    });

    btnRow.appendChild(retryBtn);
    btnRow.appendChild(actionBtn);

    root.appendChild(statusEl);
    if (!isEmpty) root.appendChild(textBox);
    root.appendChild(btnRow);
    document.body.appendChild(root);
  }

  // ── FAULT state ──────────────────────────────────────────────────────
  // showFault(kind, extra, opts) — render the mapped fault. Tap to dismiss.
  //   opts.onProceedAnyway — when set, adds a "Record anyway" action (used
  //   for the pre-record backend probe, where nothing has been captured yet).
  //   opts.onSubmitAudio — when set, adds a "Submit as audio file" action
  //   (used once audio HAS been captured but no backend can transcribe it).
  function showFault(kind, extra, opts) {
    opts = opts || {};
    stopRaf();
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (root) { root.remove(); root = null; }

    const { title, detail } = faultMessage(kind, extra);
    root = document.createElement('div');
    root.id = 'mobux-mic-overlay';
    root.className = 'fault';
    root.innerHTML =
      '<div class="mo-status"><span class="mo-dot"></span>⚠ Dictation failed</div>' +
      '<div class="mo-title"></div>' +
      '<div class="mo-detail"></div>' +
      '<div class="mo-action-area"></div>' +
      '<div class="mo-btn-row mo-fault-btn-row"></div>' +
      '<div class="mo-hint">Tap to dismiss</div>';
    root.querySelector('.mo-title').textContent = title;
    root.querySelector('.mo-detail').textContent = detail;

    // Retry button — the caller decides whether this re-sends already
    // captured audio or starts a fresh recording (see onFaultRetry).
    const retryBtn = document.createElement('button');
    retryBtn.className = 'mo-btn';
    retryBtn.textContent = '↻ Retry';
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof handlers.onFaultRetry === 'function') handlers.onFaultRetry();
    });
    root.querySelector('.mo-fault-btn-row').appendChild(retryBtn);

    // Report-issue link — present for every fault kind, including
    // transcribe errors, so a dead mic always has a way out. A plain real
    // target=_blank anchor, no click handler of its own: the app-wide
    // delegated capture listener (external-link.js's
    // installExternalLinkHandler, installed once at engine boot) already
    // catches every off-origin anchor click and routes it through
    // openExternal (system browser in the TWA, new tab elsewhere) before
    // this element's own listeners would even run — a second listener here
    // would double-handle the same click (two openExternal calls, two
    // tabs). The outer overlay's tap-to-dismiss handler already skips
    // A/BUTTON targets, so no stopPropagation() is needed either.
    const reportLink = document.createElement('a');
    reportLink.className = 'mo-btn mo-report-link';
    reportLink.textContent = '⚑ Report issue';
    reportLink.target = '_blank';
    reportLink.rel = 'noopener noreferrer';
    reportLink.href = buildReportUrl(kind, extra, null);
    root.querySelector('.mo-fault-btn-row').appendChild(reportLink);
    fetchBuildInfo().then((buildInfo) => {
      if (!root) return;
      reportLink.href = buildReportUrl(kind, extra, buildInfo);
    });

    if (typeof opts.onProceedAnyway === 'function') {
      const proceedBtn = document.createElement('button');
      proceedBtn.className = 'mo-install-btn';
      proceedBtn.textContent = 'Record anyway';
      proceedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
        opts.onProceedAnyway();
      });
      root.querySelector('.mo-action-area').appendChild(proceedBtn);
    }

    // The recording is real even when nothing can transcribe it — hand the
    // raw WAV to the terminal as an uploaded file rather than making the
    // user re-record into a backend that is still down. Rendered
    // synchronously so it never waits on the /api/stt/status round-trip the
    // model-fault block below makes.
    if (typeof opts.onSubmitAudio === 'function') {
      const audioBtn = document.createElement('button');
      audioBtn.className = 'mo-install-btn mo-submit-audio';
      audioBtn.textContent = '⇪ Submit as audio file';
      const audioHint = document.createElement('div');
      audioHint.className = 'mo-install-hint mo-submit-audio-hint';
      audioBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        audioBtn.disabled = true;
        audioHint.textContent = 'Uploading the recording…';
        // onSubmitAudio renders its own fault on failure; this catch is the
        // last line of defense so an unexpected throw still leaves a live
        // button and a stated reason instead of a stuck "Uploading…".
        Promise.resolve()
          .then(() => opts.onSubmitAudio())
          .catch((err) => {
            audioBtn.disabled = false;
            audioHint.textContent =
              'Upload failed: ' + (err?.message || 'upload error');
          });
      });
      const audioArea = root.querySelector('.mo-action-area');
      audioArea.appendChild(audioBtn);
      audioArea.appendChild(audioHint);
    }

    root.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      if (typeof handlers.onDismiss === 'function') handlers.onDismiss();
    });
    document.body.appendChild(root);

    if (kind === 'model') {
      const actionArea = root.querySelector('.mo-action-area');
      fetch(u('api/stt/status'))
        .then((r) => r.json())
        .catch(() => null)
        .then((status) => {
          if (!root || !actionArea) return;
          if (status && status.kind === 'local' && !status.reachable) {
            if (!status.installed) {
              const btn = document.createElement('button');
              btn.className = 'mo-install-btn';
              btn.textContent = 'Install local speech server';
              const hint = document.createElement('div');
              hint.className = 'mo-install-hint';
              hint.textContent = '';
              const log = document.createElement('pre');
              log.className = 'mo-install-log';
              log.style.display = 'none';
              actionArea.appendChild(btn);
              actionArea.appendChild(hint);
              actionArea.appendChild(log);
              btn.addEventListener('click', (e) => {
                e.stopPropagation();
                runInstallFlow(btn, hint, log);
              });
            } else {
              const btn = document.createElement('button');
              btn.className = 'mo-install-btn';
              btn.textContent = 'Start speech server';
              const hint = document.createElement('div');
              hint.className = 'mo-install-hint';
              actionArea.appendChild(btn);
              actionArea.appendChild(hint);
              btn.addEventListener('click', (e) => {
                e.stopPropagation();
                runStartFlow(btn, hint);
              });
            }
          } else {
            const a = document.createElement('a');
            a.className = 'mo-action';
            a.href = u('settings');
            a.textContent = 'Open settings';
            actionArea.appendChild(a);
          }
        });
    }
  }

  async function runInstallFlow(btn, hint, log) {
    let cancelled = false;
    btn.disabled = true;
    hint.textContent = 'Installing… this can take a few minutes';
    log.style.display = '';
    log.textContent = '';

    const cancelPoll = () => { cancelled = true; };
    root && root.addEventListener('click', cancelPoll, { once: true });

    try {
      const r = await fetch(u('api/stt/install'), { method: 'POST' });
      if (!r.ok && r.status !== 202) {
        hint.textContent = 'Install request failed: ' + r.status;
        btn.disabled = false;
        return;
      }
    } catch (e) {
      hint.textContent = 'Install request failed: ' + (e.message || 'network error');
      btn.disabled = false;
      return;
    }

    const phase = await pollInstall(log, hint, () => cancelled);
    if (phase === 'success') {
      hint.textContent = 'Install complete. Starting server…';
      log.style.display = 'none';
      await startAndRetry(hint);
    } else {
      btn.disabled = false;
      btn.textContent = 'Retry install';
    }
  }

  async function pollInstall(log, hint, isCancelled) {
    let errCount = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      if (isCancelled && isCancelled()) return 'cancelled';
      let data;
      try {
        const r = await fetch(u('api/stt/install/status'));
        data = await r.json();
        errCount = 0;
      } catch (_) {
        if (++errCount >= 5) {
          hint.textContent = 'Install status unavailable after repeated errors.';
          return 'failed';
        }
        continue;
      }
      if (data.output && data.output.length) {
        log.textContent = data.output.join('\n');
        log.scrollTop = log.scrollHeight;
      }
      if (data.phase === 'success') return 'success';
      if (data.phase === 'failed') {
        hint.textContent = 'Install failed: ' + (data.error || 'unknown error');
        return 'failed';
      }
    }
  }

  async function runStartFlow(btn, hint) {
    btn.disabled = true;
    hint.textContent = 'Starting…';
    try {
      await fetch(u('api/stt/start'), { method: 'POST' });
    } catch (_) {}
    await startAndRetry(hint);
  }

  async function startAndRetry(hint) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let data;
      try {
        const r = await fetch(u('api/stt/status'));
        data = await r.json();
      } catch (_) { continue; }
      if (data.reachable) {
        hint.textContent = 'Server ready. Retrying…';
        if (typeof handlers.retryTranscription === 'function') {
          dismiss();
          handlers.retryTranscription();
        }
        return;
      }
    }
    hint.textContent = 'Server did not start in time. Try again.';
  }

  return { showRecording, showTranscribing, showReview, showFault, dismiss };
}
