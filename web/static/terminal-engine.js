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
//   R7  viewport(): {length, top}             display rows, first one shown
//       rowText(y): string | null             a display row's text (tap to open)
//   R11 setTheme(theme); setFontSize(px); getFontSize()
//   R12 getSelection(); hasSelection(); clearSelection(); selectAll();
//       onSelectionChange(cb): Disposable    native-DOM selection (#137)
//   R13 onLink(cb): Disposable               URL activations; UI opens them
//   R15 focus(); setNativeInputEnabled(bool)
//   R16 reset()                              drop all content (full redraw)
//
// Alternate-screen state (R9), OSC handlers (R10), the bell (R14) and
// buffer changes come from the buffer, not the renderer. The reader reads the
// buffer through the document contract and never touches a display.
//
// The engine exposes the surface its consumers use: EventTarget events (open,
// close, data, panes, history, osc-detected), the connection/scroll/pane/tmux/
// history methods, the interface passthroughs above, and a read-only `document`
// contract over the buffer (see terminal-document.js) the reader consumes. terminal.js drives
// the engine; the reader (reader.js) is a sibling the SPA mounts — the engine
// has no knowledge of it.

import { u, wsUrl } from "./base.js";
import { openExternal } from "./external-link.js";
import { createTerminalDocument } from "./terminal-document.js";
import { createTerminalBuffer, splitCapture } from "./terminal-buffer.js";
import { createRedrawWriter } from "./terminal-redraw.js";
import { createMarkerBook } from "./terminal-markers.js";
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

// History syncs with tmux once the stream has been quiet for
// HISTORY_QUIET_MS, and at least every HISTORY_MAX_WAIT_MS while it flows.
const HISTORY_QUIET_MS = 400;
const HISTORY_MAX_WAIT_MS = 2000;
// A catch-up fetches this many of the last history lines and needs this
// many of them to overlap what is held; otherwise it fetches the whole
// history (the server's maximum).
const HISTORY_TAIL_LINES = 500;
const HISTORY_TAIL_OVERLAP = 50;
const HISTORY_WHOLE_LINES = 10000;

// OSC 10 / 11 / 12: foreground / background / cursor colour queries.
const COLOUR_QUERIES = {
  10: (theme) => theme.foreground || theme.palette?.[7],
  11: (theme) => theme.background || theme.palette?.[0],
  12: (theme) => theme.cursor || theme.foreground || theme.palette?.[7],
};

const hex2 = (n) => n.toString(16).padStart(2, "0");

// Indexed colour `n` as #rrggbb: the theme's 16, then xterm's 6×6×6 cube
// and grey ramp.
function paletteHex(theme, n) {
  if (n < 16) return theme.palette?.[n];
  if (n < 232) {
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    const c = n - 16;
    return `#${[Math.floor(c / 36), Math.floor(c / 6) % 6, c % 6]
      .map((v) => hex2(level(v)))
      .join("")}`;
  }
  if (n < 256) return `#${hex2(8 + (n - 232) * 10).repeat(3)}`;
  return null;
}

function oscColour(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return null;
  return `rgb:${m
    .slice(1)
    .map((c) => c + c)
    .join("/")}`;
}

