const session = window.MOBUX_SESSION;
const termEl = document.getElementById("terminal");
const overlay = document.getElementById("touchOverlay");
const isMobile = window.innerWidth < 620;
const term = new Terminal({
  cursorBlink: true,
  fontSize: isMobile ? 14 : 15,
  convertEol: false,
  scrollback: 10000,
  theme: { background: "#0f1115" },
});
term.open(termEl);

// Prevent xterm.js from entering mouse-capture mode.
Object.defineProperty(term._core.coreMouseService, 'activeProtocol', {
  set() {},
  get() { return 'NONE'; },
  configurable: true,
});

// Prevent xterm.js from switching to alternate screen buffer.
const buffers = term._core._bufferService.buffers;
buffers.activateAltBuffer = () => {};
buffers.activateNormalBuffer = () => {};

// Enable overlay for touch devices, keep pointer-events:none for mouse
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  overlay.style.pointerEvents = 'auto';
}

const wsProto = location.protocol === "https:" ? "wss" : "ws";
let ws;

let reconnect = () => {};

(async () => {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/history`);
    if (res.ok) {
      const history = await res.text();
      if (history.trim()) {
        term.write(history.replace(/\n/g, '\r\n'));
      }
    }
  } catch (e) {}

  function connect() {
    ws = new WebSocket(`${wsProto}://${location.host}/ws/${encodeURIComponent(session)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { sendResize(); refreshPanes(); };
    ws.onmessage = async (ev) => {
      if (typeof ev.data === "string") term.write(ev.data);
      else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
      else if (ev.data instanceof Blob) term.write(new Uint8Array(await ev.data.arrayBuffer()));
    };
    ws.onclose = () => {};
    ws.onerror = () => {};
  }

  reconnect = () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (ws) { try { ws.close(); } catch(e) {} }
    connect();
  };

  term.onData((d) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); });

  connect();
  setTimeout(() => term.scrollToBottom(), 500);
})();

function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cw = term._core._renderService.dimensions?.css?.cell?.width || 9;
  const ch = term._core._renderService.dimensions?.css?.cell?.height || 18;
  const cols = Math.max(20, Math.floor(window.innerWidth / cw) - 1);
  const rows = Math.max(10, Math.floor(window.innerHeight / ch) - 1);
  term.resize(cols, rows);
  ws.send(JSON.stringify({ type: "resize", cols, rows }));
}
window.addEventListener("resize", sendResize);
setTimeout(sendResize, 100);

// ── Pane switching ──────────────────────────────────────────────────

const paneIndicator = document.getElementById("paneIndicator");

let panes = [];
let activeIndex = 0;

