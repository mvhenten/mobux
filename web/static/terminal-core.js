// Aceterm-backed TerminalCore — exposes the same shape as the
// xterm.js-backed version on `main` so the rest of mobux (gestures,
// input bar, view toggle, reader, smoke tests) doesn't need to know
// which renderer is underneath.
//
// Spike-only: lives on the `spike-aceterm` branch and is wired in
// through render_terminal_page on that branch's mobux. The buffer
// adapter is intentionally minimal — enough for live rendering and
// the input/scroll/window-switch tests; reader-side cell-detail
// access (per-glyph fg/bg, `getCell`) is shimmed and several reader
// tests are expected to fail until libterm's cell store is mapped
// onto an xterm-like Cell API.

// `window.__Aceterm` is populated by aceterm.bundle.js (loaded as a
// classic <script> in render_terminal_page before this module runs).
const Aceterm = window.__Aceterm;
if (!Aceterm) {
  throw new Error('aceterm bundle not loaded — check vendor/aceterm.bundle.js script tag');
}

const WINDOW_SWITCH_CMDS = new Set([
  'next-window', 'prev-window', 'new-window', 'kill-window',
]);

export class TerminalCore extends EventTarget {
  constructor({ session, host }) {
    super();
    this.session = session;
    this.host = host;

    this.ws = null;
    this.panes = [];
    this.activeIndex = 0;
    this.oscMarkers = new Map();
    this.oscDetected = false;

    this.term = makeAcetermAdapter(host, (data) => this.send(data));
    this._wireWriteParsedFanout();
    this._wireOsc133();
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────
  connect() {
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(
      `${wsProto}://${location.host}/ws/${encodeURIComponent(this.session)}`,
    );
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.resize();
      this.refreshPanes();
      this.dispatchEvent(new Event('open'));
    };
    this.ws.onmessage = async (ev) => {
      let bytes;
      if (typeof ev.data === 'string') {
        this.term.write(ev.data);
        bytes = ev.data;
      } else if (ev.data instanceof ArrayBuffer) {
        const u8 = new Uint8Array(ev.data);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
        this.term.write(text);
        bytes = u8;
      } else if (ev.data instanceof Blob) {
        const u8 = new Uint8Array(await ev.data.arrayBuffer());
        const text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
        this.term.write(text);
        bytes = u8;
      }
      this.dispatchEvent(new CustomEvent('data', { detail: bytes }));
    };
    this.ws.onclose = () => {};
    this.ws.onerror = () => {};
  }

