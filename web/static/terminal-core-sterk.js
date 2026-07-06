// Sterk-backed TerminalCore — experimental renderer using @kattebak/sterk
// (libterm + Ace VirtualRenderer under the hood).
//
// Loaded only when `window.__mobuxRenderer === 'sterk'`. The page-level
// boot script in render_terminal_page() injects sterk.bundle.js before
// terminal.js runs, which pins `window.Sterk = { createTerminal }`.
//
// Exposes the same external surface as terminal-core-xterm.js so
// terminal.js / reader-view.js / the test suite use a single contract.

import { getStoredThemeId, getTheme } from "./themes.js";

const WINDOW_SWITCH_CMDS = new Set([
  "next-window",
  "prev-window",
  "new-window",
  "kill-window",
]);

// Hub → node SSH proxying (#176): when the SPA picked a remote node it pins
// window.MOBUX_NODE before the engine boots, and every PTY/tmux call carries
// ?node=<name>. Absent ⇒ the local host, exactly the pre-node behavior.
function nodeQuery() {
  const node = window.MOBUX_NODE;
  return node ? `?node=${encodeURIComponent(node)}` : "";
}

export class TerminalCoreSterk extends EventTarget {
  constructor({ session, host }) {
    super();
    this.session = session;
    this.host = host;
    this.renderer = "sterk";

    this.ws = null;
    this.panes = [];
    this.activeIndex = 0;
    this.oscMarkers = new Map();
    this.oscDetected = false;

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

    this.term = makeSterkAdapter(host, (data) => this.send(data));
    this._wireWriteParsedFanout();
    this._wireOsc133();
    // Debug peephole for tests.
    if (typeof window !== "undefined") {
      window.__sterk = this.term;
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
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(
      `${proto}://${location.host}/ws/${encodeURIComponent(this.session)}${nodeQuery()}`,
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
        this.term.write(ev.data);
        bytes = ev.data;
      } else if (ev.data instanceof ArrayBuffer) {
        const u8 = new Uint8Array(ev.data);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(u8);
        this.term.write(text);
        bytes = u8;
      } else if (ev.data instanceof Blob) {
        const u8 = new Uint8Array(await ev.data.arrayBuffer());
        const text = new TextDecoder("utf-8", { fatal: false }).decode(u8);
        this.term.write(text);
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
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    )
      return;
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

  // ── Resize ────────────────────────────────────────────────────────
  resize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const hostH = this.host.clientHeight || window.innerHeight;

    // Update .sterk-viewport height to match host so Ace sees a sized
    // viewport before we ask it for its grid count.
    const viewport = this.host.querySelector(".sterk-viewport");
    if (viewport && hostH > 0) {
      viewport.style.height = `${hostH}px`;
    }

    const { cols, rows } = this._computeCellGrid(hostH);
    this.term.resize(cols, rows);
    this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  // Compute the (cols, rows) the PTY should run at.
  //
  // Prefer sterk's `getViewportCellCount()` which is the renderer's
  // authoritative answer — it already accounts for any internal
  // padding / scrollbar reservation, so there is no `- 1` fudge
  // needed and the right-most cell sits at the scroller's right edge.
  //
  // Fall back to `floor(clientWidth / cellWidth)` for older sterk
  // builds without the API. We deliberately do NOT subtract 1 here:
  // sterk hides its scrollbar and zeros `$padding` upstream, so the
  // naive math is correct.
  _computeCellGrid(hostH) {
    const sterkCount = this.term._sterk?.getViewportCellCount?.();
    if (sterkCount && sterkCount.cols > 0 && sterkCount.rows > 0) {
      return {
        cols: Math.max(20, sterkCount.cols),
        rows: Math.max(10, sterkCount.rows),
      };
    }
    const cell = this.cellSize();
    const pad = this._horizontalPadding();
    const hostW = this.host.clientWidth || window.innerWidth - pad;
    const cols = Math.max(20, Math.floor(hostW / cell.width));
    const rows = Math.max(10, Math.floor(hostH / cell.height));
    return { cols, rows };
  }

  _keyboardOffset() {
    const vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  }

  _horizontalPadding() {
    try {
      const cs = getComputedStyle(this.host);
      return (
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      );
    } catch (_) {
      return 0;
    }
  }

  cellSize() {
    const metrics =
      this.term._sterk && this.term._sterk.getCellMetrics
        ? this.term._sterk.getCellMetrics()
        : null;
    if (metrics) {
      return { width: metrics.width, height: metrics.height };
    }
    return { width: 9, height: 18 };
  }

  // ── Buffer / scroll passthroughs ──────────────────────────────────
  getActiveBuffer() {
    return this.term.buffer.active;
  }
  scrollLines(n) {
    this.term.scrollLines(n);
  }
  scrollToBottom() {
    this.term.scrollToBottom();
  }
  clear() {
    this.term.clear();
  }

  setFontSize(px) {
    if (px !== this.term.options.fontSize) {
      this.term.options.fontSize = px;
      this.resize();
    }
  }
  getFontSize() {
    return this.term.options.fontSize;
  }

  // ── Panes (= tmux windows) ────────────────────────────────────────
  async refreshPanes() {
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(this.session)}/panes${nodeQuery()}`,
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

  _forceRedraw() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const hostH = this.host.clientHeight || window.innerHeight;
    const { cols, rows } = this._computeCellGrid(hostH);
    this.ws.send(
      JSON.stringify({ type: "resize", cols, rows: Math.max(2, rows - 1) }),
    );
    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.term.resize(cols, rows);
      this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }, 50);
  }

  async runTmuxCmd(command) {
    try {
      await fetch(
        `/api/sessions/${encodeURIComponent(this.session)}/command${nodeQuery()}`,
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

  async reloadHistory() {
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(this.session)}/history${nodeQuery()}`,
      );
      if (!res.ok) return;
      const history = await res.text();
      if (history.trim()) {
        this.term.write(history.replace(/\n/g, "\r\n"));
        this.scrollToBottom();
        this.dispatchEvent(new CustomEvent("history", { detail: history }));
      }
    } catch (_) {}
  }

  _wireWriteParsedFanout() {
    // Sterk's onWriteParsed fires after each write(). We subscribe once
    // here and fan out to all _writeParsedSubs subscribers (the reader
    // relies on this).
    if (this.term._sterk && this.term._sterk.onWriteParsed) {
      this.term._sterk.onWriteParsed(() => {
        for (const cb of this.term._writeParsedSubs) cb();
      });
    }
  }

  _wireOsc133() {
    // Sterk's parser.registerOscHandler(133, handler) lets us hook OSC
    // 133 sequences. A/B mark prompts, record kind by absolute buffer row.
    if (this.term._sterk && this.term._sterk.parser) {
      this.term._sterk.parser.registerOscHandler(133, (data) => {
        const kind = (data || "").charAt(0);
        if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D")
          return false;
        const buf = this.term._sterk.buffer.active;
        const absY = (buf.baseY || 0) + (buf.cursorY || 0);
        this.oscMarkers.set(absY, kind);
        if (!this.oscDetected) {
          this.oscDetected = true;
          this.dispatchEvent(new Event("osc-detected"));
        }
        return false; // Allow other handlers
      });
    }
  }
}

