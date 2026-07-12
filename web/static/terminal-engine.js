// The mobux terminal engine — one implementation, two renderers.
//
// The engine owns everything that is renderer-independent: the PTY
// WebSocket lifecycle, reconnect backoff, tmux pane tracking, tmux
// commands, history reload, and OSC 133 marker bookkeeping. It drives a
// renderer through the explicit interface below and never reaches into a
// renderer's internals. The two adapters (renderer-xterm.js,
// renderer-sterk.js) are the only code that knows which renderer is live.
//
// ── Renderer interface (the only crossing) ──────────────────────────────
// An adapter is a plain object exposing:
//
//   R1  dispose()
//   R2  write(data): Promise<void>            resolves once the buffer reflects data
//   R3  resize(cols, rows)
//       measure(): {cols, rows, cellWidth, cellHeight}   authoritative fit
//       cellSize(): {width, height}
//   R4  cols, rows                            current grid
//   R5  onInput(cb): Disposable               keystrokes / IME bound for the PTY
//   R6  scrollLines(n), scrollToBottom()
//   R7  buffer.active.{length,cursorX,cursorY,baseY,viewportY,getLine}
//   R8  onBufferChanged(cb): Disposable       fires after a write is parsed
//   R9  isAlternateScreenActive(): boolean
//   R10 registerOscHandler(id, cb): Disposable
//   R11 setTheme(theme); setFontSize(px); getFontSize()
//   R15 focus(); setNativeInputEnabled(bool)
//   R16 constructed with { altScreen: false }; the renderer suppresses
//       alternate-screen switching itself
//       clear()                              (engine housekeeping)
//
// The engine exposes the same surface consumers (terminal.js, reader-view.js)
// use: EventTarget events (open, close, data, panes, history, osc-detected),
// the connection/scroll/pane/tmux/history methods, and the interface
// passthroughs above.

import { openExternal } from "./external-link.js";

const WINDOW_SWITCH_CMDS = new Set([
  "next-window",
  "prev-window",
  "new-window",
  "kill-window",
]);

export class TerminalEngine extends EventTarget {
  // `node` (#176): the remote node this session lives on — every PTY/tmux
  // call carries ?node=<name> so the hub proxies it over SSH. "" ⇒ the local
  // host, exactly the pre-node behavior.
  constructor({ session, node, host, renderer, build }) {
    super();
    this.session = session;
    this.node = node || "";
    // `build` (#213 observability): the SPA's own loaded-bundle hash, ridden
    // through to the WS URL as `&build=<hash>` so a stale tab identifies itself
    // in the server's attach log. Purely diagnostic — never affects routing.
    this.build = build || "";
    this.host = host;
    this.renderer = renderer;

    this.ws = null;
    this.panes = [];
    this.activeIndex = 0;

    // Auto-reconnect state. `intentionalClose` guards the onclose backoff so
    // we don't reconnect after a deliberate teardown (page unload, a
    // reconnect() that closes a stale socket, or the test `inject` helper
    // closing the WS on purpose). Backoff caps the retry interval so a server
    // that's down doesn't get hammered.
    this.intentionalClose = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 0;
    this._reconnectMin = 500;
    this._reconnectMax = 10000;

    // OSC 133 (FinalTerm / shell-integration) markers.
    this.oscMarkers = new Map();
    this.oscDetected = false;

    this._oscSub = this.renderer.registerOscHandler(133, (data) => {
      const kind = (data || "").charAt(0);
      if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") {
        return false;
      }
      const buf = this.getActiveBuffer();
      const absY = (buf.baseY || 0) + (buf.cursorY || 0);
      this.oscMarkers.set(absY, kind);
      if (!this.oscDetected) {
        this.oscDetected = true;
        this.dispatchEvent(new Event("osc-detected"));
      }
      return false; // allow other handlers
    });

