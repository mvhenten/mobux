// The engine's one text buffer (issue #315). Two headless xterm.js terminals,
// each fed from exactly one source and parsed once:
//
//   screen   the tmux client screen, fed by the WebSocket stream. The
//            alternate screen is allowed; tmux's client lives on it, so it
//            keeps no scrollback. Its last row is the tmux status line.
//   history  the pane's tmux history above the visible screen, one entry
//            per logical line, fed by capture-pane (scope=history). Each
//            sync fetches it whole and lines it up with what is held.
//
// Displays draw from this buffer through terminal-redraw.js.

const SCREEN_SCROLLBACK = 1000;

const MIRRORED_MODES = [1, 25, 2004];

const ESC_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/g;

const DEFAULT_STYLE = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strike: false,
  fg: null,
  bg: null,
};

const FLAG_ON = {
  1: "bold",
  2: "dim",
  3: "italic",
  4: "underline",
  5: "blink",
  7: "inverse",
  8: "invisible",
  9: "strike",
};
const FLAG_OFF = {
  22: ["bold", "dim"],
  23: ["italic"],
  24: ["underline"],
  25: ["blink"],
  27: ["inverse"],
  28: ["invisible"],
  29: ["strike"],
};
const FLAG_SGR = [
  ["bold", 1],
  ["dim", 2],
  ["italic", 3],
  ["underline", 4],
  ["blink", 5],
  ["inverse", 7],
  ["invisible", 8],
  ["strike", 9],
];

// Extended colour: `38;5;n` / `38;2;r;g;b` (and 48/58). Returns the colour
// text and how many params it used.
function extendedColour(params, i) {
  if (params[i + 1] === "5") return [`5;${params[i + 2]}`, 3];
  if (params[i + 1] === "2") {
    return [`2;${params[i + 2]};${params[i + 3]};${params[i + 4]}`, 5];
  }
  return [null, 1];
}

function applySgr(style, body) {
  const params = body.replace(/:/g, ";").split(";");
  let next = { ...style };
  for (let i = 0; i < params.length;) {
    const p = params[i] === "" ? 0 : Number(params[i]);
    if (p === 0) next = { ...DEFAULT_STYLE };
    else if (FLAG_ON[p]) next[FLAG_ON[p]] = true;
    else if (FLAG_OFF[p]) for (const k of FLAG_OFF[p]) next[k] = false;
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) next.fg = `${p}`;
    else if (p === 39) next.fg = null;
    else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) next.bg = `${p}`;
    else if (p === 49) next.bg = null;
    else if (p === 38 || p === 48 || p === 58) {
      const [colour, used] = extendedColour(params, i);
      if (colour && p === 38) next.fg = `38;${colour}`;
      if (colour && p === 48) next.bg = `48;${colour}`;
      i += used;
      continue;
    }
    i += 1;
  }
  return next;
}

function styleSgr(style) {
  const p = ["0"];
  for (const [k, code] of FLAG_SGR) if (style[k]) p.push(code);
  if (style.fg) p.push(style.fg);
  if (style.bg) p.push(style.bg);
  return `\x1b[${p.join(";")}m`;
}

// capture-pane -e carries SGR state from one line into the next, so a line
// reads differently depending on where a capture starts. Rewrite every line
// to state its own style from the default: equal lines compare equal
// wherever the capture began, and each line parses on its own.
export function normalizeCapture(lines) {
  let style = { ...DEFAULT_STYLE };
  return lines.map((line) => {
    let out = "";
    let emitted = styleSgr(DEFAULT_STYLE);
    let last = 0;
    const text = (s) => {
      if (!s) return;
      const want = styleSgr(style);
      if (want !== emitted) {
        out += want;
        emitted = want;
      }
      out += s;
    };
    for (const m of line.matchAll(ESC_RE)) {
      text(line.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[0].startsWith("\x1b[") && m[0].endsWith("m")) {
        style = applySgr(style, m[0].slice(2, -1));
      } else {
        out += m[0];
      }
    }
    text(line.slice(last));
    return out;
  });
}