// ── Sterk adapter ────────────────────────────────────────────────────
function makeSterkAdapter(host, sendCb) {
  const Sterk = window.Sterk;
  if (!Sterk || !Sterk.createTerminal) {
    throw new Error(
      "sterk bundle not loaded — check vendor/sterk.bundle.js script tag",
    );
  }
  const theme = getTheme(getStoredThemeId());

  // Create sterk terminal with theme and scrollback
  let sterk;
  try {
    sterk = Sterk.createTerminal({
      cols: 120,
      rows: 35,
      scrollback: 10000,
      fontSize: 13,
      fontFamily:
        "'SF Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', monospace",
      // Opt OUT of sterk's built-in font registry. Per the v2.6.0+
      // contract: `font === ""` AND an explicit `fontFamily` means
      // "consumer manages their own font stack".
      font: "",
      theme: {
        foreground: theme.foreground,
        background: theme.background,
        palette: theme.palette,
      },
    });
  } catch (err) {
    console.error("[sterk] createTerminal failed:", err);
    window.__sterkError = err;
    throw err;
  }

  // Mount to DOM
  try {
    sterk.open(host);
  } catch (err) {
    console.error("[sterk] open failed:", err);
    window.__sterkError = err;
    throw err;
  }

  // Wire up input
  sterk.onData(sendCb);

  const writeParsedSubs = [];

  return {
    _sterk: sterk,
    _writeParsedSubs: writeParsedSubs,
    options: sterk.options,
    parser: sterk.parser,

    get cols() {
      return sterk.cols;
    },
    get rows() {
      return sterk.rows;
    },

    write(data, cb) {
      sterk.write(data, cb);
    },
    resize(cols, rows) {
      sterk.resize(cols, rows);
    },
    clear() {
      sterk.clear();
    },
    scrollToBottom() {
      sterk.scrollToBottom();
    },
    scrollLines(n) {
      sterk.scrollLines(n);
    },

    onWriteParsed(cb) {
      writeParsedSubs.push(cb);
      return {
        dispose() {
          const i = writeParsedSubs.indexOf(cb);
          if (i >= 0) writeParsedSubs.splice(i, 1);
        },
      };
    },
    onData(cb) {
      return sterk.onData(cb);
    },

    buffer: {
      get active() {
        return makeSterkBufferAdapter(sterk);
      },
    },
  };
}

