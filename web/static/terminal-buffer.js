// The engine's one text buffer (issue #315). Two headless xterm.js terminals,
// each fed from exactly one source and parsed once:
//
//   screen   the tmux client screen, fed by the WebSocket stream. The
//            alternate screen is allowed; tmux's client lives on it, so it
//            keeps no scrollback. Its last row is the tmux status line.
//   history  the pane's tmux history above the visible screen, one entry
//            per logical line, fed by capture-pane (scope=history). Syncs
//            line a captured tail (or, failing that, the whole history) up
//            with what is held and append what is new. Lines tmux drops off
//            its top are kept until the display's row budget is spent.
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

// A held line matches its captured counterpart when equal. The last held
// line also matches the start of it when it straddled the top of the
// screen (`grows`): such a line is captured only up to there, and whole
// once it has scrolled off.
function suffixMatches(held, next, from, count, grows) {
  for (let j = 0; j < count; j++) {
    const a = held[from + j];
    const b = next[j];
    if (a === b) continue;
    if (grows && from + j === held.length - 1 && b.startsWith(a)) continue;
    return false;
  }
  return true;
}

// How a whole captured history lines up with the one held. tmux appends
// lines, drops a tenth of its limit off the top once it reaches it, and
// moves lines back onto the screen when the pane grows. So the capture is
// the held history from line `drop` on — its last line possibly grown —
// followed by new lines; or, after the pane grew, only its next `keep`
// lines. Null when nothing lines up.
export function alignHistory(held, next, grows = false) {
  const L = held.length;
  if (L === 0) return { drop: 0, keep: 0, extended: false };
  for (let drop = 0; drop < L; drop++) {
    const keep = L - drop;
    if (keep > next.length) continue;
    if (suffixMatches(held, next, drop, keep, grows)) {
      return { drop, keep, extended: next[keep - 1] !== held[L - 1] };
    }
  }
  for (let drop = 0; drop < L; drop++) {
    const keep = Math.min(L - drop, next.length);
    if (keep === 0 || keep === L - drop) continue;
    let match = true;
    for (let j = 0; j < keep && match; j++) match = held[drop + j] === next[j];
    if (match) return { drop, keep, extended: false };
  }
  return null;
}

