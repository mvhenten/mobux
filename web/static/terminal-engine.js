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
//   R12 getSelection(); hasSelection(); clearSelection(); selectAll();
//       onSelectionChange(cb): Disposable    native-DOM selection (#137)
//   R13 onLink(cb): Disposable               URL activations; UI opens them
//   R14 onBell(cb): Disposable               terminal BEL; UI decides
//   R15 focus(); setNativeInputEnabled(bool)
//   R16 constructed with { altScreen: false }; the renderer suppresses
//       alternate-screen switching (and mouse-protocol reporting) itself
//       clear()                              (engine housekeeping)
//
// The engine exposes the surface its consumers use: EventTarget events (open,
// close, data, panes, history, osc-detected), the connection/scroll/pane/tmux/
// history methods, the interface passthroughs above, and a read-only `document`
// contract (see terminal-document.js) the reader consumes. terminal.js drives
// the engine; the reader (reader.js) is a sibling the SPA mounts — the engine
// has no knowledge of it.

import { openExternal } from "./external-link.js";
import { createTerminalDocument } from "./terminal-document.js";
import {
  findOsc133AEnd,
  scanForNextAAndCandidate,
} from "./osc133-attribution.js";

const oscTextDecoder = new TextDecoder("utf-8", { fatal: false });

