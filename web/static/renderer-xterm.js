// Xterm renderer adapter.
//
// Implements the mobux renderer interface (see terminal-engine.js) over
// @xterm/xterm. This is one of the two adapters the single engine drives;
// the engine owns the WebSocket, reconnect, panes, tmux, history and OSC 133
// bookkeeping and never reaches into a renderer's internals.
//
// Every xterm-specific reach-through lives here and nowhere else: the
// mouse-protocol lock, the alt-screen stubs (R16), the `_core` cell-metric
// probe, and the `window.__xterm` debug handle the visual test matrix reads.
//
// The xterm bundle (xterm.bundle.js) pins `window.Terminal` and
// `window.WebLinksAddon` before the engine is constructed.

export function createXtermRenderer(host, options = {}) {
  const Xterm = window.Terminal;
  const WebLinksAddon =
    window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
  if (!Xterm) {
    throw new Error(
      "xterm bundle not loaded — check vendor/xterm.bundle.js script tag",
    );
  }

  // R13 — link activations detected by the WebLinks addon fan out here; the UI
  // decides how to open them (mobux routes them out of the app shell).
  const linkSubs = [];
  const emitLink = (uri) => {
    for (const cb of linkSubs.slice()) cb(uri);
  };

  const term = new Xterm({
    cursorBlink: true,
    // Match the reader's typography (style.css `.rb-line`): same mono stack,
    // same 13px font, line-height bumped from xterm's default 1.0 to 1.25.
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    lineHeight: 1.25,
    fontWeight: 300,
    convertEol: false,
    scrollback: options.scrollback,
    // The palette theme is pushed later via setTheme(); construction only
    // sets the base background so the first paint isn't white.
    theme: { background: "#0f1115" },
  });
  term.open(host);
  if (WebLinksAddon) {
    // Report activations through onLink instead of opening here — the UI owns
    // the open decision (R13).
    term.loadAddon(new WebLinksAddon((_event, uri) => emitLink(uri)));
  }

  // Lock mouse protocol to NONE — prevents xterm.js from capturing
  // touch/mouse when tmux sends \x1b[?1000h.
  try {
    Object.defineProperty(term._core.coreMouseService, "activeProtocol", {
      set() {},
      get() {
        return "NONE";
      },
      configurable: true,
    });
  } catch (_) {}

  // R16 — block alternate screen buffer (tmux alt screen has no scrollback).
  if (options.altScreen === false) {
    try {
      const buffers = term._core._bufferService.buffers;
      buffers.activateAltBuffer = () => {};
      buffers.activateNormalBuffer = () => {};
    } catch (_) {}
  }

  // Debug peephole for the visual test matrix (confined to this adapter).
  if (typeof window !== "undefined") {
    window.__xterm = term;
  }

  const horizontalPadding = () => {
    try {
      const cs = getComputedStyle(host);
      return (
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      );
    } catch (_) {
      return 0;
    }
  };

  const cellSize = () => {
    const dims = term._core?._renderService?.dimensions?.css?.cell;
    return { width: dims?.width || 9, height: dims?.height || 18 };
  };

  return {
    // R1 — teardown: xterm releases its DOM + internal listeners.
    dispose() {
      linkSubs.length = 0;
      try {
        term.dispose();
      } catch (_) {}
      if (typeof window !== "undefined" && window.__xterm === term) {
        delete window.__xterm;
      }
    },

    // R2 — resolves after the buffer reflects the data. xterm fires its
    // write callback only once the parsed data is readable through the buffer.
    write(data) {
      return new Promise((resolve) => term.write(data, resolve));
    },

    // R3 — authoritative fit for the host's current size.
    resize(cols, rows) {
      term.resize(cols, rows);
    },
    measure() {
      const c = cellSize();
      // Drive rows from the host's actual painted height, not window.innerHeight:
      // on Android Chrome the layout viewport stays full-screen when the soft
      // keyboard opens, but the flex child (#terminal) shrinks to the visual
      // viewport, so clientHeight is what tracks the keyboard.
      const hostW = host.clientWidth || window.innerWidth;
      const hostH = host.clientHeight || window.innerHeight;
      // #terminal has horizontal padding; subtract it so xterm doesn't overrun
      // the inner content box and shave a column off the right edge.
      const pad = horizontalPadding();
      const cols = Math.max(20, Math.floor((hostW - pad) / c.width) - 1);
      const rows = Math.max(10, Math.floor(hostH / c.height) - 1);
      return { cols, rows, cellWidth: c.width, cellHeight: c.height };
    },
    cellSize,

    // R4 — current grid.
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },

    // R5 — keystrokes / IME output bound for the PTY.
    onInput(cb) {
      return term.onData(cb);
    },

    // R6 — scroll; viewport position is readable via the buffer.
    scrollLines(n) {
      term.scrollLines(n);
    },
    scrollToBottom() {
      term.scrollToBottom();
    },

    // R7 — xterm-shaped buffer read model.
    buffer: {
      get active() {
        return term.buffer.active;
      },
    },

    // R8 — fires after a write is parsed; multiple subscribers.
    onBufferChanged(cb) {
      return term.onWriteParsed(cb);
    },

    // R9 — alt-screen state.
    isAlternateScreenActive() {
      return term.buffer?.active?.type === "alternate";
    },

    // R10 — OSC handler registration (the engine uses it for OSC 133).
    registerOscHandler(id, cb) {
      if (term.parser && term.parser.registerOscHandler) {
        return term.parser.registerOscHandler(id, cb);
      }
      return { dispose() {} };
    },

    // R11 — theming + font size.
    setTheme(theme) {
      term.options.theme = xtermTheme(theme);
    },
    setFontSize(px) {
      if (px !== term.options.fontSize) {
        term.options.fontSize = px;
      }
    },
    getFontSize() {
      return term.options.fontSize;
    },

    // R12 — selection, via xterm's selection API.
    getSelection() {
      return term.getSelection();
    },
    hasSelection() {
      return term.hasSelection();
    },
    clearSelection() {
      term.clearSelection();
    },
    selectAll() {
      term.selectAll();
    },
    onSelectionChange(cb) {
      return term.onSelectionChange(cb);
    },

    // R13 — links. Subscribe to activations reported by the WebLinks addon.
    onLink(cb) {
      linkSubs.push(cb);
      return {
        dispose() {
          const i = linkSubs.indexOf(cb);
          if (i >= 0) linkSubs.splice(i, 1);
        },
      };
    },

    // R14 — bell. The UI decides what to do (mobux's chime).
    onBell(cb) {
      return term.onBell(cb);
    },

    // R15 — input surface ownership.
    focus() {
      try {
        term.focus();
      } catch (_) {}
    },
    setNativeInputEnabled(enabled) {
      const ta = term.textarea;
      if (!ta) return;
      if (enabled) {
        ta.removeAttribute("tabindex");
        ta.style.pointerEvents = "";
        ta.style.opacity = "";
        ta.style.position = "";
        ta.style.top = "";
      } else {
        ta.setAttribute("tabindex", "-1");
        ta.style.pointerEvents = "none";
        ta.style.opacity = "0";
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
      }
    },

    // Engine housekeeping used by window-switch / tmux commands.
    clear() {
      term.clear();
    },
  };
}

// Map mobux's 16-slot ANSI palette onto xterm.js's named-colour theme keys.
function xtermTheme(theme) {
  const p = theme.palette;
  return {
    background: theme.background || p[0],
    foreground: theme.foreground || p[7] || "#c5c8c6",
    black: p[0],
    red: p[1],
    green: p[2],
    yellow: p[3],
    blue: p[4],
    magenta: p[5],
    cyan: p[6],
    white: p[7],
    brightBlack: p[8],
    brightRed: p[9],
    brightGreen: p[10],
    brightYellow: p[11],
    brightBlue: p[12],
    brightMagenta: p[13],
    brightCyan: p[14],
    brightWhite: p[15],
  };
}
