// The engine's one text buffer (issue #315). Two headless xterm.js terminals,
// each fed from exactly one source and parsed once:
//
//   screen   the tmux client screen, fed by the WebSocket stream. The
//            alternate screen is allowed; tmux's client lives on it, so it
//            keeps no scrollback. Its last row is the tmux status line.
//   history  the pane's tmux history above the visible screen, fed by
//            capture-pane (scope=history) and extended from its tail.
//
// Displays draw from this buffer through terminal-redraw.js.

const SCREEN_SCROLLBACK = 1000;
const TRIM_SLACK = 1000;
// A tail is appended only after this many of its lines match the end of the
// local history, at least one of them not blank.
const MIN_ANCHOR = 3;

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

const isBlankLine = (line) => line.replace(ESC_RE, "").trim() === "";

function suffixMatches(local, tail, o) {
  for (let j = 0; j < o; j++) {
    if (local[local.length - o + j] !== tail[j]) return false;
  }
  return true;
}

// How a captured tail extends the local history. Both are normalized lines;
// `info` is tmux's { size, limit } when the capture reported it.
//   { kind: "append", lines }   new lines after the local history
//   { kind: "replace", lines }  the tail is the whole history; take it
//   { kind: "reload" }          the tail cannot be placed; fetch it all
export function planHistoryMerge({ local, localInfo, tail, tailInfo }) {
  const whole = tailInfo && tail.length === tailInfo.size;
  if (tail.length === 0) {
    return local.length === 0 ? { kind: "append", lines: [] } : fallback();
  }
  if (local.length === 0) return { kind: "append", lines: tail };

  function fallback() {
    return whole ? { kind: "replace", lines: tail } : { kind: "reload" };
  }

  // Below tmux's limit nothing leaves the top of its history, so the growth
  // in size is exactly the number of new lines.
  if (localInfo && tailInfo && tailInfo.size < tailInfo.limit) {
    const grown = tailInfo.size - localInfo.size;
    const overlap = Math.min(tail.length - grown, local.length);
    if (grown < 0 || overlap <= 0) return fallback();
    if (!suffixMatches(local, tail, overlap)) return fallback();
    return { kind: "append", lines: tail.slice(tail.length - grown) };
  }

  const candidates = [];
  const max = Math.min(local.length, tail.length);
  for (let o = MIN_ANCHOR; o <= max; o++) {
    if (!suffixMatches(local, tail, o)) continue;
    if (tail.slice(0, o).every(isBlankLine)) continue;
    candidates.push(o);
    if (candidates.length > 1) return fallback();
  }
  if (candidates.length !== 1) return fallback();
  return { kind: "append", lines: tail.slice(candidates[0]) };
}

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

const historyText = (lines) => lines.map((l) => `\x1b[0m${l}\r\n`).join("");

// Upper bound on a line's cell width, so the history terminal is wide enough
// that every captured line stays one row.
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
  const trimTo = Math.max(1, historyLimit - TRIM_SLACK);
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
  let historyInfo = null;
  // Lines trimmed off the top so far: line keys stay stable across a trim.
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
    const total = historyLines.length + fresh.length;
    if (total > historyLimit) {
      const drop = total - trimTo;
      await rebuild(
        historyLines.concat(fresh).slice(drop),
        historyStart + drop,
      );
      return;
    }
    const width = fresh.reduce((w, l) => Math.max(w, lineWidth(l)), 0);
    if (width > historyCols) {
      historyCols = width;
      history.resize(historyCols, 1);
    }
    await write(history, historyText(fresh));
    historyLines = historyLines.concat(fresh);
  }

  const end = () => historyStart + historyLines.length;

  async function replace(lines, info) {
    const before = end();
    await rebuild(
      lines.slice(-historyLimit),
      Math.max(0, lines.length - historyLimit),
    );
    historyInfo = info;
    return { replaced: true, before, after: end() };
  }

  // Logical lines above absolute screen-buffer row `y` of `buf`: a row that
  // continues a wrapped line adds none.
  function logicalLinesBefore(buf, y) {
    let n = 0;
    for (let i = 1; i <= y; i++) {
      if (!buf.getLine(i)?.isWrapped) n++;
    }
    return n;
  }

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
    // The cursor's logical line as a stable key: history lines (counted from
    // the first line ever held), then normal-screen scrollback, then the
    // screen viewport, with wrapped rows joined.
    cursorLineKey() {
      const normal = screen.buffer.normal;
      const active = screen.buffer.active;
      let lines;
      if (active.type === "normal") {
        lines = logicalLinesBefore(normal, normal.baseY + normal.cursorY);
      } else {
        const scrolled = normal.baseY;
        lines =
          (scrolled > 0 ? logicalLinesBefore(normal, scrolled - 1) + 1 : 0) +
          logicalLinesBefore(active, active.cursorY);
      }
      return end() + lines;
    },

    setHistory(raw, info) {
      return queue(() => replace(normalizeCapture(raw), info));
    },
    clearHistory() {
      return queue(() => replace([], null));
    },
    // Extend history with a captured tail. Resolves null when the tail cannot
    // be placed and a full reload is needed; otherwise what moved.
    mergeHistoryTail(raw, info) {
      return queue(async () => {
        const tail = normalizeCapture(raw);
        const plan = planHistoryMerge({
          local: historyLines,
          localInfo: historyInfo,
          tail,
          tailInfo: info,
        });
        if (plan.kind === "reload") return null;
        if (plan.kind === "replace") return replace(plan.lines, info);
        const before = end();
        if (plan.lines.length) await append(plan.lines);
        historyInfo = info;
        return { replaced: false, before, after: end() };
      });
    },

    dispose() {
      for (const sub of subs) sub.dispose();
      history.dispose();
      screen.dispose();
    },
  };
}