function makeSterkBufferAdapter(sterk) {
  // Don't capture buf — call sterk.buffer.active fresh each time so we see
  // updated state after scrollToBottom() / scrollLines() / write().
  return {
    get length() {
      return sterk.buffer.active.length;
    },
    get cursorX() {
      return sterk.buffer.active.cursorX;
    },
    get cursorY() {
      return sterk.buffer.active.cursorY;
    },
    get baseY() {
      return sterk.buffer.active.baseY;
    },
    get viewportY() {
      return sterk.buffer.active.viewportY;
    },
    getLine(y) {
      const line = sterk.buffer.active.getLine(y);
      return line ? makeSterkLineAdapter(line) : null;
    },
  };
}

function makeSterkLineAdapter(line) {
  return {
    get isWrapped() {
      return line.isWrapped;
    },
    translateToString(trimRight) {
      return line.translateToString(trimRight);
    },
    getCell(x) {
      const cell = line.getCell(x);
      return makeSterkCellAdapter(cell);
    },
  };
}

function makeSterkCellAdapter(cell) {
  return {
    getChars() {
      return cell.getChars();
    },
    getCode() {
      return cell.getCode();
    },
    isFgRGB() {
      return cell.isFgRGB();
    },
    isBgRGB() {
      return cell.isBgRGB();
    },
    isFgPalette() {
      return cell.isFgPalette();
    },
    isBgPalette() {
      return cell.isBgPalette();
    },
    isFgDefault() {
      return cell.isFgDefault();
    },
    isBgDefault() {
      return cell.isBgDefault();
    },
    getFgColor() {
      return cell.getFgColor();
    },
    getBgColor() {
      return cell.getBgColor();
    },
    getFgColorMode() {
      return cell.getFgColorMode();
    },
    getBgColorMode() {
      return cell.getBgColorMode();
    },
    isBold() {
      return cell.isBold();
    },
    isItalic() {
      return cell.isItalic();
    },
    isUnderline() {
      return cell.isUnderline();
    },
    isInverse() {
      return cell.isInverse();
    },
    isDim() {
      return cell.isDim();
    },
  };
}
