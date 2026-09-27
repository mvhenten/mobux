// The engine's one text buffer (issue #315). Two headless xterm.js terminals,
// each fed from exactly one source and parsed once:
//
//   screen   the tmux client screen, fed by the WebSocket stream. The
//            alternate screen is allowed; tmux's client lives on it, so it
//            keeps no scrollback. Its last row is the tmux status line.
//   history  the pane's tmux history above the visible screen, fed by
//            capture-pane (scope=history) and extended from its tail.
//
// Displays (xterm, sterk, the reader) draw from this buffer through
// terminal-redraw.js; nothing writes into a display directly.

// Normal-screen rows that scroll off are kept: only synthetic writes reach
// the normal screen, since tmux switches its client to the alternate screen
// at attach. They share the display's scrollback with history.
const SCREEN_SCROLLBACK = 1000;

// DEC private modes that change what the display sends back (cursor-key
// encoding, cursor visibility, bracketed paste), mirrored onto the display.
const MIRRORED_MODES = [1, 25, 2004];

const SGR_RE = /\x1b\[[0-9;:]*m/g;

// Upper bound on a captured line's cell width, so the history terminal is
// wide enough that every captured line stays one row. Overcounting only
// widens it.
function lineWidth(line) {
  let width = 0;
  for (const ch of line.replace(SGR_RE, "")) {
    width += ch.codePointAt(0) >= 0x1100 ? 2 : 1;
  }
  return width;
}

function suffixPrefixOverlap(local, tail) {
  const max = Math.min(local.length, tail.length);
  for (let o = max; o > 0; o--) {
    if (tail[o - 1] !== local[local.length - 1]) continue;
    let match = true;
    for (let j = 0; j < o; j++) {
      if (local[local.length - o + j] !== tail[j]) {
        match = false;
        break;
      }
    }
    if (match) return o;
  }
  return 0;
}

export function splitCapture(text) {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

const historyText = (lines) => lines.map((l) => `\x1b[0m${l}\r\n`).join("");

// `scrollback` is the display's: history and normal-screen scrollback
// together never exceed it, so the display drops no row the buffer keeps.
export function createTerminalBuffer({ cols, rows, scrollback }) {
  const screenScrollbackLimit = Math.min(
    SCREEN_SCROLLBACK,
    Math.floor(scrollback / 10),
  );
  const historyLimit = scrollback - screenScrollbackLimit;
  const Headless = window.XtermHeadless;
  if (!Headless || !Headless.Terminal) {
    throw new Error(
      "xterm headless bundle not loaded — check vendor/xterm-headless.bundle.js",
    );
  }
  const newTerminal = (options) =>
    new Headless.Terminal({ allowProposedApi: true, ...options });

  const screen = newTerminal({ cols, rows, scrollback: screenScrollbackLimit });

  const modes = new Map(MIRRORED_MODES.map((m) => [m, m === 25]));
  const scalar = (p) => (Array.isArray(p) ? p[0] : p);
  const subs = ["h", "l"].map((final) =>
    screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      for (const m of params.map(scalar)) {
        if (modes.has(m)) modes.set(m, final === "h");
      }
      return false;
    }),
  );

  // History rows become visible to the display only once parsed; a replace
  // builds the new terminal aside and swaps it in, so a draw never sees a
  // half-parsed history.
  let history = newTerminal({ cols, rows: 1, scrollback: historyLimit + 10 });
  let historyCols = cols;
  let historyLines = [];
  let generation = 0;

  async function setHistory(lines) {
    const kept = lines.slice(-historyLimit);
    const mine = ++generation;
    const width = kept.reduce((w, l) => Math.max(w, lineWidth(l)), cols);
    const next = newTerminal({
      cols: width,
      rows: 1,
      scrollback: historyLimit + 10,
    });
    if (kept.length) await write(next, historyText(kept));
    if (mine !== generation) {
      next.dispose();
      return;
    }
    history.dispose();
    history = next;
    historyCols = width;
    historyLines = kept;
  }

  async function appendHistory(fresh) {
    const mine = generation;
    const width = fresh.reduce((w, l) => Math.max(w, lineWidth(l)), 0);
    if (width > historyCols) {
      historyCols = width;
      history.resize(historyCols, 1);
    }
    await write(history, historyText(fresh));
    if (mine === generation) historyLines = historyLines.concat(fresh);
  }

  const screenScrollback = () => screen.buffer.normal.baseY;

  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },

    writeScreen(text) {
      return write(screen, text);
    },
    resize(nextCols, nextRows) {
      cols = nextCols;
      rows = nextRows;
      screen.resize(cols, rows);
    },

    isAlternate() {
      return screen.buffer.active.type === "alternate";
    },
    onBell(cb) {
      return screen.onBell(cb);
    },
    // The headless terminal's own replies (device attributes, cursor
    // reports) — bound for the PTY like keystrokes.
    onData(cb) {
      return screen.onData(cb);
    },
    registerOscHandler(id, cb) {
      return screen.parser.registerOscHandler(id, cb);
    },
    modes() {
      return modes;
    },

    historyRowCount() {
      return historyLines.length;
    },
    historyRow(i) {
      return history.buffer.active.getLine(i);
    },
    screenScrollbackCount: screenScrollback,
    screenScrollbackRow(i) {
      return screen.buffer.normal.getLine(i);
    },
    viewportRow(r) {
      const buf = screen.buffer.active;
      return buf.getLine(buf.baseY + r);
    },
    cursor() {
      const buf = screen.buffer.active;
      return { x: buf.cursorX, y: buf.cursorY };
    },
    // The cursor's row in display coordinates: history, then normal-screen
    // scrollback, then the screen viewport.
    cursorDisplayRow() {
      return (
        historyLines.length + screenScrollback() + screen.buffer.active.cursorY
      );
    },

    setHistory,
    clearHistory() {
      return setHistory([]);
    },
    // Extend history with the captured tail. Resolves false when the tail no
    // longer continues the local history and a full reload is needed.
    async mergeHistoryTail(tail) {
      if (tail.length === 0) return historyLines.length === 0;
      const overlap = suffixPrefixOverlap(historyLines, tail);
      if (overlap === 0 && historyLines.length > 0) return false;
      const fresh = tail.slice(overlap);
      if (fresh.length === 0) return true;
      if (historyLines.length + fresh.length > historyLimit) return false;
      await appendHistory(fresh);
      return true;
    },

    dispose() {
      for (const sub of subs) sub.dispose();
      history.dispose();
      screen.dispose();
    },
  };
}