  reconnect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws) { try { this.ws.close(); } catch (_) {} }
    this.connect();
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ── Resize ────────────────────────────────────────────────────────
  resize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cell = this.cellSize();
    const bar = document.getElementById('inputBar');
    const barHeight = (bar && !bar.classList.contains('hidden')) ? bar.offsetHeight : 0;
    const pad = this._horizontalPadding();
    const cols = Math.max(20, Math.floor((window.innerWidth - pad) / cell.width) - 1);
    const rows = Math.max(10, Math.floor((window.innerHeight - barHeight) / cell.height) - 1);
    this.term.resize(cols, rows);
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  _horizontalPadding() {
    try {
      const cs = getComputedStyle(this.host);
      return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    } catch (_) {
      return 0;
    }
  }

  cellSize() {
    const r = this.term._editor && this.term._editor.renderer;
    if (r && r.characterWidth && r.lineHeight) {
      return { width: r.characterWidth, height: r.lineHeight };
    }
    return { width: 9, height: 18 };
  }

  // ── Buffer / scroll passthroughs ──────────────────────────────────
  getActiveBuffer() { return this.term.buffer.active; }
  scrollLines(n)    { this.term.scrollLines(n); }
  scrollToBottom()  { this.term.scrollToBottom(); }
  clear()           { this.term.clear(); }

  setFontSize(px) {
    if (px !== this.term.options.fontSize) {
      this.term.options.fontSize = px;
      const ed = this.term._editor;
      if (ed) ed.setFontSize(px);
      this.resize();
    }
  }
  getFontSize() { return this.term.options.fontSize; }

  // ── Panes (= tmux windows) ────────────────────────────────────────
  async refreshPanes() {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(this.session)}/panes`);
      if (!res.ok) return;
      this.panes = await res.json();
      this.activeIndex = this.panes.findIndex((p) => p.active);
      if (this.activeIndex < 0) this.activeIndex = 0;
      this.dispatchEvent(new CustomEvent('panes', {
        detail: { panes: this.panes, activeIndex: this.activeIndex },
      }));
    } catch (_) {}
  }

  switchWindow(direction) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send(direction === 'next' ? '\x02n' : '\x02p');
    this.clear();
    this.scrollToBottom();
    setTimeout(async () => {
      await this.refreshPanes();
      await this.reloadHistory();
      this._forceRedraw();
    }, 300);
  }

  _forceRedraw() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cell = this.cellSize();
    const bar = document.getElementById('inputBar');
    const barHeight = (bar && !bar.classList.contains('hidden')) ? bar.offsetHeight : 0;
    const pad = this._horizontalPadding();
    const cols = Math.max(20, Math.floor((window.innerWidth - pad) / cell.width) - 1);
    const rows = Math.max(10, Math.floor((window.innerHeight - barHeight) / cell.height) - 1);
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows: Math.max(2, rows - 1) }));
    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.term.resize(cols, rows);
      this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }, 50);
  }

  async runTmuxCmd(command) {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(this.session)}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch (_) {}
    if (WINDOW_SWITCH_CMDS.has(command)) {
      this.clear();
      this.scrollToBottom();
    }
    setTimeout(() => { this.refreshPanes(); this.reloadHistory(); }, 300);
  }

  async reloadHistory() {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(this.session)}/history`);
      if (!res.ok) return;
      const history = await res.text();
      if (history.trim()) {
        this.term.write(history.replace(/\n/g, '\r\n'));
        this.scrollToBottom();
        this.dispatchEvent(new CustomEvent('history', { detail: history }));
      }
    } catch (_) {}
  }

  _wireWriteParsedFanout() {
    if (this.term._libterm && this.term._libterm.on) {
      this.term._libterm.on('refresh', () => {
        for (const cb of this.term._writeParsedSubs) cb();
      });
    }
  }

  _wireOsc133() {
    // libterm's patched OSC dispatcher invokes handleOsc133 on every
    // `OSC 133 ; X ST`. Same shape as the xterm-side handler in
    // main: A/B mark prompts, record kind by absolute buffer row.
    this.term._libterm.handleOsc133 = (data) => {
      const kind = (data || '').charAt(0);
      if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return;
      const lt = this.term._libterm;
      const absY = (lt.ybase || 0) + (lt.y || 0);
      this.oscMarkers.set(absY, kind);
      if (!this.oscDetected) {
        this.oscDetected = true;
        this.dispatchEvent(new Event('osc-detected'));
      }
    };
  }
}

// ── libterm + Ace adapter ─────────────────────────────────────────
function makeAcetermAdapter(host, sendCb) {
  const initialCols = 120, initialRows = 35;
  const libterm = Aceterm(initialCols, initialRows, sendCb);
  const editor = Aceterm.createEditor(host, null);
  editor.setSession(libterm.aceSession);
  editor.renderer.setShowGutter(false);
  editor.renderer.setShowPrintMargin(false);
  editor.setFontSize(13);
  editor.setOption('fontFamily',
    "'SF Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', monospace");
  host.style.height = '100%';
  host.style.width = '100%';

  attachTouchScroll(editor, host);

  // The smoke suite (and a few CSS selectors in mobux itself) reach
  // for xterm.js's class names. Alias them onto Ace's structurally
  // equivalent elements so existing assertions about visibility /
  // scrolling don't have to know which renderer is mounted.
  // Wait one frame for Ace to mount its layers.
  setTimeout(() => {
    try {
      // .ace_scroller hosts the rendered text grid and is the scrolling
      // viewport — same role as xterm's .xterm-viewport / .xterm-screen.
      const scroller = host.querySelector('.ace_scroller');
      if (scroller) {
        scroller.classList.add('xterm-viewport', 'xterm-screen');
      }
      const text = host.querySelector('.ace_text-layer');
      if (text) text.classList.add('xterm-rows');
    } catch (_) {}
  }, 0);

  const writeParsedSubs = [];
  const dataSubs = [];

  // OSC 133 stub — libterm's parser doesn't surface OSC 133, so the
  // map stays empty and the reader's "shell integration not detected"
  // hint stays visible (accurate for now).
  const parser = {
    registerOscHandler(_id, _cb) {
      return { dispose() {} };
    },
  };

  return {
    _libterm: libterm,
    _editor: editor,
    _writeParsedSubs: writeParsedSubs,
    _dataSubs: dataSubs,
    options: { fontSize: 13 },
    parser,

    get cols() { return libterm.cols; },
    get rows() { return libterm.rows; },

    write(data, cb) {
      libterm.write(typeof data === 'string'
        ? data
        : new TextDecoder().decode(data));
      if (typeof cb === 'function') queueMicrotask(cb);
    },
    resize(cols, rows) { libterm.resize(cols, rows); },
    clear() { libterm.clear && libterm.clear(); },
    scrollToBottom() {
      try { editor.session.setScrollTop(-1); } catch (_) {}
    },
    scrollLines(n) {
      const r = editor.renderer;
      r.session.setScrollTop(r.getScrollTop() + n * r.lineHeight);
    },

    onWriteParsed(cb) {
      writeParsedSubs.push(cb);
      return { dispose() {
        const i = writeParsedSubs.indexOf(cb);
        if (i >= 0) writeParsedSubs.splice(i, 1);
      } };
    },
    onData(cb) {
      dataSubs.push(cb);
      return { dispose() {
        const i = dataSubs.indexOf(cb);
        if (i >= 0) dataSubs.splice(i, 1);
      } };
    },

    buffer: {
      get active() {
        return makeBufferAdapter(libterm);
      },
    },
  };
}

