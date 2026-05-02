import { TerminalCore } from './terminal-core.js';
import { ReaderView } from './reader-view.js';
import { createGestureRecognizer } from './touch.js';
import { createInputBar } from './input-bar.js';

const session = window.MOBUX_SESSION;
const termEl = document.getElementById("terminal");
const readerEl = document.getElementById("reader");
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

// ── Core ────────────────────────────────────────────────────────────
const isMobile = window.innerWidth < 620;
const core = new TerminalCore({ session, host: termEl, isMobile });

// Enable overlay for touch devices
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  overlay.style.pointerEvents = 'auto';
}

// ── Pane indicator ──────────────────────────────────────────────────
function updatePaneUI() {
  const { panes, activeIndex } = core;
  if (panes.length <= 1) {
    paneIndicator.textContent = panes.length === 1 ? panes[0].title : "";
  } else {
    const current = panes[activeIndex];
    paneIndicator.textContent = `${current ? current.title : "?"} (${activeIndex + 1}/${panes.length})`;
  }
}
core.addEventListener('panes', updatePaneUI);

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
  if (item) { core.runTmuxCmd(item.dataset.cmd); hideCmdList(); }
});
cmdCloseBtn.addEventListener('click', hideCmdList);
cmdOverlayBg.addEventListener('click', hideCmdList);

// ── Touch gestures ──────────────────────────────────────────────────
function scrollByPixels(dy) {
  const lines = Math.round(dy / core.cellSize().height);
  if (lines !== 0) core.scrollLines(lines);
}

createGestureRecognizer(overlay, {
  onScroll: scrollByPixels,
  onReconnect: () => core.reconnect(),
  getFontSize: () => core.getFontSize(),

  onPinch(scale, startSize) {
    const newSize = Math.round(Math.max(8, Math.min(32, startSize * scale)));
    core.setFontSize(newSize);
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
    const cell = core.cellSize();
    const rect = termEl.getBoundingClientRect();
    const col = Math.floor((x - rect.left) / cell.width);
    const row = Math.floor((y - rect.top) / cell.height);
    const buffer = core.getActiveBuffer();
    const bufferRow = buffer.viewportY + row;
    const line = buffer.getLine(bufferRow);
    if (!line) return;
    const text = line.translateToString(true);
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

  onHSwipe: (dir) => core.switchWindow(dir),

  onLongPress: showCmdList,
});

// ── Reveal on first output ──────────────────────────────────────────
let revealTimer = null;
function scheduleReveal() {
  if (!loadquote || !loadquote.parentNode) return;
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    core.scrollToBottom();
    loadquote.style.opacity = '0';
    setTimeout(() => { if (loadquote.parentNode) loadquote.remove(); }, 300);
  }, 800);
}
core.addEventListener('data', scheduleReveal);

// ── Mobile input bar ────────────────────────────────────────────────
let inputBar = null;
if (isMobile) {
  inputBar = createInputBar(core.term, (d) => core.send(d));
}

// ── View swap (xterm <-> reader) ────────────────────────────────────
const reader = new ReaderView({ host: readerEl, core, overlay });
let currentView = 'xterm';

function swapView(mode) {
  if (mode !== 'xterm' && mode !== 'reader') return;
  if (mode === currentView) return;
  if (mode === 'reader') {
    termEl.classList.add('hidden');
    reader.mount();
  } else {
    reader.unmount();
    termEl.classList.remove('hidden');
    setTimeout(() => core.resize(), 0);
  }
  currentView = mode;
  try { localStorage.setItem('mobux.view.default', mode); } catch (_) {}
  window.dispatchEvent(new CustomEvent('mobux:viewchange', { detail: mode }));
}

window.__mobuxView = {
  swap: swapView,
  get current() { return currentView; },
};

// Apply persisted preference (devtools-only entry point for now;
// long-press menu toggle lands in the next commit)
try {
  const stored = localStorage.getItem('mobux.view.default');
  if (stored === 'reader') {
    // defer so the buffer has content to render
    setTimeout(() => swapView('reader'), 200);
  }
} catch (_) {}

// ── Boot ────────────────────────────────────────────────────────────
(async () => {
  await core.reloadHistory();
  core.connect();
})();

window.addEventListener("resize", () => core.resize());
setTimeout(() => core.resize(), 100);
setInterval(() => core.refreshPanes(), 5000);
