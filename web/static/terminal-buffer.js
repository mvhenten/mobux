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

import { serializeRow } from "./terminal-redraw.js";

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

  const newScreen = () =>
    Sterk.createTerminal({
      cols,
      rows,
      scrollback: SCREEN_SCROLLBACK,
      font: "",
    });
  let screen = newScreen();
  screen.write("\x1b[?1049h");

  // Everything subscribed to the screen parser, re-attached when a resize
  // rebuilds it: [attach(screen) → Disposable, current Disposable].
  const hooks = [];
  function hook(attach) {
    const entry = { attach, sub: attach(screen) };
    hooks.push(entry);
    return {
      dispose() {
        entry.sub?.dispose?.();
        const i = hooks.indexOf(entry);
        if (i >= 0) hooks.splice(i, 1);
      },
    };
  }

  const modes = new Map(MIRRORED_MODES.map((m) => [m, m === 25]));
  let queries = "";
  const scalar = (p) => (Array.isArray(p) ? p[0] : p);
  for (const final of ["h", "l"]) {
    hook((t) =>
      t.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
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
    hook((t) =>
      t.parser.registerCsiHandler({ prefix, final: "c" }, (params) => {
        queries += `\x1b[${prefix}${params.map(scalar).join(";")}c`;
        return false;
      }),
    );
  }

  // Sterk's resize keeps the old line count, which breaks its cursor and
  // scrolling, so a resize rebuilds the screen at the new size and replays
  // its content: the normal screen up to the cursor, then the alternate
  // screen's rows (tmux repaints them after the resize anyway).
  function rebuildScreen(oldRows) {
    const old = screen;
    const normal = old.buffer.normal;
    const onAlt = old.buffer.active.type === "alternate";
    const lines = [];
    for (let y = 0; y < normal.length; y++) {
      lines.push(serializeRow(normal.getLine(y), cols, 1)[0].text);
    }
    const end = onAlt
      ? lines.findLastIndex((l) => l !== "") + 1
      : normal.cursorY + 1;
    lines.length = Math.min(lines.length, end);
    let replay = lines.join("\x1b[0m\r\n") + "\x1b[0m";
    if (!onAlt) {
      replay += `\r${normal.cursorX ? `\x1b[${normal.cursorX}C` : ""}`;
    } else {
      const alt = old.buffer.active;
      const top = Math.max(0, alt.length - oldRows);
      replay += "\x1b[?1049h";
      for (let r = 0; r < rows && top + r < alt.length; r++) {
        const { text } = serializeRow(alt.getLine(top + r), cols, 1)[0];
        replay += `\x1b[${r + 1};1H${text}\x1b[0m`;
      }
      const cursorRow = Math.min(rows, alt.cursorY - top + 1);
      replay += `\x1b[${cursorRow};${alt.cursorX + 1}H`;
    }
    for (const entry of hooks) entry.sub?.dispose?.();
    screen = newScreen();
    screen.write(replay);
    for (const entry of hooks) entry.sub = entry.attach(screen);
    old.dispose();
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
      const oldRows = rows;
      cols = nextCols;
      rows = nextRows;
      rebuildScreen(oldRows);
    },

    isAlternate() {
      return screen.buffer.active.type === "alternate";
    },
    onBell(cb) {
      return hook((t) => t.onBell(cb));
    },
    registerOscHandler(id, cb) {
      return hook((t) => t.parser.registerOscHandler(id, cb));
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
      for (const entry of hooks.splice(0)) entry.sub?.dispose?.();
      history?.dispose();
      screen.dispose();
    },
  };
}
