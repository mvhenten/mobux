// The mobux terminal engine — one implementation, two renderers.
//
// The engine owns everything that is renderer-independent: the PTY
// WebSocket lifecycle, reconnect backoff, tmux pane tracking, tmux
// commands, history, and OSC 133 marker bookkeeping. It owns the one text
// buffer (terminal-buffer.js): the stream is parsed into it once, and the
// redraw writer (terminal-redraw.js) draws it into the renderer. The two
// adapters (renderer-xterm.js, renderer-sterk.js) are views only — the
// engine never writes the stream into them and never reaches into their
// internals.
//
// ── Renderer interface (the only crossing) ──────────────────────────────
// An adapter is a plain object exposing:
//
//   R1  dispose()
//   R2  write(data): Promise<void>            resolves once the buffer reflects data
//                                             (only the redraw writer calls it)
//   R3  resize(cols, rows)
//       measure(): {cols, rows, cellWidth, cellHeight}   authoritative fit
//       cellSize(): {width, height}
//   R4  cols, rows                            current grid
//   R5  onInput(cb): Disposable               keystrokes / IME bound for the PTY
//   R6  scrollLines(n), scrollToBottom()
//   R7  buffer.active.{length,cursorX,cursorY,baseY,viewportY,getLine}
//   R8  onBufferChanged(cb): Disposable       fires after a write is parsed
//   R11 setTheme(theme); setFontSize(px); getFontSize()
//   R12 getSelection(); hasSelection(); clearSelection(); selectAll();
//       onSelectionChange(cb): Disposable    native-DOM selection (#137)
//   R13 onLink(cb): Disposable               URL activations; UI opens them
//   R15 focus(); setNativeInputEnabled(bool)
//   R16 reset()                              drop all content (full redraw)
//
// Alternate-screen state (R9), OSC handlers (R10) and the bell (R14) come
// from the buffer's screen parser, not the renderer.
//
// The engine exposes the surface its consumers use: EventTarget events (open,
// close, data, panes, history, osc-detected), the connection/scroll/pane/tmux/
// history methods, the interface passthroughs above, and a read-only `document`
// contract (see terminal-document.js) the reader consumes. terminal.js drives
// the engine; the reader (reader.js) is a sibling the SPA mounts — the engine
// has no knowledge of it.

import { u, wsUrl } from "./base.js";
import { openExternal } from "./external-link.js";
import { createTerminalDocument } from "./terminal-document.js";
import { createTerminalBuffer, splitCapture } from "./terminal-buffer.js";
import { createRedrawWriter } from "./terminal-redraw.js";
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

