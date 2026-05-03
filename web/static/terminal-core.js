// TerminalCore — owns the xterm.js Terminal, the WebSocket to the tmux PTY,
// resize math, history reload and the pane (window) list. No DOM concerns
// beyond the host element passed in; no gesture or input-bar code. This is
// the data plane that any view layer (xterm, reader, …) plugs into.

const WINDOW_SWITCH_CMDS = new Set([
  'next-window', 'prev-window', 'new-window', 'kill-window',
]);

export class TerminalCore extends EventTarget {
  constructor({ session, host }) {
    super();
    this.session = session;
    this.host = host;

    this.term = new Terminal({
      cursorBlink: true,
      // Match the reader's typography (style.css `.rb-line`): same
      // mono stack, same 13px font, line-height bumped from xterm's
      // default 1.0 to 1.25 for a bit of breathing room. Toggling
      // between xterm and reader views now reads as the same content
      // in the same font, just laid out differently.
      fontFamily: "'SF Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      // Try to match the reader's lighter look. If Roboto Mono on
      // Android lacks a 300 face, Chromium will faux-thin; if it
      // keeps drawing 400, no harm done. Drop this back to 'normal'
      // if the result looks weird.
      fontWeight: 300,
      convertEol: false,
      scrollback: 10000,
      theme: { background: '#0f1115' },
    });
    this.term.open(host);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon());

    // Lock mouse protocol to NONE — prevents xterm.js from capturing
    // touch/mouse when tmux sends \x1b[?1000h
    Object.defineProperty(this.term._core.coreMouseService, 'activeProtocol', {
      set() {}, get() { return 'NONE'; }, configurable: true,
    });

    // Block alternate screen buffer — tmux alt screen has no scrollback
    const buffers = this.term._core._bufferService.buffers;
    buffers.activateAltBuffer = () => {};
    buffers.activateNormalBuffer = () => {};

    this.ws = null;
    this.panes = [];
    this.activeIndex = 0;

    // OSC 133 (FinalTerm / shell-integration) markers, by absolute
    // buffer row. Shells that opt in emit:
    //   ESC ] 133 ; A ST     prompt start  (the line is a prompt)
    //   ESC ] 133 ; B ST     prompt end / command line follows
    //   ESC ] 133 ; C ST     command output starts on the next row
    //   ESC ] 133 ; D[;N] ST command ended (optional exit code)
    // The reader uses these to classify lines deterministically
    // instead of guessing at sigils. `oscDetected` flips true on the
    // first marker so the UI can stop showing the setup hint.
    this.oscMarkers = new Map();
    this.oscDetected = false;
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
      return true;
    });

    this.term.onData((d) => this.send(d));
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
        this.term.write(u8);
        bytes = u8;
      } else if (ev.data instanceof Blob) {
        const u8 = new Uint8Array(await ev.data.arrayBuffer());
        this.term.write(u8);
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
    // #terminal has horizontal padding (style.css). Subtract it so
    // xterm doesn't overrun the inner content box and shave a column
    // off the right edge.
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
    const dims = this.term._core._renderService.dimensions?.css?.cell;
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
      // tmux paints the visible region (including its status row) in
      // response to C-b n/p, but reloadHistory above writes scrollback
      // *after* that paint, displacing the status row. Provoke a fresh
      // tmux redraw so the status row reappears on the last visible
      // line. A no-op TIOCSWINSZ doesn't fire SIGWINCH, so nudge rows
      // by one and back.
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
