import { TerminalCore } from './terminal-core.js';
import { createGestureRecognizer } from './touch.js';
import { createInputBar } from './input-bar.js';
import { applyTheme, getStoredThemeId } from './themes.js';

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
  ["The most dangerous phrase in the language is: we’ve always done it this way.", "Grace Hopper"],
  ["The best way to predict the future is to invent it.", "Alan Kay"],
  ["Premature optimization is the root of all evil.", "Donald Knuth"],
  ["Talk is cheap. Show me the code.", "Linus Torvalds"],
  ["Controlling complexity is the essence of computer programming.", "Brian Kernighan"],
  ["Any sufficiently advanced technology is indistinguishable from magic.", "Arthur C. Clarke"],
  ["Information is the resolution of uncertainty.", "Claude Shannon"],
  ["Looking back, we were the luckiest people in the world; there was no choice but to be pioneers.", "Margaret Hamilton"],

  // Contemporary craft
  ["Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", "Martin Fowler"],
  ["Truth can only be found in one place: the code.", "Robert C. Martin"],
  ["I'm not a great programmer; I'm just a good programmer with great habits.", "Kent Beck"],
  ["Duplication is far cheaper than the wrong abstraction.", "Sandi Metz"],
  ["It's harder to read code than to write it.", "Joel Spolsky"],
  ["I call it my billion-dollar mistake.", "Tony Hoare, on null"],
  ["Programmers know the value of everything and the cost of nothing.", "Rich Hickey"],
  ["Fancy algorithms are slow when n is small, and n is usually small.", "Rob Pike"],
  ["There are only two kinds of programming languages: the ones people complain about and the ones nobody uses.", "Bjarne Stroustrup"],
  ["Ruby is designed to make programmers happy.", "Yukihiro Matsumoto"],
  ["The three chief virtues of a programmer are: laziness, impatience, and hubris.", "Larry Wall"],
  ["If you're not failing every now and again, it's a sign you're not doing anything very innovative.", "John Carmack"],
];
{
  const [text, author] = quotes[Math.floor(Math.random() * quotes.length)];
  document.getElementById("quote").textContent = text;
  document.getElementById("qauthor").textContent = "— " + author;
}

// ── External links ──────────────────────────────────────────────────
// In a TWA (Trusted Web Activity, package id `io.github.mvhenten.mobux`),
// `window.open(url, '_blank')` from JS keeps the navigation inside the
// underlying Chrome that powers the TWA — visually it still looks like
// the user is "in mobux". Clicking a synthesised anchor with
// `target="_blank" rel="noopener noreferrer"` triggers Chrome Custom
// Tabs handoff for out-of-scope URLs (i.e. anything not on the trusted
// origin), which is the documented escape hatch.
//
// On the desktop / regular browser this is identical to a normal
// new-tab open.
function openExternal(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // Anchor must be in the DOM for the synthetic click to navigate
  // reliably across browsers.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
// Expose for smoke tests (mirrors `window.__mobuxView` etc.).
window.__mobuxOpenExternal = openExternal;

// ── Core ────────────────────────────────────────────────────────────
const isMobile = window.innerWidth < 620;
const core = new TerminalCore({ session, host: termEl });

// Apply the stored theme (Ace editor + libterm palette).
applyTheme(getStoredThemeId(), { editor: core.term._editor });

// Live swap when the settings page (or another tab) changes the theme.
// `storage` only fires in OTHER documents — same-doc swaps go through
// `mobux:theme` (dispatched by the picker).
function onThemeChange() {
  applyTheme(getStoredThemeId(), { editor: core.term._editor });
}
window.addEventListener('storage', (e) => {
  if (e.key === 'mobux:theme') onThemeChange();
});
window.addEventListener('mobux:theme', onThemeChange);

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
  const cmdItem = e.target.closest('[data-cmd]');
  if (cmdItem) { core.runTmuxCmd(cmdItem.dataset.cmd); hideCmdList(); return; }
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
        openExternal(match[0]);
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
// Fire on the first `data` event, not on settle. The previous
// implementation reset an 800 ms timer per event, which never
// settled when the attached session pumped continuous output (e.g.
// a TUI like Claude Code), leaving the loading splash up forever.
let revealScheduled = false;
function scheduleReveal() {
  if (revealScheduled) return;
  if (!loadquote || !loadquote.parentNode) return;
  revealScheduled = true;
  setTimeout(() => {
    core.scrollToBottom();
    loadquote.style.opacity = '0';
    setTimeout(() => { if (loadquote.parentNode) loadquote.remove(); }, 300);
  }, 200);
}
core.addEventListener('data', scheduleReveal);

// ── Mobile input bar ────────────────────────────────────────────────
let inputBar = null;
if (isMobile) {
  inputBar = createInputBar(core.term, (d) => core.send(d));
}

// ── Test/debug peephole ─────────────────────────────────────────────
// Smoke tests reach in via window.__mobuxView.test.* to inject buffer
// content, drive scrolling, and check WS state without depending on a
// real PTY round-trip. Kept minimal — terminal is the only view now.
window.__mobuxView = {
  send: (d) => core.send(d),
  test: {
    inject: (str) => new Promise((resolve) =>
      core.term.write(str.replace(/\n/g, '\r\n'), resolve)),
    injectLines: (n, prefix = 'inject') => {
      let s = '';
      for (let i = 0; i < n; i++) s += `${prefix} ${i}\r\n`;
      return new Promise((resolve) => core.term.write(s, resolve));
    },
    bufferLength: () => core.getActiveBuffer().length,
    terminalRows: () => core.term.rows,
    viewportY: () => core.getActiveBuffer().viewportY,
    scrollToBottom: () => core.scrollToBottom(),
    wsReady: () => core.ws?.readyState === WebSocket.OPEN,
    switchWindow: (dir) => core.switchWindow(dir),
  },
};

// ── Boot ────────────────────────────────────────────────────────────
(async () => {
  await core.reloadHistory();
  core.connect();
})();

window.addEventListener("resize", () => core.resize());
setTimeout(() => core.resize(), 100);
setInterval(() => core.refreshPanes(), 5000);