    this._inputSub = this.renderer.onInput((d) => this.send(d));
  }

  _nodeQuery() {
    return this.node ? `?node=${encodeURIComponent(this.node)}` : "";
  }

  // The WS URL carries `node` (routing) plus `build` (diagnostic only). The
  // /api/sessions calls keep `_nodeQuery()` — `build` is meaningful only for
  // the attach log, so it rides only the WS.
  _wsQuery() {
    const params = new URLSearchParams();
    if (this.node) params.set("node", this.node);
    if (this.build) params.set("build", this.build);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────
  connect() {
    // A fresh connect attempt supersedes any pending backoff retry.
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.intentionalClose = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(
      `${proto}://${location.host}/ws/${encodeURIComponent(this.session)}${this._wsQuery()}`,
    );
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      // A clean open resets the backoff window.
      this._reconnectDelay = 0;
      this.resize();
      this.refreshPanes();
      this.dispatchEvent(new Event("open"));
    };
    this.ws.onmessage = async (ev) => {
      let bytes;
      if (typeof ev.data === "string") {
        this.renderer.write(ev.data);
        bytes = ev.data;
      } else if (ev.data instanceof ArrayBuffer) {
        const u8 = new Uint8Array(ev.data);
        this.renderer.write(u8);
        bytes = u8;
      } else if (ev.data instanceof Blob) {
        const u8 = new Uint8Array(await ev.data.arrayBuffer());
        this.renderer.write(u8);
        bytes = u8;
      }
      this.dispatchEvent(new CustomEvent("data", { detail: bytes }));
    };
    this.ws.onclose = () => {
      this.dispatchEvent(new Event("close"));
      this._scheduleReconnect();
    };
    this.ws.onerror = () => {};
  }

  // Schedule an auto-reconnect after an unexpected close, using capped
  // exponential backoff. No-ops on an intentional close so a deliberate
  // teardown (page unload, reconnect()'s own close, test injection) doesn't
  // trigger a reconnect loop.
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
    // Idempotent: a socket that's already OPEN or still CONNECTING needs no
    // action. The CONNECTING guard also avoids a double-socket race when an
    // early pageshow/visibilitychange fires before boot's own connect() has
    // finished handshaking.
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (this.ws) {
      // Tear down the stale socket without arming the backoff — connect()
      // below opens a fresh one immediately.
      this.intentionalClose = true;
      try {
        this.ws.close();
      } catch (_) {}
    }
    this.connect();
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // Full teardown for a same-document remount (terminal.js dispose()): no
  // reconnect may survive, the socket closes, and the renderer releases its
  // DOM + internal listeners.
  dispose() {
    this.intentionalClose = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch (_) {}
    this.ws = null;
    try {
      this._oscSub?.dispose();
    } catch (_) {}
    try {
      this._inputSub?.dispose();
    } catch (_) {}
    try {
      this.renderer.dispose();
    } catch (_) {}
  }

  // ── Resize ────────────────────────────────────────────────────────
  resize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = this.renderer.measure();
    this.renderer.resize(cols, rows);
    this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  _forceRedraw() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = this.renderer.measure();
    this.ws.send(
      JSON.stringify({ type: "resize", cols, rows: Math.max(2, rows - 1) }),
    );
    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.renderer.resize(cols, rows);
      this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }, 50);
  }

  measure() {
    return this.renderer.measure();
  }

  cellSize() {
    return this.renderer.cellSize();
  }

  // ── Buffer / scroll passthroughs ──────────────────────────────────
  getActiveBuffer() {
    return this.renderer.buffer.active;
  }
  scrollLines(n) {
    this.renderer.scrollLines(n);
  }
  scrollToBottom() {
    this.renderer.scrollToBottom();
  }
  clear() {
    this.renderer.clear();
  }

  get cols() {
    return this.renderer.cols;
  }
  get rows() {
    return this.renderer.rows;
  }

  // ── Renderer interface passthroughs ───────────────────────────────
  write(data) {
    return this.renderer.write(data);
  }
  onBufferChanged(cb) {
    return this.renderer.onBufferChanged(cb);
  }
  isAlternateScreenActive() {
    return this.renderer.isAlternateScreenActive();
  }
  focus() {
    this.renderer.focus();
  }
  setNativeInputEnabled(enabled) {
    this.renderer.setNativeInputEnabled(enabled);
  }
  setTheme(theme) {
    this.renderer.setTheme(theme);
  }

  setFontSize(px) {
    if (px !== this.renderer.getFontSize()) {
      this.renderer.setFontSize(px);
      this.resize();
    }
  }
  getFontSize() {
    return this.renderer.getFontSize();
  }

  // ── Panes (= tmux windows) ────────────────────────────────────────
  async refreshPanes() {
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(this.session)}/panes${this._nodeQuery()}`,
      );
      if (!res.ok) return;
      this.panes = await res.json();
      this.activeIndex = this.panes.findIndex((p) => p.active);
      if (this.activeIndex < 0) this.activeIndex = 0;
      this.dispatchEvent(
        new CustomEvent("panes", {
          detail: { panes: this.panes, activeIndex: this.activeIndex },
        }),
      );
    } catch (_) {}
  }

  switchWindow(direction) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send(direction === "next" ? "\x02n" : "\x02p");
    this.clear();
    this.scrollToBottom();
    setTimeout(async () => {
      await this.refreshPanes();
      await this.reloadHistory();
      this._forceRedraw();
    }, 300);
  }

  async runTmuxCmd(command) {
    try {
      await fetch(
        `/api/sessions/${encodeURIComponent(this.session)}/command${this._nodeQuery()}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        },
      );
    } catch (_) {}
    if (WINDOW_SWITCH_CMDS.has(command)) {
      this.clear();
      this.scrollToBottom();
    }
    setTimeout(() => {
      this.refreshPanes();
      this.reloadHistory();
    }, 300);
  }

  // ── History ───────────────────────────────────────────────────────
  async reloadHistory() {
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(this.session)}/history${this._nodeQuery()}`,
      );
      if (!res.ok) return;
      const history = await res.text();
      if (history.trim()) {
        this.renderer.write(history.replace(/\n/g, "\r\n"));
        this.scrollToBottom();
        this.dispatchEvent(new CustomEvent("history", { detail: history }));
      }
    } catch (_) {}
  }
}
