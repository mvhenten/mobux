const session = window.MOBUX_SESSION;
const termEl = document.getElementById("terminal");
const overlay = document.getElementById("touchOverlay");
const loadquote = document.getElementById("loadquote");
const isMobile = window.innerWidth < 620;

// ── Loading screen quotes ───────────────────────────────────────────
const quotes = [
  ["Simplicity is prerequisite for reliability.", "Edsger W. Dijkstra"],
  ["If debugging is the process of removing bugs, then programming must be the process of putting them in.", "Edsger W. Dijkstra"],
  ["The Analytical Engine weaves algebraical patterns just as the Jacquard loom weaves flowers and leaves.", "Ada Lovelace"],
  ["We can only see a short distance ahead, but we can see plenty there that needs to be done.", "Alan Turing"],
  ["Those who can imagine anything, can create the impossible.", "Alan Turing"],
  ["The most dangerous phrase in the language is: we\u2019ve always done it this way.", "Grace Hopper"],
  ["The best way to predict the future is to invent it.", "Alan Kay"],
  ["Premature optimization is the root of all evil.", "Donald Knuth"],
  ["Talk is cheap. Show me the code.", "Linus Torvalds"],
  ["Controlling complexity is the essence of computer programming.", "Brian Kernighan"],
  ["Any sufficiently advanced technology is indistinguishable from magic.", "Arthur C. Clarke"],
  ["Information is the resolution of uncertainty.", "Claude Shannon"],
];
{
  const [text, author] = quotes[Math.floor(Math.random() * quotes.length)];
  document.getElementById("quote").textContent = text;
  document.getElementById("qauthor").textContent = "\u2014 " + author;
}
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
// Instead, clear scrollback when tmux activates alt screen (window switch).
// This prevents content from other windows accumulating in the buffer.
const buffers = term._core._bufferService.buffers;
buffers.activateAltBuffer = () => {
  term.clear();
  term.scrollToBottom();
};
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

  // ── Debounced reveal: wait for data to settle, then show terminal ──────
  let revealTimer = null;
  function scheduleReveal() {
    if (!loadquote || !loadquote.parentNode) return;
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      term.scrollToBottom();
      loadquote.style.opacity = '0';
      setTimeout(() => { if (loadquote.parentNode) loadquote.remove(); }, 300);
    }, 800);
  }

  function connect() {
    ws = new WebSocket(`${wsProto}://${location.host}/ws/${encodeURIComponent(session)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { sendResize(); refreshPanes(); };
    ws.onmessage = async (ev) => {
      if (typeof ev.data === "string") term.write(ev.data);
      else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
      else if (ev.data instanceof Blob) term.write(new Uint8Array(await ev.data.arrayBuffer()));
      scheduleReveal();
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
  // scrollToBottom is now handled by scheduleReveal()
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
var gesture = null;
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

  function getLineHeight() {
    return term._core._renderService.dimensions?.css?.cell?.height || 18;
  }

  let startX, startY, startTime;
  let lastY, lastTime;
  gesture = null;
  let posSamples;
  let momId = null;
  let lastTapTime = 0;
  let pinchStartDist = 0;
  let pinchStartFontSize = 0;
  let wasTwoFinger = false;

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
      const fdx = e.touches[0].pageX - e.touches[1].pageX;
      const fdy = e.touches[0].pageY - e.touches[1].pageY;
      pinchStartDist = Math.hypot(fdx, fdy);
      pinchStartFontSize = term.options.fontSize;
      startY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
      gesture = 'two';
      wasTwoFinger = true;
      return;
    }
    if (e.touches.length !== 1) { gesture = null; return; }
    wasTwoFinger = false;
    const t = e.touches[0];
    startX = t.pageX; startY = t.pageY;
    lastY = t.pageY;
    startTime = lastTime = performance.now();
    gesture = 'tap';
    posSamples = [{ y: t.pageY, t: startTime }];
  });

  overlay.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && (gesture === 'two' || gesture === 'pinch' || gesture === 'twopull')) {
      const fdx = e.touches[0].pageX - e.touches[1].pageX;
      const fdy = e.touches[0].pageY - e.touches[1].pageY;
      const dist = Math.hypot(fdx, fdy);
      const midY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
      const pull = midY - startY;
      const scale = pinchStartDist > 0 ? dist / pinchStartDist : 1;

      if (gesture === 'two') {
        // Competing classifier: compare normalized pinch vs pull signals.
        // scaleAmount: how much fingers moved apart/together (0 = none)
        // pullAmount: how far midpoint drifted, normalized to finger spread
        //   so it's comparable to scaleAmount
        const scaleAmount = Math.abs(scale - 1.0);
        const pullAmount = pinchStartDist > 0 ? Math.abs(pull) / pinchStartDist : 0;

        // Need a minimum signal before locking — prevents jitter from locking too early
        // Use 3% of viewport height as deadzone (scales with device size)
        const deadzone = window.innerHeight * 0.03;
        if (scaleAmount < 0.08 && Math.abs(pull) < deadzone) return; // still undecided

        // Whichever signal is stronger wins
        if (scaleAmount >= pullAmount) gesture = 'pinch';
        else gesture = 'twopull';
      }

      if (gesture === 'pinch') {
        const newSize = Math.round(Math.max(8, Math.min(32, pinchStartFontSize * scale)));
        if (newSize !== term.options.fontSize) {
          term.options.fontSize = newSize;
          sendResize();
        }
      }

      if (gesture === 'twopull') {
        // Visual feedback — thresholds relative to viewport height
        const vh = window.innerHeight;
        if (pull > vh * 0.08) {
          paneIndicator.textContent = '↻ Release to reload';
        } else if (pull > vh * 0.03) {
          paneIndicator.textContent = '↓ Pull to reload...';
        }
      }
      return;
    }
    // Single-finger — skip if was two-finger (ghost events after lifting one finger)
    if (e.touches.length !== 1 || !gesture || wasTwoFinger) return;
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
    if (gesture === 'two') { gesture = null; return; }
    if (gesture === 'pinch') { gesture = null; return; }
    if (gesture === 'twopull') {
      // Check if two-finger pull down was far enough
      const endY = e.changedTouches[0]?.pageY ?? startY;
      const dy = endY - startY;
      if (dy > window.innerHeight * 0.08) {
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
        // Swipe left = next window, swipe right = previous window
        // Send tmux prefix + n/p directly instead of tracking index
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(dx < 0 ? "\x02n" : "\x02p");
          term.clear();
          term.scrollToBottom();
          setTimeout(refreshPanes, 300);
        }
      }
    }
    gesture = null;
  });

  overlay.addEventListener('touchcancel', () => { stopMom(); gesture = null; });
}

// ── Command pick list (long-press) ──────────────────────────────────
{
  const cmdPickList = document.getElementById('cmdPickList');
  const cmdOverlayBg = document.getElementById('cmdOverlayBg');
  const cmdCloseBtn = document.getElementById('cmdCloseBtn');

  function showCmdList() {
    cmdPickList.classList.add('visible');
    cmdOverlayBg.classList.add('visible');
    overlay.style.pointerEvents = 'none';
  }

  function hideCmdList() {
    cmdPickList.classList.remove('visible');
    cmdOverlayBg.classList.remove('visible');
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      overlay.style.pointerEvents = 'auto';
    }
  }

  const WINDOW_SWITCH_CMDS = new Set(['next-window', 'prev-window', 'new-window', 'kill-window']);

  async function runTmuxCmd(command) {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session)}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch (e) {}
    if (WINDOW_SWITCH_CMDS.has(command)) {
      term.clear();
      term.scrollToBottom();
    }
    setTimeout(refreshPanes, 300);
  }

  // Event delegation for command items
  cmdPickList.addEventListener('click', (e) => {
    const item = e.target.closest('[data-cmd]');
    if (item) {
      runTmuxCmd(item.dataset.cmd);
      hideCmdList();
    }
  });

  cmdCloseBtn.addEventListener('click', hideCmdList);
  cmdOverlayBg.addEventListener('click', hideCmdList);

  // Long-press on touch overlay (separate listeners, passive)
  let lpTimer = null;
  let lpStartX = 0, lpStartY = 0;

  overlay.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { clearTimeout(lpTimer); lpTimer = null; return; }
    lpStartX = e.touches[0].pageX;
    lpStartY = e.touches[0].pageY;
    lpTimer = setTimeout(() => {
      lpTimer = null;
      if (navigator.vibrate) navigator.vibrate(30);
      showCmdList();
      // Cancel the main gesture so touchend doesn't fire tap/scroll
      gesture = null;
    }, 600);
  }, { passive: true });

  overlay.addEventListener('touchmove', (e) => {
    if (!lpTimer) return;
    if (e.touches.length !== 1) { clearTimeout(lpTimer); lpTimer = null; return; }
    const dx = Math.abs(e.touches[0].pageX - lpStartX);
    const dy = Math.abs(e.touches[0].pageY - lpStartY);
    if (dx > 12 || dy > 12) { clearTimeout(lpTimer); lpTimer = null; }
  }, { passive: true });

  overlay.addEventListener('touchend', () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  }, { passive: true });

  overlay.addEventListener('touchcancel', () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  }, { passive: true });
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