function makeBufferAdapter(lt) {
  return {
    get length() {
      return Math.max(lt.lines ? lt.lines.length : 0, lt.rows + (lt.ybase || 0));
    },
    get cursorX() { return lt.x || 0; },
    get cursorY() { return lt.y || 0; },
    get baseY() { return lt.ybase || 0; },
    get viewportY() { return lt.ybase || 0; },
    getLine(y) {
      if (!lt.lines || !lt.lines[y]) return null;
      return makeLineAdapter(lt.lines[y]);
    },
  };
}

// libterm packs each cell as `[attrInt, ch]` where attrInt is:
//   bits  0..8  bg colour (256 = default)
//   bits  9..17 fg colour (257 = default)
//   bit   18    bold
//   bit   19    underline
//   bit   20    inverse
// (no italic, no dim, no truecolour — libterm is palette-only.)
const LT_BG_DEFAULT = 256;
const LT_FG_DEFAULT = 257;

function makeLineAdapter(cells) {
  const text = cells.map((c) => (Array.isArray(c) ? c[1] : (c && c.ch) || '')).join('');
  return {
    isWrapped: false,
    translateToString(_trim) { return text; },
    getCell(x) {
      const c = cells[x];
      const attr = Array.isArray(c) ? c[0] : 0;
      const ch = Array.isArray(c) ? c[1] : (c && c.ch) || ' ';
      const bg = attr & 0x1ff;
      const fg = (attr >> 9) & 0x1ff;
      const flags = attr >> 18;
      const isFgDef = fg === LT_FG_DEFAULT;
      const isBgDef = bg === LT_BG_DEFAULT;
      return {
        getChars() { return ch; },
        getCode() { return ch ? ch.codePointAt(0) || 0 : 0; },
        // libterm is palette-only; never RGB.
        isFgRGB() { return false; },
        isBgRGB() { return false; },
        isFgPalette() { return !isFgDef; },
        isBgPalette() { return !isBgDef; },
        isFgDefault() { return isFgDef; },
        isBgDefault() { return isBgDef; },
        getFgColor() { return isFgDef ? -1 : fg; },
        getBgColor() { return isBgDef ? -1 : bg; },
        getFgColorMode() { return isFgDef ? 0 : 0x100; },
        getBgColorMode() { return isBgDef ? 0 : 0x100; },
        isBold()       { return !!(flags & 1); },
        isUnderline()  { return !!(flags & 2); },
        isInverse()    { return !!(flags & 4); },
        // libterm doesn't track these — surface as off so the
        // reader doesn't render them differently from the canvas.
        isItalic()     { return false; },
        isDim()        { return false; },
      };
    },
  };
}

// Ace's MouseHandler treats touchmove as drag-select on mobile —
// finger-scroll the buffer and Ace highlights blocks of text instead
// of moving the viewport. Pre-empt every touch event on the editor
// container, translate vertical drag into renderer scroll, and
// stopPropagation so Ace never sees it.
function attachTouchScroll(editor, host) {
  let lastY = null;
  let activeId = null;

  const onStart = (e) => {
    if (e.touches.length !== 1) { activeId = null; return; }
    activeId = e.touches[0].identifier;
    lastY = e.touches[0].clientY;
  };
  const onMove = (e) => {
    if (activeId == null) return;
    let t = null;
    for (const tt of e.touches) if (tt.identifier === activeId) { t = tt; break; }
    if (!t) return;
    const dy = lastY - t.clientY;
    lastY = t.clientY;
    if (Math.abs(dy) > 0) {
      const r = editor.renderer;
      const top = r.getScrollTop();
      r.session.setScrollTop(top + dy);
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const onEnd = () => { activeId = null; lastY = null; };

  host.addEventListener('touchstart', onStart, { capture: true, passive: false });
  host.addEventListener('touchmove', onMove, { capture: true, passive: false });
  host.addEventListener('touchend', onEnd, { capture: true, passive: true });
  host.addEventListener('touchcancel', onEnd, { capture: true, passive: true });
}