// The server always relays PTY output as WS Text frames built from
// `String::from_utf8_lossy` (main.rs) — bytes/Blob arrive here only from
// test fakes. Normalizing to a string once keeps OSC 133 A-marker
// attribution (osc133-attribution.js) in one representation throughout.
function oscInputToString(data) {
  return typeof data === "string" ? data : oscTextDecoder.decode(data);
}

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

    // OSC 133 (FinalTerm / shell-integration) markers. Recorded by absolute
    // row for all four kinds (diagnostics, oscMarkerCount), but only `A` is
    // trustworthy for row-sensitive decisions under tmux — a passthrough
    // envelope that carries no trailing text in the same shell write (as `B`
    // never does) can land on a cursor position tmux resets to the pane's
    // home row rather than the true one. See term-tokenizer.js's doc comment
    // for the full story; the reader's prompt classification keys off `A`
    // alone for this reason.
    //
    // `A`'s row is NOT recorded here at arrival time — the cursor position
    // *when this handler fires* races the same way `B`'s does (see
    // osc133-attribution.js). `_ingestPtyData` below attributes `A` instead,
    // to the row its own prompt text draws on, and calls `oscMarkers.set`
    // itself once a candidate is found. This handler still fires for `A`
    // (the renderer's own parser is what actually finds the marker in the
    // byte stream — robust across writes in a way a hand-rolled scanner
    // isn't) but only uses it for `oscDetected`.
    this.oscMarkers = new Map();
    this.oscDetected = false;
    // Is there a currently-open A cycle (seen the marker, no candidate row
    // committed for it yet)? See _ingestPtyData's doc comment.
    this._oscAOpen = false;
    // Serializes _ingestPtyData calls — see that method's doc comment.
    this._ingestChain = Promise.resolve();

    this._oscSub = this.renderer.registerOscHandler(133, (data) => {
      const kind = (data || "").charAt(0);
      if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") {
        return false;
      }
      if (kind !== "A") {
        const buf = this.getActiveBuffer();
        const absY = (buf.baseY || 0) + (buf.cursorY || 0);
        this.oscMarkers.set(absY, kind);
      }
      if (!this.oscDetected) {
        this.oscDetected = true;
        this.dispatchEvent(new Event("osc-detected"));
      }
      return false; // allow other handlers
    });

    this._inputSub = this.renderer.onInput((d) => this.send(d));

    // The read-only document contract (issue #206, D2). The reader consumes
    // this instead of reaching into the buffer, `cols`, the OSC marker map,
    // `onBufferChanged`, and the last-row-is-status convention. The engine has
    // no knowledge of the reader; it only publishes the document.
    this.document = createTerminalDocument(this);
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
        this._ingestPtyData(ev.data);
        bytes = ev.data;
      } else if (ev.data instanceof ArrayBuffer) {
        const u8 = new Uint8Array(ev.data);
        this._ingestPtyData(u8);
        bytes = u8;
      } else if (ev.data instanceof Blob) {
        const u8 = new Uint8Array(await ev.data.arrayBuffer());
        this._ingestPtyData(u8);
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
  // Routed through the same OSC 133 A-marker attribution pipeline as the
  // live WS stream (_ingestPtyData) — history reload/test injection carry
  // the same marker bytes a real prompt would, and should attribute them
  // the same way. reloadHistory() below writes straight to the renderer
  // instead: replayed scrollback text, never a live marker.
  write(data) {
    return this._ingestPtyData(data);
  }

  // ── OSC 133 A-marker row attribution ───────────────────────────────
  // See osc133-attribution.js for the scanning detail and the reasoning
  // behind it (finalize on the first candidate found in a chunk; bound the
  // search by the next A, not B/C/D). Every PTY write funnels through here
  // (both the live WS stream and the public write() passthrough) so there
  // is exactly one attribution path regardless of entry point. Nothing is
  // ever withheld from rendering — every byte is handed to the renderer as
  // soon as it's available; only the bookkeeping (which row is "the"
  // prompt row) is deferred.
  //
  // Chunks are processed strictly one at a time through `_ingestChain`: a
  // WS `onmessage` handler doesn't await the previous call before the next
  // message's handler runs (fire-and-forget, for throughput), so without
  // this queue two chunks could interleave mid-cycle and corrupt
  // `_oscAOpen`. Queuing makes "chunk 1 fully done" a
  // precondition for "start chunk 2".
  _ingestPtyData(raw) {
    const str = oscInputToString(raw);
    const step = () => this._consumeChunk(str);
    this._ingestChain = this._ingestChain.then(step, step);
    return this._ingestChain;
  }

  async _consumeChunk(text) {
    let cursor = 0;
    for (;;) {
      if (!this._oscAOpen) {
        const markerEnd = findOsc133AEnd(text, cursor);
        if (markerEnd === -1) {
          await this._writeSlice(text, cursor, text.length);
          return;
        }
        await this._writeSlice(text, cursor, markerEnd);
        this._oscAOpen = true;
        cursor = markerEnd;
        continue;
      }

      const { candidateEnd, nextAEnd } = scanForNextAAndCandidate(text, cursor);
      if (candidateEnd === cursor) {
        // Nothing visible in what's available yet (the marker's own lone
        // envelope, or still mid tmux redraw boilerplate) — write it
        // through as-is and keep the cycle open for the next chunk to
        // retry, whether or not a next A was also seen here.
        await this._writeSlice(
          text,
          cursor,
          nextAEnd === -1 ? text.length : nextAEnd,
        );
        if (nextAEnd === -1) return;
        cursor = nextAEnd;
        continue;
      }
      // Found a candidate — commit it immediately rather than continuing to
      // watch for a "better" one in a later chunk (typed command echo, its
      // output): see the module doc comment for why waiting would let that
      // later, unrelated content overwrite an already-correct row.
      await this._writeSlice(text, cursor, candidateEnd);
      const buf = this.getActiveBuffer();
      this.oscMarkers.set((buf.baseY || 0) + (buf.cursorY || 0), "A");
      this._oscAOpen = false;
      cursor = candidateEnd;
      if (nextAEnd !== -1) {
        await this._writeSlice(text, cursor, nextAEnd);
        this._oscAOpen = true;
        cursor = nextAEnd;
      }
    }
  }

  _writeSlice(text, from, to) {
    if (to <= from) return Promise.resolve();
    return this.renderer.write(text.slice(from, to));
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

  // ── Selection / links / bell (R12–R14) ────────────────────────────
  getSelection() {
    return this.renderer.getSelection();
  }
  hasSelection() {
    return this.renderer.hasSelection();
  }
  clearSelection() {
    this.renderer.clearSelection();
  }
  selectAll() {
    this.renderer.selectAll();
  }
  onSelectionChange(cb) {
    return this.renderer.onSelectionChange(cb);
  }
  onLink(cb) {
    return this.renderer.onLink(cb);
  }
  onBell(cb) {
    return this.renderer.onBell(cb);
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
