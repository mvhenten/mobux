// Xterm-backed TerminalCore — stable default renderer.
//
// Wraps @xterm/xterm (loaded via xterm.bundle.js, which pins
// `window.Terminal` and `window.WebLinksAddon`), owns the WebSocket,
// OSC 133 handling, tmux pane tracking, etc.
//
// Loaded only when `window.__mobuxRenderer === 'xterm'` (the default).
// Exposes the same external surface as terminal-core-sterk.js so
// consumers (terminal.js, reader-view.js, tests) use a single contract.

const WINDOW_SWITCH_CMDS = new Set([
  'next-window', 'prev-window', 'new-window', 'kill-window',
]);

export class TerminalCoreXterm extends EventTarget {
  constructor({ session, host }) {
    super();
    this.session = session;
    this.host = host;
    this.renderer = 'xterm';

    const Xterm = window.Terminal;
    const WebLinksAddon = window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
    if (!Xterm) {
      throw new Error('xterm bundle not loaded — check vendor/xterm.bundle.js script tag');
    }

    this.term = new Xterm({
      cursorBlink: true,
      // Match the reader's typography (style.css `.rb-line`): same
      // mono stack, same 13px font, line-height bumped from xterm's
      // default 1.0 to 1.25 for a bit of breathing room.
      fontFamily: "'SF Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      fontWeight: 300,
      convertEol: false,
      scrollback: 10000,
      theme: { background: '#0f1115' },
    });
    this.term.open(host);
    if (WebLinksAddon) {
      this.term.loadAddon(new WebLinksAddon());
    }

    // Lock mouse protocol to NONE — prevents xterm.js from capturing
    // touch/mouse when tmux sends \x1b[?1000h
    try {
      Object.defineProperty(this.term._core.coreMouseService, 'activeProtocol', {
        set() {}, get() { return 'NONE'; }, configurable: true,
      });
    } catch (_) {}

    // Block alternate screen buffer — tmux alt screen has no scrollback
    try {
      const buffers = this.term._core._bufferService.buffers;
      buffers.activateAltBuffer = () => {};
      buffers.activateNormalBuffer = () => {};
    } catch (_) {}

    this.ws = null;
    this.panes = [];
    this.activeIndex = 0;

    // Auto-reconnect state. `intentionalClose` guards the onclose
    // backoff so we don't reconnect after a deliberate teardown (page
    // unload, a `reconnect()` that closes a stale socket, or the test
    // `inject` helper closing the WS on purpose). Backoff caps the
    // retry interval so a server that's down doesn't get hammered.
    this.intentionalClose = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 0;
    this._reconnectMin = 500;
    this._reconnectMax = 10000;

    // OSC 133 (FinalTerm / shell-integration) markers.
    this.oscMarkers = new Map();
    this.oscDetected = false;
    if (this.term.parser && this.term.parser.registerOscHandler) {
      this.term.parser.registerOscHandler(133, (data) => {
        const kind = (data || '').charAt(0);
        if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return false;
        const buf = this.term.buffer.active;
        const absY = buf.baseY + buf.cursorY;
        this.oscMarkers.set(absY, kind);
        if (!this.oscDetected) {
          this.oscDetected = true;
          this.dispatchEvent(new Event('osc-detected'));
        }
        return false;
      });
    }

    this.term.onData((d) => this.send(d));

    // Debug peephole for tests / themes.js.
    if (typeof window !== 'undefined') {
      window.__xterm = this.term;
    }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────
  connect() {
    // A fresh connect attempt supersedes any pending backoff retry.
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.intentionalClose = false;
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(
      `${wsProto}://${location.host}/ws/${encodeURIComponent(this.session)}`,
    );
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      // A clean open resets the backoff window.
      this._reconnectDelay = 0;
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
        this.term.write(u8);
        bytes = u8;
      } else if (ev.data instanceof Blob) {
        const u8 = new Uint8Array(await ev.data.arrayBuffer());
        this.term.write(u8);
        bytes = u8;
      }
      this.dispatchEvent(new CustomEvent('data', { detail: bytes }));
    };
    this.ws.onclose = () => this._scheduleReconnect();
    this.ws.onerror = () => {};
  }

  // Schedule an auto-reconnect after an unexpected close, using capped
  // exponential backoff. No-ops on an intentional close so a deliberate
  // teardown (page unload, reconnect()'s own close, test injection)
  // doesn't trigger a reconnect loop.
  _scheduleReconnect() {
    if (this.intentionalClose) return;
    if (this._reconnectTimer !== null) return;
    this._reconnectDelay = this._reconnectDelay
      ? Math.min(this._reconnectDelay * 2, this._reconnectMax)
      : this._reconnectMin;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this._reconnectDelay);
  }

  reconnect() {
    // Idempotent: a socket that's already OPEN or still CONNECTING needs
    // no action. The CONNECTING guard also avoids a double-socket race
    // when an early `pageshow`/`visibilitychange` fires before boot's
    // own connect() has finished handshaking.
    if (this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
         this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.ws) {
      // Tear down the stale socket without arming the backoff — connect()
      // below opens a fresh one immediately.
      this.intentionalClose = true;
      try { this.ws.close(); } catch (_) {}
    }
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
    // Drive rows from the host's actual painted height, not from
    // `window.innerHeight`. On Android Chrome the layout viewport stays
    // at full screen when the soft keyboard opens, but the body is
    // shrunk to `visualViewport.height` by terminal.js's
    // visualViewport handler — so `#terminal` (a flex child) shrinks
    // too. Reading clientHeight here is what makes the row count
    // follow the keyboard. Falls back to window.innerHeight pre-flex
    // (initial paint where clientHeight may briefly be 0).
    const hostW = this.host.clientWidth || window.innerWidth;
    const hostH = this.host.clientHeight || window.innerHeight;
    // #terminal has horizontal padding (style.css). Subtract it so
    // xterm doesn't overrun the inner content box and shave a column
    // off the right edge.
    const pad = this._horizontalPadding();
    const cols = Math.max(20, Math.floor((hostW - pad) / cell.width) - 1);
    const rows = Math.max(10, Math.floor(hostH / cell.height) - 1);
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
    const dims = this.term._core?._renderService?.dimensions?.css?.cell;
    return { width: dims?.width || 9, height: dims?.height || 18 };
  }

  // ── Buffer / scroll passthroughs ──────────────────────────────────
  getActiveBuffer() { return this.term.buffer.active; }
  scrollLines(n)    { this.term.scrollLines(n); }
  scrollToBottom()  { this.term.scrollToBottom(); }
  clear()           { this.term.clear(); }

  setFontSize(px) {
    if (px !== this.term.options.fontSize) {
      this.term.options.fontSize = px;
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
    const hostW = this.host.clientWidth || window.innerWidth;
    const hostH = this.host.clientHeight || window.innerHeight;
    const pad = this._horizontalPadding();
    const cols = Math.max(20, Math.floor((hostW - pad) / cell.width) - 1);
    const rows = Math.max(10, Math.floor(hostH / cell.height) - 1);
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

  // ── History ───────────────────────────────────────────────────────
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
}
