import { createGestureRecognizer } from './touch.js';
import { createInputBar } from './input-bar.js';

const session = window.MOBUX_SESSION;
const termEl = document.getElementById("terminal");
const overlay = document.getElementById("touchOverlay");
const loadquote = document.getElementById("loadquote");
const paneIndicator = document.getElementById("paneIndicator");
const cmdPickList = document.getElementById("cmdPickList");
const cmdOverlayBg = document.getElementById("cmdOverlayBg");
const cmdCloseBtn = document.getElementById("cmdCloseBtn");

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

// ── Terminal setup ──────────────────────────────────────────────────
const isMobile = window.innerWidth < 620;
const term = new Terminal({
  cursorBlink: true,
  fontSize: isMobile ? 14 : 15,
  convertEol: false,
  scrollback: 10000,
  theme: { background: "#0f1115" },
});
term.open(termEl);
term.loadAddon(new WebLinksAddon.WebLinksAddon());

// Lock mouse protocol to NONE — prevents xterm.js from capturing
// touch/mouse when tmux sends \x1b[?1000h
Object.defineProperty(term._core.coreMouseService, 'activeProtocol', {
  set() {}, get() { return 'NONE'; }, configurable: true,
});

// Block alternate screen buffer — tmux alt screen has no scrollback
const buffers = term._core._bufferService.buffers;
buffers.activateAltBuffer = () => {};
buffers.activateNormalBuffer = () => {};

// Enable overlay for touch devices
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  overlay.style.pointerEvents = 'auto';
}

// ── WebSocket connection ────────────────────────────────────────────
const wsProto = location.protocol === "https:" ? "wss" : "ws";
let ws;

function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cw = term._core._renderService.dimensions?.css?.cell?.width || 9;
  const ch = term._core._renderService.dimensions?.css?.cell?.height || 18;
  const barHeight = document.getElementById('inputBar')?.offsetHeight || 0;
  const cols = Math.max(20, Math.floor(window.innerWidth / cw) - 1);
  const rows = Math.max(10, Math.floor((window.innerHeight - barHeight) / ch) - 1);
  term.resize(cols, rows);
  ws.send(JSON.stringify({ type: "resize", cols, rows }));
}

function reconnect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws) { try { ws.close(); } catch(e) {} }
  connect();
}

// ── Pane management ─────────────────────────────────────────────────
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

function switchWindow(direction) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(direction === 'next' ? "\x02n" : "\x02p");
    term.clear();
    term.scrollToBottom();
    setTimeout(() => { refreshPanes(); reloadHistory(); }, 300);
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
  setTimeout(() => { refreshPanes(); reloadHistory(); }, 300);
}

// ── Command pick list ───────────────────────────────────────────────
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

cmdPickList.addEventListener('click', (e) => {
  const item = e.target.closest('[data-cmd]');
  if (item) { runTmuxCmd(item.dataset.cmd); hideCmdList(); }
});
cmdCloseBtn.addEventListener('click', hideCmdList);
cmdOverlayBg.addEventListener('click', hideCmdList);

// ── Scroll ──────────────────────────────────────────────────────────
function scrollByPixels(dy) {
  const cellHeight = term._core._renderService.dimensions?.css?.cell?.height || 18;
  const lines = Math.round(dy / cellHeight);
  if (lines !== 0) term.scrollLines(lines);
}

// ── Touch gestures (single state machine) ───────────────────────────
createGestureRecognizer(overlay, {
  onScroll: scrollByPixels,

  onReconnect: reconnect,

  getFontSize: () => term.options.fontSize,

  onPinch(scale, startSize) {
    const newSize = Math.round(Math.max(8, Math.min(32, startSize * scale)));
    if (newSize !== term.options.fontSize) {
      term.options.fontSize = newSize;
      sendResize();
    }
  },

  onTwoPullMove(pull, vh) {
    if (pull > vh * 0.08) paneIndicator.textContent = '↻ Release to reload';
    else if (pull > vh * 0.03) paneIndicator.textContent = '↓ Pull to reload...';
  },

  onTwoPullEnd(pull, vh) {
    if (pull > vh * 0.08) location.reload(true);
    else updatePaneUI();
  },

  onTap(x, y) {
    // Detect URLs in terminal text at tap position and open them.
    // WebLinksAddon uses hover-based links which don't work on mobile,
    // so we read the buffer text directly.
    const cellWidth = term._core._renderService.dimensions?.css?.cell?.width || 9;
    const cellHeight = term._core._renderService.dimensions?.css?.cell?.height || 18;
    const rect = termEl.getBoundingClientRect();
    const col = Math.floor((x - rect.left) / cellWidth);
    const row = Math.floor((y - rect.top) / cellHeight);
    const bufferRow = term.buffer.active.viewportY + row;
    const line = term.buffer.active.getLine(bufferRow);
    if (!line) return;
    const text = line.translateToString(true);
    // Find URL that spans the tapped column
    const urlRe = /https?:\/\/[^\s)"'>]+/g;
    let match;
    while ((match = urlRe.exec(text)) !== null) {
      if (col >= match.index && col < match.index + match[0].length) {
        window.open(match[0], '_blank', 'noopener');
        return;
      }
    }
  },

  onDoubleTap(x, y) {
    if (inputBar) {
      inputBar.show();
      return;
    }
    overlay.style.pointerEvents = 'none';
    setTimeout(() => { overlay.style.pointerEvents = 'auto'; }, 500);
    const el = document.elementFromPoint(x, y);
    if (el) {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    }
  },

  onHSwipe: switchWindow,

  onLongPress: showCmdList,
});

// ── History loading ─────────────────────────────────────────────────
async function reloadHistory() {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/history`);
    if (!res.ok) return;
    const history = await res.text();
    if (history.trim()) {
      // Prepend history above current viewport
      term.write(history.replace(/\n/g, '\r\n'));
      term.scrollToBottom();
    }
  } catch (e) {}
}

// ── Connect & reveal ────────────────────────────────────────────────
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

term.onData((d) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); });

// ── Mobile input bar ────────────────────────────────────────────────
let inputBar = null;
if (isMobile) {
  inputBar = createInputBar(term, (d) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
  });
}

(async () => {
  await reloadHistory();
  connect();
})();

window.addEventListener("resize", sendResize);
setTimeout(sendResize, 100);
setInterval(refreshPanes, 5000);