export function splitCapture(text) {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// How a freshly captured history lines up with the one held. tmux only
// appends lines, drops a block off the top once it reaches its limit, and
// moves lines back onto the screen when the pane grows, so the new history
// is the held one with `drop` lines gone from the top, then its next `keep`
// lines, then new ones. The result is the captured history whichever
// alignment is taken; the alignment only decides which lines keep their
// identity (and their markers). Null when nothing lines up.
export function alignHistory(held, next) {
  if (held.length === 0) return { drop: 0, keep: 0 };
  for (let drop = 0; drop < held.length; drop++) {
    if (held[drop] !== next[0]) continue;
    const keep = Math.min(held.length - drop, next.length);
    let match = true;
    for (let j = 1; j < keep; j++) {
      if (held[drop + j] !== next[j]) {
        match = false;
        break;
      }
    }
    if (match) return { drop, keep };
  }
  return null;
}

export function isBlankCell(cell) {
  const ch = cell.getChars();
  return (
    (ch === "" || ch === " ") &&
    cell.isBgDefault() &&
    !cell.isInverse() &&
    !cell.isUnderline() &&
    !cell.isStrikethrough?.()
  );
}

// A wrapped flag outlives the text that set it (a row rewritten shorter
// after an autowrap keeps it), so a row only continues a line whose last
// column still holds text.
function continuesLine(prev, row) {
  if (!row?.isWrapped || !prev) return false;
  const cell = prev.getCell(prev.length - 1);
  return !!cell && (cell.getWidth() === 0 || !isBlankCell(cell));
}

// Rows grouped into logical lines.
export function logicalLines(rows) {
  const lines = [];
  for (const row of rows) {
    if (lines.length && continuesLine(lines.at(-1).at(-1), row)) {
      lines.at(-1).push(row);
    } else {
      lines.push([row]);
    }
  }
  return lines;
}

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

const historyText = (lines) => lines.map((l) => `\x1b[0m${l}\r\n`).join("");

// Upper bound on a line's cell width, so the history terminal is wide enough
// that every line stays one row.
function lineWidth(line) {
  let width = 0;
  for (const ch of line.replace(ESC_RE, "")) {
    width += ch.codePointAt(0) >= 0x1100 ? 2 : 1;
  }
  return width;
}

// `scrollback` is the display's: history and normal-screen scrollback
// together never exceed it.
export function createTerminalBuffer({ cols, rows, scrollback }) {
  const Headless = window.XtermHeadless;
  if (!Headless || !Headless.Terminal) {
    throw new Error(
      "xterm headless bundle not loaded — check vendor/xterm-headless.bundle.js",
    );
  }
  const screenLimit = Math.min(SCREEN_SCROLLBACK, Math.floor(scrollback / 10));
  const historyLimit = scrollback - screenLimit;
  const newTerminal = (options) =>
    new Headless.Terminal({ allowProposedApi: true, ...options });

  const screen = newTerminal({ cols, rows, scrollback: screenLimit });

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

  const newHistory = (width) =>
    newTerminal({ cols: width, rows: 1, scrollback: historyLimit + 10 });
  let history = newHistory(cols);
  let historyCols = cols;
  let historyLines = [];
  // The key of the first history line: keys stay with their line as lines
  // leave the top.
  let historyStart = 0;
  let ops = Promise.resolve();

  function queue(op) {
    const run = ops.then(op);
    ops = run.catch(() => {});
    return run;
  }

  // Build the history terminal aside and swap it in once parsed, so a draw
  // never sees a half-parsed history.
  async function rebuild(lines, start) {
    const width = lines.reduce((w, l) => Math.max(w, lineWidth(l)), cols);
    const next = newHistory(width);
    if (lines.length) await write(next, historyText(lines));
    history.dispose();
    history = next;
    historyCols = width;
    historyLines = lines;
    historyStart = start;
  }

  async function append(fresh) {
    const width = fresh.reduce((w, l) => Math.max(w, lineWidth(l)), 0);
    if (width > historyCols) {
      historyCols = width;
      history.resize(historyCols, 1);
    }
    await write(history, historyText(fresh));
    historyLines = historyLines.concat(fresh);
  }

  const end = () => historyStart + historyLines.length;

  // Take a captured history. Resolves with the keys it moved: lines that
  // lined up keep theirs; with nothing lined up, the old lines' keys are
  // gone and the screen's move from `before` to `after`.
  async function sync(raw) {
    const next = normalizeCapture(raw).slice(-historyLimit);
    const before = end();
    const aligned = alignHistory(historyLines, next);
    if (!aligned) {
      await rebuild(next, before);
      return { replaced: true, before, after: end() };
    }
    const { drop, keep } = aligned;
    if (drop === 0 && keep === historyLines.length) {
      if (next.length > keep) await append(next.slice(keep));
    } else {
      await rebuild(next, historyStart + drop);
    }
    return { replaced: false, before, after: end() };
  }

  function viewportRows() {
    const buf = screen.buffer.active;
    const out = [];
    for (let r = 0; r < rows; r++) out.push(buf.getLine(buf.baseY + r));
    return out;
  }

  function scrollbackRows(from = 0) {
    const normal = screen.buffer.normal;
    const out = [];
    for (let i = from; i < normal.baseY; i++) out.push(normal.getLine(i));
    return out;
  }

  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    historyLimit,

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
    historyStart() {
      return historyStart;
    },
    screenScrollbackCount() {
      return screen.buffer.normal.baseY;
    },
    scrollbackRows,
    viewportRows,
    cursor() {
      const buf = screen.buffer.active;
      return { x: buf.cursorX, y: buf.cursorY };
    },
    // Line keys: history lines from `historyStart`, then the normal
    // screen's scrollback lines, then the viewport's lines.
    screenKeyBase() {
      return end() + logicalLines(scrollbackRows()).length;
    },
    cursorLineKey() {
      const y = screen.buffer.active.cursorY;
      let row = 0;
      let index = 0;
      for (const line of logicalLines(viewportRows())) {
        if (y < row + line.length) break;
        row += line.length;
        index++;
      }
      return this.screenKeyBase() + index;
    },

    sync(raw) {
      return queue(() => sync(raw));
    },
    clearHistory() {
      return queue(async () => {
        const before = end();
        await rebuild([], before);
        return { replaced: true, before, after: end() };
      });
    },

    dispose() {
      for (const sub of subs) sub.dispose();
      history.dispose();
      screen.dispose();
    },
  };
}