// How long the stream must stay quiet before history is extended from the
// tmux tail, and how many tail lines are fetched to match against.
const HISTORY_QUIET_MS = 400;
const HISTORY_TAIL_LINES = 1000;

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
    // row for all four kinds (diagnostics, oscMarkerCount, reader command
    // grouping — issue #219), but only `A` is trustworthy for row-sensitive
    // decisions under tmux — a passthrough envelope that carries no trailing
    // text in the same shell write (as `B` never does) can land on a cursor
    // position tmux resets to the pane's home row rather than the true one.
    // See term-tokenizer.js's doc comment for the full story; the reader's
    // prompt classification keys off `A` alone for this reason.
    //
    // A row's value is the full marker payload (`"C"`, `"D;0"`, `"A"`, …),
    // not just the kind letter — the reader needs the exit code carried
    // after `D;`. When two markers land on the same absolute row — which
    // happens routinely, since the shell's PS1 emits `D;$?` immediately
    // followed by `A` in the same write, and a zero-output command never
    // moves the cursor between its `C` and that `D`/`A` — both are kept,
    // joined by `|` (e.g. `"D;0|A"`, or `"C|D;0|A"` for a no-op command).
    // See `_recordOscMarker`. Consumers must scan for a kind rather than
    // compare the row's value for equality — see term-tokenizer.js's
    // `oscHas`/`oscExitCode`.
    //
    // `A`'s row is NOT recorded here at arrival time — the cursor position
    // *when this handler fires* races the same way `B`'s does (see
    // osc133-attribution.js). `_ingestPtyData` below attributes `A` instead,
    // to the row its own prompt text draws on, and calls `_recordOscMarker`
    // itself once a candidate is found. This handler still fires for `A`
    // (the screen parser is what actually finds the marker in the byte
    // stream — robust across writes in a way a hand-rolled scanner isn't)
    // but only uses it for `oscDetected`.
    //
    // Rows are display rows: history, then normal-screen scrollback, then
    // the screen viewport — the layout the redraw writer draws.
    this.oscMarkers = new Map();
    this.oscDetected = false;
    // Is there a currently-open A cycle (seen the marker, no candidate row
    // committed for it yet)? See _ingestPtyData's doc comment.
    this._oscAOpen = false;

    this.buffer = createTerminalBuffer({
      cols: this.renderer.cols,
      rows: this.renderer.rows,
    });
    this.view = createRedrawWriter(this.buffer, this.renderer);
    this._historyTimer = null;
    this._historyTail = null;
    this._historyTailAgain = false;

    this._oscSub = this.buffer.registerOscHandler(133, (data) => {
      const kind = (data || "").charAt(0);
      if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") {
        return false;
      }
      if (kind !== "A") {
        this._recordOscMarker(this.buffer.cursorDisplayRow(), data);
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
    this.ws = new WebSocket(
      wsUrl(`ws/${encodeURIComponent(this.session)}${this._wsQuery()}`),
    );
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      // A clean open resets the backoff window.
      this._reconnectDelay = 0;
      this.resize();
      this.refreshPanes();
      this.dispatchEvent(new Event("open"));
    };
    this.ws.onmessage = (ev) => {
      const bytes =
        typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data);
      this._ingestPtyData(bytes);
      this._scheduleHistoryTail();
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
    this._disposed = true;
    clearTimeout(this._historyTimer);
    try {
      this._oscSub?.dispose();
    } catch (_) {}
    try {
      this._inputSub?.dispose();
    } catch (_) {}
    this.view.dispose();
    try {
      this.renderer.dispose();
    } catch (_) {}
    this.buffer.dispose();
  }

  // ── Resize ────────────────────────────────────────────────────────
  resize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = this.renderer.measure();
    this._resizeBuffer(cols, rows);
    this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  _resizeBuffer(cols, rows) {
    if (cols === this.buffer.cols && rows === this.buffer.rows) return;
    this.buffer.resize(cols, rows);
    this.view.invalidate();
    this.view.flush();
  }

  _forceRedraw() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = this.renderer.measure();
    this.ws.send(
      JSON.stringify({ type: "resize", cols, rows: Math.max(2, rows - 1) }),
    );
    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this._resizeBuffer(cols, rows);
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
  // Drop history and its markers (a window switch: the next window's
  // history replaces it, and tmux repaints the screen).
  clear() {
    this.buffer.clearHistory();
    this.oscMarkers.clear();
    this.view.invalidate();
    return this.view.flush();
  }

  get cols() {
    return this.buffer.cols;
  }
  get rows() {
    return this.buffer.rows;
  }

  // ── Renderer interface passthroughs ───────────────────────────────
  // Routed through the same screen parser and OSC 133 A-marker attribution
  // pipeline as the live WS stream (_ingestPtyData) — test injection carries
  // the same marker bytes a real prompt would, and should attribute them the
  // same way. History never goes through here: it has its own parser.
  write(data) {
    return this._ingestPtyData(data);
  }

  // ── OSC 133 A-marker row attribution ───────────────────────────────
  // See osc133-attribution.js for the scanning detail and the reasoning
  // behind it (finalize on the first candidate found in a chunk; bound the
  // search by the next A, not B/C/D). Every PTY write funnels through here
  // (both the live WS stream and the public write() passthrough) so there
  // is exactly one attribution path regardless of entry point. Nothing is
  // ever withheld from rendering — every byte is parsed into the screen as
  // soon as it's available; only the bookkeeping (which row is "the" prompt
  // row) is deferred. The screen parser is synchronous, so each chunk is
  // fully consumed before the next one starts.
  // Record an OSC 133 marker on an absolute row, joining with whatever is
  // already there rather than clobbering it — see the `oscMarkers` doc
  // comment in the constructor for why two markers routinely share a row.
  _recordOscMarker(absY, marker) {
    const existing = this.oscMarkers.get(absY);
    this.oscMarkers.set(absY, existing ? `${existing}|${marker}` : marker);
  }

  _ingestPtyData(raw) {
    this._consumeChunk(oscInputToString(raw));
    return this.view.flush();
  }

  _consumeChunk(text) {
    let cursor = 0;
    for (;;) {
      if (!this._oscAOpen) {
        const markerEnd = findOsc133AEnd(text, cursor);
        if (markerEnd === -1) {
          this._writeSlice(text, cursor, text.length);
          return;
        }
        this._writeSlice(text, cursor, markerEnd);
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
        this._writeSlice(
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
      this._writeSlice(text, cursor, candidateEnd);
      this._recordOscMarker(this.buffer.cursorDisplayRow(), "A");
      this._oscAOpen = false;
      cursor = candidateEnd;
      if (nextAEnd !== -1) {
        this._writeSlice(text, cursor, nextAEnd);
        this._oscAOpen = true;
        cursor = nextAEnd;
      }
    }
  }

  _writeSlice(text, from, to) {
    if (to > from) this.buffer.writeScreen(text.slice(from, to));
  }
  onBufferChanged(cb) {
    return this.renderer.onBufferChanged(cb);
  }
  isAlternateScreenActive() {
    return this.buffer.isAlternate();
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
    return this.buffer.onBell(cb);
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
        u(
          `api/sessions/${encodeURIComponent(this.session)}/panes${this._nodeQuery()}`,
        ),
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
        u(
          `api/sessions/${encodeURIComponent(this.session)}/command${this._nodeQuery()}`,
        ),
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
  // History is the pane's tmux history above the visible screen
  // (scope=history). A reload replaces it; while the stream flows it is
  // extended from the tmux tail once output goes quiet.
  _historyUrl(params) {
    const q = new URLSearchParams(params);
    if (this.node) q.set("node", this.node);
    return u(
      `api/sessions/${encodeURIComponent(this.session)}/history?${q.toString()}`,
    );
  }

  async _fetchHistory(params) {
    const res = await fetch(this._historyUrl(params)).catch(() => null);
    if (!res || !res.ok) return null;
    return res.text();
  }

  async reloadHistory() {
    const history = await this._fetchHistory({ scope: "history" });
    if (history === null || this._disposed) return;
    this.buffer.setHistory(splitCapture(history));
    this.view.invalidate();
    await this.view.flush();
    this.scrollToBottom();
    this.dispatchEvent(new CustomEvent("history", { detail: history }));
  }

  _scheduleHistoryTail() {
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(
      () => this._extendHistory(),
      HISTORY_QUIET_MS,
    );
  }

  async _extendHistory() {
    if (this._historyTail) {
      this._historyTailAgain = true;
      return;
    }
    this._historyTail = this._fetchHistory({
      scope: "history",
      lines: String(HISTORY_TAIL_LINES),
    });
    const tail = await this._historyTail;
    if (this._disposed) return;
    if (tail !== null) {
      if (this.buffer.mergeHistoryTail(splitCapture(tail))) {
        await this.view.flush();
      } else {
        await this.reloadHistory();
      }
    }
    this._historyTail = null;
    if (this._historyTailAgain) {
      this._historyTailAgain = false;
      this._scheduleHistoryTail();
    }
  }
}
