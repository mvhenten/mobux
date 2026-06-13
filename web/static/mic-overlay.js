// mic-overlay.js — full-viewport recording / fault overlay for dictation.
//
// Replaces the too-subtle mic-icon flash. Two states:
//
//   RECORDING — shown the moment capture starts. A "● Recording" indicator
//   with a live elapsed timer and a soft pulse. Tapping anywhere stops &
//   sends (the host wires `onStop`); the mic button does the same.
//
//   FAULT — shown when we can't record or a downstream step fails. Carries a
//   specific human message plus the technical reason. Tap to dismiss.
//
// House style: muted, low-contrast palette (phone use, technical operators —
// no bright/saturated colors, no consumer fluff). Self-contained: all styles
// are injected once, no external CSS dependency. Android-only target.

// One place for the fault-reason mapping so logs and UI agree. `kind` is a
// stable short code; the overlay shows {title, detail}. Pass `extra` to fill
// the technical detail line for the generic/network cases.
export function faultMessage(kind, extra) {
  switch (kind) {
    case 'insecure':
      return {
        title: 'Mic needs a secure (HTTPS) connection.',
        detail: 'mediaDevices unavailable — open mobux over HTTPS.',
      };
    case 'denied': // NotAllowedError / SecurityError
      return {
        title: 'Microphone blocked.',
        detail: 'Enable mic permission for mobux in Android app settings.',
      };
    case 'notfound': // NotFoundError
      return { title: 'No microphone found.', detail: extra || 'NotFoundError' };
    case 'model': // /transcribe 503
      return {
        title: 'Speech provider not available.',
        detail: extra || 'Configure a provider in settings, or install a local server.',
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
/* Fault state — muted amber/clay, noticeable but not alarming. */
#mobux-mic-overlay.fault { background: rgba(28, 22, 20, 0.94); }
#mobux-mic-overlay.fault .mo-dot { background: #9a7b50; }
#mobux-mic-overlay.fault .mo-status { color: #c9b48d; font-size: 17px; }
#mobux-mic-overlay .mo-title {
  font-size: 18px; color: #cdbfa6; text-align: center; max-width: 22em;
  line-height: 1.35;
}
#mobux-mic-overlay .mo-detail {
  font-family: monospace; font-size: 12px; color: #877f6e;
  text-align: center; max-width: 26em; word-break: break-word;
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
}`;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// createMicOverlay(onStop) → { showRecording, showFault, dismiss }
//   onStop() is called when the user taps the RECORDING overlay (stop & send).
export function createMicOverlay(onStop) {
  ensureStyles();
  let root = null;
  let timerHandle = null;
  let startedAt = 0;

  function teardown() {
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

  function showRecording() {
    teardown();
    root = document.createElement('div');
    root.id = 'mobux-mic-overlay';
    root.className = 'recording';
    root.innerHTML =
      '<div class="mo-status"><span class="mo-dot"></span>Recording</div>' +
      '<div class="mo-timer">00:00</div>' +
      '<div class="mo-hint">Tap anywhere to stop &amp; send</div>';

    const timerEl = root.querySelector('.mo-timer');
    startedAt = Date.now();
    timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timerEl.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
    }, 250);

    // Tap-to-stop. Guard so the tap that started recording (on the mic button)
    // can't immediately dismiss; the click lands on the button, not us.
    root.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onStop === 'function') onStop();
    });
    document.body.appendChild(root);
  }

  // showFault(kind, extra) — render the mapped fault. Tap to dismiss.
  function showFault(kind, extra) {
    teardown();
    const { title, detail } = faultMessage(kind, extra);
    root = document.createElement('div');
    root.id = 'mobux-mic-overlay';
    root.className = 'fault';
    root.innerHTML =
      '<div class="mo-status"><span class="mo-dot"></span>Dictation failed</div>' +
      '<div class="mo-title"></div>' +
      '<div class="mo-detail"></div>' +
      (kind === 'model'
        ? '<a class="mo-action" href="/settings">Open settings</a>'
        : '') +
      '<div class="mo-hint">Tap to dismiss</div>';
    root.querySelector('.mo-title').textContent = title;
    root.querySelector('.mo-detail').textContent = detail;
    root.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    });
    document.body.appendChild(root);
  }

  return { showRecording, showFault, dismiss };
}
