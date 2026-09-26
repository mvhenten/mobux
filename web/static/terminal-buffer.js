// The engine's one text buffer (issue #315). Two headless sterk terminals,
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

export const HISTORY_LIMIT = 10000;
// Normal-screen rows that scroll off are kept: only synthetic writes reach
// the normal screen, since tmux switches its client to the alternate screen
// at attach.
const SCREEN_SCROLLBACK = 1000;
export const DISPLAY_SCROLLBACK = HISTORY_LIMIT + SCREEN_SCROLLBACK;

// DEC private modes that change what the display sends back (cursor-key
// encoding, cursor visibility, bracketed paste), mirrored onto the display.
const MIRRORED_MODES = [1, 25, 2004];

const SGR_RE = /\x1b\[[0-9;:]*m/g;

// Upper bound on a captured line's cell width. Overcounting only widens the
// history terminal; undercounting would wrap a row.
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

export function createTerminalBuffer({ cols, rows }) {
  const Sterk = window.Sterk;
  if (!Sterk || !Sterk.createTerminal) {
    throw new Error(
      "sterk bundle not loaded — the terminal buffer needs vendor/sterk.bundle.js",
    );
  }

  const screen = Sterk.createTerminal({
    cols,
    rows,
    scrollback: SCREEN_SCROLLBACK,
    font: "",
  });
  screen.write("\x1b[?1049h");

  const modes = new Map(MIRRORED_MODES.map((m) => [m, m === 25]));
  let queries = "";
  const scalar = (p) => (Array.isArray(p) ? p[0] : p);
  const subs = [];
  for (const final of ["h", "l"]) {
    subs.push(
      screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        for (const m of params.map(scalar)) {
          if (modes.has(m)) modes.set(m, final === "h");
        }
        return false;
      }),
    );
  }
  // Device-attribute queries go to the display, which answers them the way
  // it did when it parsed the stream itself.
  for (const prefix of ["", ">"]) {
    subs.push(
      screen.parser.registerCsiHandler({ prefix, final: "c" }, (params) => {
        queries += `\x1b[${prefix}${params.map(scalar).join(";")}c`;
        return false;
      }),
    );
  }

  let historyLines = [];
  let historyCols = cols;
  let history = null;
  // Normal-screen rows above the viewport, counted only while the normal
  // screen is active so a resize on the alternate screen adds none.
  let screenScrollback = 0;

  function newHistory(width) {
    history?.dispose();
    historyCols = Math.max(cols, width);
    history = Sterk.createTerminal({
      cols: historyCols,
      rows: 1,
      scrollback: HISTORY_LIMIT + 10,
      font: "",
    });
  }

  function writeHistory(lines) {
    const width = lines.reduce((w, l) => Math.max(w, lineWidth(l)), 0);
    if (width > historyCols) {
      historyCols = width;
      history.resize(historyCols, 1);
    }
    history.write(lines.map((l) => `\x1b[0m${l}\r\n`).join(""));
  }

  function setHistory(lines) {
    const kept = lines.slice(-HISTORY_LIMIT);
    newHistory(0);
    historyLines = kept;
    if (kept.length) writeHistory(kept);
  }
  newHistory(0);

  function viewportTop(buf) {
    return Math.max(0, buf.length - rows);
  }

  function scrollbackCount() {
    const buf = screen.buffer.active;
    if (buf.type === "normal") screenScrollback = viewportTop(buf);
    return screenScrollback;
  }

  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },

    writeScreen(text) {
      screen.write(text);
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
    registerOscHandler(id, cb) {
      return screen.parser.registerOscHandler(id, cb);
    },
    modes() {
      return modes;
    },
    takeQueries() {
      const q = queries;
      queries = "";
      return q;
    },

    historyRowCount() {
      return historyLines.length;
    },
    historyRow(i) {
      return history.buffer.active.getLine(i);
    },
    screenScrollbackCount: scrollbackCount,
    screenScrollbackRow(i) {
      return screen.buffer.normal.getLine(i);
    },
    viewportRow(r) {
      const buf = screen.buffer.active;
      return buf.getLine(viewportTop(buf) + r);
    },
    cursor() {
      const buf = screen.buffer.active;
      return { x: buf.cursorX, y: buf.cursorY - viewportTop(buf) };
    },
    // The cursor's row in display coordinates: history, then normal-screen
    // scrollback, then the screen viewport.
    cursorDisplayRow() {
      return historyLines.length + scrollbackCount() + this.cursor().y;
    },

    setHistory,
    clearHistory() {
      setHistory([]);
    },
    // Extend history with the captured tail. Returns false when the tail no
    // longer continues the local history and a full reload is needed.
    mergeHistoryTail(tail) {
      if (tail.length === 0) return historyLines.length === 0;
      const overlap = suffixPrefixOverlap(historyLines, tail);
      if (overlap === 0 && historyLines.length > 0) return false;
      const fresh = tail.slice(overlap);
      if (fresh.length === 0) return true;
      if (historyLines.length + fresh.length > HISTORY_LIMIT) return false;
      historyLines = historyLines.concat(fresh);
      writeHistory(fresh);
      return true;
    },

    dispose() {
      for (const sub of subs.splice(0)) sub?.dispose?.();
      history?.dispose();
      screen.dispose();
    },
  };
}