// How a captured tail (the last lines of tmux's history) continues the
// held history: it must overlap the held end on exactly one run of at
// least `minOverlap` lines. Anything else — no overlap, more new lines
// than the tail can show, or repeating output that fits several ways — is
// null, and the caller fetches the whole history instead.
export function alignTail(held, tail, minOverlap, grows = false) {
  const L = held.length;
  if (L === 0) return { overlap: 0, extended: false };
  let found = null;
  for (let o = Math.min(L, tail.length); o > 0; o--) {
    if (!suffixMatches(held, tail, L - o, o, grows)) continue;
    if (found !== null) return null;
    found = o;
  }
  if (found === null || found < Math.min(minOverlap, L)) return null;
  return { overlap: found, extended: tail[found - 1] !== held[L - 1] };
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

// Upper bound on a line's cell width.
function lineWidth(line) {
  let width = 0;
  for (const ch of line.replace(ESC_RE, "")) {
    width += ch.codePointAt(0) >= 0x1100 ? 2 : 1;
  }
  return width;
}

// Upper bound on the display rows a line takes at `cols` (a wide character
// that does not fit a row's end moves to the next one).
export function displayRowsOf(line, cols) {
  return Math.max(1, Math.ceil(lineWidth(line) / Math.max(1, cols - 1)));
}

// `scrollback` is the display's: history and normal-screen scrollback
// rows together never exceed it, so the display never trims on its own.
export function createTerminalBuffer({ cols, rows, scrollback }) {
  const Headless = window.XtermHeadless;
  if (!Headless || !Headless.Terminal) {
    throw new Error(
      "xterm headless bundle not loaded — check vendor/xterm-headless.bundle.js",
    );
  }
  const screenLimit = Math.min(SCREEN_SCROLLBACK, Math.floor(scrollback / 10));
  const historyBudget = scrollback - screenLimit;
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

  // Two rows, so the last line stays on screen and can be rewritten when it
  // grows; everything above it is scrollback.
  const newHistory = (width) =>
    newTerminal({ cols: width, rows: 2, scrollback: historyBudget + 10 });
  let history = newHistory(cols);
  let historyCols = cols;
  let historyLines = [];
  // The key of the first history line: keys stay with their line.
  let historyStart = 0;
  let lastContinues = false;
  let lastRevision = 0;
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

  function widen(lines) {
    const width = lines.reduce((w, l) => Math.max(w, lineWidth(l)), 0);
    if (width <= historyCols) return;
    historyCols = width;
    history.resize(historyCols, 2);
  }

  async function extendLast(line) {
    widen([line]);
    await write(history, `\x1b[A\r\x1b[2K\x1b[0m${line}\r\n`);
    historyLines = historyLines.slice(0, -1).concat([line]);
    lastRevision++;
  }

  async function append(fresh) {
    if (!fresh.length) return;
    widen(fresh);
    await write(history, historyText(fresh));
    historyLines = historyLines.concat(fresh);
  }

  // Past the row budget, drop lines off the top down to two thirds of it,
  // so the display redraws once per third of a budget, not per line.
  async function cap() {
    const rowsOf = historyLines.map((l) => displayRowsOf(l, cols));
    let total = rowsOf.reduce((a, b) => a + b, 0);
    if (total <= historyBudget) return;
    let drop = 0;
    while (total > (historyBudget * 2) / 3) total -= rowsOf[drop++];
    await rebuild(historyLines.slice(drop), historyStart + drop);
  }

  const end = () => historyStart + historyLines.length;

  async function syncWhole(raw, continues) {
    const next = normalizeCapture(raw);
    const before = end();
    const aligned = alignHistory(historyLines, next, lastContinues);
    let result = { replaced: false, before };
    if (!aligned) {
      await rebuild(next, before);
      result = { replaced: true, before };
    } else if (aligned.keep === historyLines.length - aligned.drop) {
      if (aligned.extended) await extendLast(next[aligned.keep - 1]);
      await append(next.slice(aligned.keep));
    } else {
      const kept = historyLines.slice(0, aligned.drop);
      await rebuild(kept.concat(next), historyStart);
    }
    lastContinues = continues;
    await cap();
    return { ...result, after: end() };
  }

  async function syncTail(raw, continues, minOverlap) {
    const tail = normalizeCapture(raw);
    const aligned = alignTail(historyLines, tail, minOverlap, lastContinues);
    if (!aligned) return null;
    const before = end();
    if (aligned.extended) await extendLast(tail[aligned.overlap - 1]);
    await append(tail.slice(aligned.overlap));
    lastContinues = continues;
    await cap();
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

  // The screen's first line is the rest of the last history line when that
  // one straddles the top of the screen.
  const straddles = () =>
    lastContinues &&
    historyLines.length > 0 &&
    screen.buffer.normal.baseY === 0;

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
      queue(cap);
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
    // Bumped each time the last history line is rewritten because it grew.
    lastLineRevision() {
      return lastRevision;
    },
    straddles,
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
    // screen's scrollback lines, then the viewport's lines — the first of
    // which shares the last history line's key while it straddles.
    screenKeyBase() {
      const base = end() + logicalLines(scrollbackRows()).length;
      return straddles() ? base - 1 : base;
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

    // A whole capture. Lines that line up keep their key; with nothing
    // lined up (history cleared) the old keys are gone and the screen's
    // move from `before` to `after`.
    syncWhole(raw, continues) {
      return queue(() => syncWhole(raw, continues));
    },
    // A captured tail; null when it cannot be placed.
    syncTail(raw, continues, minOverlap) {
      return queue(() => syncTail(raw, continues, minOverlap));
    },
    clearHistory() {
      return queue(async () => {
        const before = end();
        await rebuild([], before);
        lastContinues = false;
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