export const WINDOW_SETTLE_MS = 300;

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
  constructor({ session, node, host, renderer, build, scrollback }) {
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
    this._panesAsked = 0;
    this._panesApplied = 0;
    // The panes answer describes the active pane's screen only when it was
    // asked after the last window switch settled.
    this._paneScreenFrom = 0;
    this._paneScreenKnown = false;

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

    // OSC 133 (FinalTerm / shell-integration) markers. Recorded by logical
    // line (the buffer's line key) for all four kinds (diagnostics, oscMarkerCount, reader command
    // grouping — issue #219), but only `A` is trustworthy for row-sensitive
    // decisions under tmux — a passthrough envelope that carries no trailing
    // text in the same shell write (as `B` never does) can land on a cursor
    // position tmux resets to the pane's home row rather than the true one.
    // See term-tokenizer.js's doc comment for the full story; the reader's
    // prompt classification keys off `A` alone for this reason.
    //
    // A row's value is the full marker payload (`"C"`, `"D;0"`, `"A"`, …),
    // not just the kind letter — the reader needs the exit code carried
    // after `D;`. When two markers land on the same line — which
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
    this.oscDetected = false;
    // Is there a currently-open A cycle (seen the marker, no candidate row
    // committed for it yet)? See _ingestPtyData's doc comment.
    this._oscAOpen = false;
    // Serializes _ingestPtyData calls — see that method's doc comment.
    this._ingestChain = Promise.resolve();

    this.buffer = createTerminalBuffer({
      scrollback,
      cols: this.renderer.cols,
      rows: this.renderer.rows,
    });
    this.view = createRedrawWriter(this.buffer, this.renderer);
    this.markers = createMarkerBook(this.buffer);
    this._historyTimer = null;
    this._historyMaxTimer = null;
    this._historySync = null;
    this._historyNext = null;
    this._historyAbort = null;
    this._historyGeneration = 0;
    this._theme = null;

    this._oscSub = this.buffer.registerOscHandler(133, (data) => {
      const kind = (data || "").charAt(0);
      if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") {
        return false;
      }
      if (kind !== "A") {
        this.markers.record(data);
      }
      if (!this.oscDetected) {
        this.oscDetected = true;
        this.dispatchEvent(new Event("osc-detected"));
      }
      return false; // allow other handlers
    });

    this._inputSub = this.renderer.onInput((d) => this.send(d));
    this._replySub = this.buffer.onData((d) => this.send(d));
    this._colourSubs = Object.entries(COLOUR_QUERIES).map(([id, pick]) =>
      this.buffer.registerOscHandler(Number(id), (data) => {
        if (data !== "?") return false;
        const colour = this._theme && oscColour(pick(this._theme));
        if (colour) this.send(`\x1b]${id};${colour}\x1b\\`);
        return true;
      }),
    );
    this._colourSubs.push(
      this.buffer.registerOscHandler(4, (data) => {
        const parts = data.split(";");
        if (parts.length % 2 || parts.some((p, i) => i % 2 && p !== "?")) {
          return false;
        }
        for (let i = 0; i < parts.length; i += 2) {
          const colour =
            this._theme && oscColour(paletteHex(this._theme, Number(parts[i])));
          if (colour) this.send(`\x1b]4;${parts[i]};${colour}\x1b\\`);
        }
        return true;
      }),
    );

    // The read-only document contract over the buffer (issues #206, #315).
    // The engine has no knowledge of the reader; it only publishes it.
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
    clearTimeout(this._historyMaxTimer);
    try {
      this._oscSub?.dispose();
    } catch (_) {}
    try {
      this._inputSub?.dispose();
    } catch (_) {}
    this._replySub.dispose();
    for (const sub of this._colourSubs) sub.dispose();
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
    const widthChanged = cols !== this.buffer.cols;
    this.buffer.resize(cols, rows);
    if (widthChanged) this.view.invalidate();
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

  // ── Display / scroll passthroughs ─────────────────────────────────
  viewport() {
    return this.renderer.viewport();
  }
  rowText(y) {
    return this.renderer.rowText(y);
  }
  scrollLines(n) {
    this.renderer.scrollLines(n);
  }
  scrollToBottom() {
    this.renderer.scrollToBottom();
  }
  async clear() {
    this._historyGeneration++;
    this._historyAbort?.abort();
    this.markers.clear();
    await this.buffer.clearHistory();
    this.view.invalidate();
    await this.view.flush();
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
  // row) is deferred.
  //
  // Chunks are processed strictly one at a time through `_ingestChain`: a
  // WS `onmessage` handler doesn't await the previous call before the next
  // message's handler runs, and the screen parser writes asynchronously, so
  // without this queue two chunks could interleave mid-cycle and corrupt
  // `_oscAOpen`.
  // Markers by line key, joined with `|` where two share a line — see the
  // `oscMarkers` doc comment in the constructor (terminal-markers.js).
  get oscMarkers() {
    return this.markers.map;
  }

  _ingestPtyData(raw) {
    const str = oscInputToString(raw);
    const step = async () => {
      await this._consumeChunk(str);
      await this.view.flush();
    };
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
      this.markers.record("A");
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
    return this.buffer.writeScreen(text.slice(from, to));
  }
  onBufferChanged(cb) {
    return this.buffer.onChange(cb);
  }
  isAlternateScreenActive() {
    return this.buffer.isAlternate();
  }
  // A scroll belongs to the pane app while the pane is on its alternate
  // screen and tmux takes the mouse. The buffer holds tmux's client screen,
  // which is always on its alternate screen once attached, so the pane's
  // state comes from tmux.
  wheelScrollsPane() {
    if (!this._paneScreenKnown) return false;
    const pane = this.panes[this.activeIndex];
    return pane?.alternateOn === true && this.buffer.mouse().tracking;
  }
  // The client rows a wheel event may land on: tmux's status line switches
  // windows on a wheel.
  paneRows() {
    const pane = this.panes[this.activeIndex];
    const status = pane?.statusLines ?? 1;
    const first = pane?.statusPosition === "top" ? status : 0;
    return { first, last: Math.max(first, first + this.rows - status - 1) };
  }
  forgetPaneScreen(settleMs) {
    this._paneScreenKnown = false;
    this._paneScreenFrom = performance.now() + settleMs;
  }
  // One wheel notch at a 0-based cell, in the mouse format tmux asked its
  // client for. tmux hands it to the pane app in the app's format, or
  // scrolls copy-mode when the app tracks no mouse.
  sendWheel(up, col, row) {
    const button = up ? 64 : 65;
    if (this.buffer.mouse().sgr) {
      this.send(`\x1b[<${button};${col + 1};${row + 1}M`);
      return;
    }
    // X10 bytes above 127 would not survive the text frame.
    const cell = (n) => String.fromCharCode(33 + Math.min(n, 93));
    this.send(
      `\x1b[M${String.fromCharCode(32 + button)}${cell(col)}${cell(row)}`,
    );
  }
  focus() {
    this.renderer.focus();
  }
  setNativeInputEnabled(enabled) {
    this.renderer.setNativeInputEnabled(enabled);
  }
  setTheme(theme) {
    this._theme = theme;
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
    const asked = ++this._panesAsked;
    const askedAt = performance.now();
    try {
      const res = await fetch(
        u(
          `api/sessions/${encodeURIComponent(this.session)}/panes${this._nodeQuery()}`,
        ),
      );
      if (!res.ok) return;
      const panes = await res.json();
      if (asked < this._panesApplied) return;
      this._panesApplied = asked;
      this.panes = panes;
      if (askedAt >= this._paneScreenFrom) this._paneScreenKnown = true;
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
    this.forgetPaneScreen(WINDOW_SETTLE_MS);
    this.clear();
    this.scrollToBottom();
    setTimeout(async () => {
      await this.refreshPanes();
      await this.reloadHistory();
      this._forceRedraw();
    }, WINDOW_SETTLE_MS);
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
      this.forgetPaneScreen(WINDOW_SETTLE_MS);
      this.clear();
      this.scrollToBottom();
    }
    setTimeout(() => {
      this.refreshPanes();
      this.reloadHistory();
    }, WINDOW_SETTLE_MS);
  }

  // ── History ───────────────────────────────────────────────────────
  // History is the pane's tmux history above the visible screen
  // (scope=history). A catch-up fetches its tail and appends what is new; a
  // reload, or a tail that cannot be placed, fetches it whole
  // (terminal-buffer.js alignTail / alignHistory).
  _historyUrl(lines) {
    const q = new URLSearchParams({ scope: "history", lines: String(lines) });
    if (this.node) q.set("node", this.node);
    return u(
      `api/sessions/${encodeURIComponent(this.session)}/history?${q.toString()}`,
    );
  }

  reloadHistory() {
    return this._requestHistory("whole");
  }

  _requestHistory(kind) {
    if (this._historySync) {
      if (this._historyNext !== "whole") this._historyNext = kind;
      return this._historySync;
    }
    this._historySync = this._runHistorySync(kind).finally(() => {
      this._historySync = null;
      const next = this._historyNext;
      this._historyNext = null;
      if (next && !this._disposed) this._requestHistory(next);
    });
    return this._historySync;
  }

  async _fetchHistory(lines, signal) {
    const res = await fetch(this._historyUrl(lines), { signal }).catch(
      () => null,
    );
    if (!res || !res.ok) return null;
    const text = await res.text().catch(() => null);
    if (text === null) return null;
    return {
      lines: splitCapture(text),
      continues: res.headers.get("x-history-continues") === "1",
    };
  }

  async _runHistorySync(kind) {
    clearTimeout(this._historyTimer);
    clearTimeout(this._historyMaxTimer);
    this._historyMaxTimer = null;
    const generation = this._historyGeneration;
    const abort = new AbortController();
    this._historyAbort = abort;
    const current = () =>
      !this._disposed && generation === this._historyGeneration;

    let moved = null;
    let scrolled = this.buffer.scrolledRows();
    if (kind === "tail") {
      const tail = await this._fetchHistory(HISTORY_TAIL_LINES, abort.signal);
      if (!tail || !current()) return;
      moved = await this.buffer.syncTail(
        tail.lines,
        tail.continues,
        HISTORY_TAIL_OVERLAP,
      );
      if (!current()) return;
    }
    if (!moved) {
      scrolled = this.buffer.scrolledRows();
      const whole = await this._fetchHistory(HISTORY_WHOLE_LINES, abort.signal);
      if (!whole || !current()) return;
      moved = await this.buffer.syncWhole(whole.lines, whole.continues);
      if (!current()) return;
    }
    this.markers.place(moved, scrolled);
    await this.view.flush();
    this.dispatchEvent(new Event("history"));
  }

  _scheduleHistoryTail() {
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => {
      this._requestHistory("tail");
      this.refreshPanes();
    }, HISTORY_QUIET_MS);
    if (this._historyMaxTimer === null) {
      this._historyMaxTimer = setTimeout(
        () => this._requestHistory("tail"),
        HISTORY_MAX_WAIT_MS,
      );
    }
  }
}