async function refreshPanes() {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/panes`);
    if (!res.ok) return;
    panes = await res.json();
    activeIndex = panes.findIndex((p) => p.active);
    if (activeIndex < 0) activeIndex = 0;
    updatePaneUI();
  } catch (e) {}
}

function updatePaneUI() {
  if (panes.length <= 1) {
    paneIndicator.textContent = panes.length === 1 ? panes[0].title : "";
  } else {
    const current = panes[activeIndex];
    paneIndicator.textContent = `${current ? current.title : "?"} (${activeIndex + 1}/${panes.length})`;
  }
}

async function selectPane(index) {
  if (panes.length <= 1) return;
  if (index < 0) index = panes.length - 1;
  if (index >= panes.length) index = 0;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const dir = (index > activeIndex || (activeIndex === panes.length - 1 && index === 0)) ? "n" : "p";
    ws.send("\x02" + dir);
    activeIndex = index;
    updatePaneUI();
    setTimeout(refreshPanes, 300);
  }
}

setInterval(refreshPanes, 5000);

// ── Touch gesture overlay ───────────────────────────────────────────
// Big div on top of xterm catches all touch. Mouse passes through
// (pointer-events:none for mouse). Touch is translated to WheelEvents
// dispatched on xterm's element so its handleWheel does the scrolling.
//
// Physics: iOS UIScrollView / BetterScroll constants.
{
  const AMP          = 2.5;
  const TAP_PX       = 8;
  const TAP_MS       = 300;
  const DTAP_MS      = 400;   // max ms between taps for double-tap
  const VEL_WINDOW   = 100;   // ms of samples for velocity
  const MIN_VEL      = 0.15;  // px/ms to trigger momentum
  const DECEL        = 0.0015;// px/ms² (BetterScroll)
  const MAX_MOM_MS   = 2500;  // max momentum duration
  const IOS_DECAY    = 0.998; // per-ms (UIScrollViewDecelerationRateNormal)
  const FLICK_H_PX   = 50;    // min horizontal px for pane switch
  const FLICK_H_VEL  = 0.3;   // min horizontal velocity (px/ms)

  const xtermEl = termEl.querySelector('.xterm') || termEl;

  let startX, startY, startTime;
  let lastY, lastTime;
  let gesture;      // null | 'tap' | 'scroll' | 'hswipe' | 'pinch'
  let posSamples;   // [{y, t}]
  let momId = null;
  let lastTapTime = 0;

  function wheel(dy) {
    xtermEl.dispatchEvent(new WheelEvent('wheel', {
      deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true,
    }));
  }

  function stopMom() {
    if (momId !== null) { cancelAnimationFrame(momId); momId = null; }
  }

  function calcVelocity() {
    if (posSamples.length < 2) return 0;
    const last = posSamples[posSamples.length - 1];
    const cutoff = last.t - VEL_WINDOW;
    let i = posSamples.length - 1;
    while (i > 0 && posSamples[i - 1].t >= cutoff) i--;
    const first = posSamples[i];
    const dt = last.t - first.t;
    if (dt < 10) return 0;
    return (first.y - last.y) / dt;
  }

  function momentum() {
    const v0 = calcVelocity();
    if (Math.abs(v0) < MIN_VEL) return;
    const speed = Math.abs(v0);
    const dir = v0 > 0 ? 1 : -1;
    const totalMs = Math.min(MAX_MOM_MS, (speed * 2) / DECEL);
    const t0 = performance.now();
    let prevT = t0;

    function tick(now) {
      const elapsed = now - t0;
      if (elapsed >= totalMs) return;
      const dt = now - prevT;
      prevT = now;
      const vNow = speed * Math.pow(IOS_DECAY, elapsed);
      if (vNow < 0.03) return;
      wheel(vNow * dt * dir * AMP);
      momId = requestAnimationFrame(tick);
    }
    momId = requestAnimationFrame(tick);
  }

  overlay.addEventListener('touchstart', (e) => {
    reconnect();
    stopMom();
    if (e.touches.length === 2) {
      gesture = 'pinch';
      startY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
      return;
    }
    if (e.touches.length !== 1) { gesture = null; return; }
    const t = e.touches[0];
    startX = t.pageX; startY = t.pageY;
    lastY = t.pageY;
    startTime = lastTime = performance.now();
    gesture = 'tap';
    posSamples = [{ y: t.pageY, t: startTime }];
  });

  overlay.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && gesture === 'pinch') {
      // Track two-finger pull distance
      const midY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
      const dy = midY - startY;
      // Visual feedback: show pull indicator when pulling down > 60px
      if (dy > 60) {
        paneIndicator.textContent = '↻ Release to reload';
      } else if (dy > 20) {
        paneIndicator.textContent = '↓ Pull to reload...';
      }
      return;
    }
    if (e.touches.length !== 1 || !gesture) return;
    const y = e.touches[0].pageY;
    const now = performance.now();

    posSamples.push({ y, t: now });
    const trim = now - VEL_WINDOW * 2;
    while (posSamples.length > 2 && posSamples[0].t < trim) posSamples.shift();

    if (gesture === 'tap') {
      const dx = Math.abs(e.touches[0].pageX - startX);
      const dy = Math.abs(y - startY);
      if (dy > TAP_PX && dy >= dx) {
        gesture = 'scroll';
      } else if (dx > TAP_PX && dx > dy) {
        gesture = 'hswipe';
      } else {
        return;
      }
    }

    if (gesture === 'scroll') {
      const dy = lastY - y;
      wheel(dy * AMP);
      lastY = y;
      lastTime = now;
    }
    // hswipe: just track, act on touchend
  }, { passive: false });

  overlay.addEventListener('touchend', (e) => {
    if (gesture === 'pinch') {
      // Check if two-finger pull down was far enough
      const endY = e.changedTouches[0]?.pageY ?? startY;
      const dy = endY - startY;
      if (dy > 60) {
        location.reload(true);
      } else {
        updatePaneUI(); // restore indicator text
      }
      gesture = null;
      return;
    }
    if (gesture === 'tap' && (performance.now() - startTime) < TAP_MS) {
      const now = performance.now();
      if (now - lastTapTime < DTAP_MS) {
        // Double tap — temporarily hide overlay so next tap hits xterm directly.
        // xterm.js handles its own click-to-focus with keyboard popup.
        overlay.style.pointerEvents = 'none';
        setTimeout(() => { overlay.style.pointerEvents = 'auto'; }, 500);
        // Also directly click through to where the user tapped
        const el = document.elementFromPoint(startX, startY);
        if (el) {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX, clientY: startY }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: startX, clientY: startY }));
        }
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    } else if (gesture === 'scroll') {
      momentum();
    } else if (gesture === 'hswipe') {
      const endX = e.changedTouches[0]?.pageX ?? startX;
      const dx = endX - startX;
      const dt = performance.now() - startTime;
      const vel = Math.abs(dx) / dt;
      if (Math.abs(dx) > FLICK_H_PX || vel > FLICK_H_VEL) {
        selectPane(dx < 0 ? activeIndex + 1 : activeIndex - 1);
      }
    }
    gesture = null;
  });

  overlay.addEventListener('touchcancel', () => { stopMom(); gesture = null; });
}

// ── Voice input ─────────────────────────────────────────────────────

async function sendVoiceText(text) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await res.text());
}

const micBtn = document.getElementById("micBtn");
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function manualSendFallback() {
  const text = prompt("Speech recognition unavailable. Type command to send:");
  if (!text || !text.trim()) return;
  sendVoiceText(text.trim()).catch((e) => alert(`Send failed: ${e.message}`));
}

if (!SR) {
  micBtn.title = "SpeechRecognition not available — click for text fallback";
  micBtn.addEventListener("click", manualSendFallback);
} else {
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  let listening = false;

  rec.onstart = () => { listening = true; micBtn.textContent = "🎙️"; };
  rec.onend = () => { listening = false; micBtn.textContent = "🎤"; };

  rec.onerror = (e) => {
    term.writeln(`\r\n\x1b[31m[speech error: ${e.error}]\x1b[0m`);
    if (e.error === "not-allowed") alert("Microphone permission denied.");
    else alert(`Speech error: ${e.error}`);
  };

  rec.onresult = async (event) => {
    const text = event.results?.[0]?.[0]?.transcript?.trim();
    if (!text) return;
    term.writeln(`\r\n\x1b[36m[voice] ${text}\x1b[0m`);
    try { await sendVoiceText(text); } catch (e) { alert(`Send failed: ${e.message}`); }
  };

  micBtn.addEventListener("click", (ev) => {
    if (ev.shiftKey) { manualSendFallback(); return; }
    if (listening) return;
    try { rec.start(); } catch (e) { manualSendFallback(); }
  });
}
