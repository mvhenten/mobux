// The redraw writer (issue #315): the only thing that writes into xterm, the
// display that cannot draw a buffer it does not own. It draws the engine's
// buffer (terminal-buffer.js) as plain VT:
// history and normal-screen scrollback lines are appended to the display's
// scrollback once, and the viewport is repainted from the screen.

import { isBlankCell, logicalLines } from "./terminal-buffer.js";
import { createPaintScheduler } from "./paint-frame.js";

const FLAGS = [
  ["isBold", 1],
  ["isDim", 2],
  ["isItalic", 3],
  ["isUnderline", 4],
  ["isBlink", 5],
  ["isInverse", 7],
  ["isInvisible", 8],
  ["isStrikethrough", 9],
];

function cellStyle(cell) {
  const p = ["0"];
  for (const [method, code] of FLAGS) if (cell[method]?.()) p.push(code);
  const fg = colour(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30);
  if (fg) p.push(fg);
  const bg = colour(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40);
  if (bg) p.push(bg);
  return `\x1b[${p.join(";")}m`;
}

function colour(isRGB, isPalette, value, base) {
  if (isRGB) {
    return `${base + 8};2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
  }
  if (!isPalette || value < 0) return null;
  if (value < 8) return `${base + value}`;
  if (value < 16) return `${base + 60 + value - 8}`;
  return `${base + 8};5;${value}`;
}

// The cells of one logical line: every row of a wrapped chain in full, the
// last row with trailing blanks trimmed.
function* lineCells(rows) {
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r];
    if (!line) continue;
    let end = line.length;
    if (r === rows.length - 1) {
      end = 0;
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        const w = cell.getWidth();
        if (w > 0 && !isBlankCell(cell)) end = x + w;
      }
    }
    for (let x = 0; x < end; x++) {
      const cell = line.getCell(x);
      if (cell.getWidth() > 0) yield cell;
    }
  }
}

const rowTail = (width, cols) => (width < cols ? "\x1b[0m\x1b[K" : "\x1b[0m");

// A logical line as the display rows it takes at `cols`, each row's text
// stating its own style, from its `skip`-th cell on. `cells` on the result
// counts the line's cells.
function serializeLine(rows, cols, skip = 0) {
  const out = [];
  let text = "";
  let style = "\x1b[0m";
  let used = 0;
  let cells = 0;
  for (const cell of lineCells(rows)) {
    if (cells++ < skip) continue;
    const w = cell.getWidth();
    if (used + w > cols) {
      out.push(text + rowTail(used, cols));
      text = style === "\x1b[0m" ? "" : style;
      used = 0;
    }
    const next = cellStyle(cell);
    if (next !== style) {
      text += next;
      style = next;
    }
    text += cell.getChars() || " ";
    used += w;
  }
  if (used > 0 || skip === 0) out.push(text + rowTail(used, cols));
  out.cells = cells;
  return out;
}

// A long line goes to the display in one write, so the display's own
// autowrap marks its continuation rows.
export function createRedrawWriter(buffer, renderer) {
  let committedHistory = 0;
  let committedHistoryStart = 0;
  let committedScreen = 0;
  let lastScreenRow = null;
  // The last history line committed, to append to it when it grows.
  let committedLast = null;
  let painted = [];
  let cursorKey = "";
  let drawnModes = new Map();
  let full = true;
  let drawing = null;
  let disposed = false;

  function distanceFromBottom() {
    const { length, top } = renderer.viewport();
    return Math.max(0, length - renderer.rows - top);
  }

  let fullRedraws = 0;
  let paints = 0;

  function resetDisplay() {
    fullRedraws++;
    renderer.reset();
    committedHistory = 0;
    committedScreen = 0;
    lastScreenRow = null;
    committedLast = null;
    painted = [];
    cursorKey = "";
    drawnModes = new Map();
    full = false;
  }

  // Erasing a whole row first clears a wrapped flag left on it.
  //
  // Paint on the viewport's top row, then scroll as many rows from the
  // bottom row so it lands in the display's scrollback.
  function commitLines(lines, cols, rows) {
    let out = "\x1b[0m";
    const commit = (text, count) =>
      `\x1b[1;1H\x1b[2K${text}\x1b[${rows};1H${"\n".repeat(count)}`;
    for (const { rows: line, index, skip = 0 } of lines) {
      const displayRows = serializeLine(line, cols, skip);
      if (!displayRows.length) continue;
      if (index !== undefined) {
        committedLast = {
          index,
          cells: displayRows.cells,
          revision: buffer.lastLineRevision(),
        };
      }
      if (displayRows.length < rows) {
        out += commit(displayRows.join(""), displayRows.length);
      } else {
        for (const text of displayRows) out += commit(text, 1);
      }
    }
    return out;
  }

  function paintViewport(cols, rows) {
    let out = "";
    let r = 0;
    for (const line of logicalLines(buffer.viewportRows())) {
      const displayRows = serializeLine(line, cols).slice(0, rows - r);
      const text = displayRows.join("\n");
      if (painted[r] !== text) {
        painted[r] = text;
        for (let i = 1; i < displayRows.length; i++) painted[r + i] = null;
        out += `\x1b[${r + 1};1H\x1b[2K${displayRows.join("")}`;
      }
      r += displayRows.length;
      if (r >= rows) break;
    }
    return out;
  }

  // Only the row count changed (a soft keyboard opening or closing): with
  // the cursor on the top row, a display adds or drops rows below it and
  // leaves its scrollback alone, so only the viewport needs repainting.
  async function resizeRows(rows) {
    await renderer.write("\x1b[H");
    renderer.resize(renderer.cols, rows);
    painted = [];
    cursorKey = "";
  }

  async function draw() {
    if (disposed) return undefined;
    const cols = buffer.cols;
    const rows = buffer.rows;
    const keep = distanceFromBottom();
    if (renderer.cols !== cols) {
      renderer.resize(cols, rows);
      full = true;
    } else if (renderer.rows !== rows) {
      if (full) renderer.resize(cols, rows);
      else await resizeRows(rows);
    }
    const historyRows = buffer.historyRowCount();
    const historyStart = buffer.historyStart();
    const screenRows = buffer.screenScrollbackCount();
    const backlog = buffer.scrollbackRows(committedScreen);
    const redraw =
      full ||
      historyStart !== committedHistoryStart ||
      historyRows < committedHistory ||
      screenRows < committedScreen ||
      (historyRows > committedHistory && committedScreen > 0) ||
      logicalLines([lastScreenRow, ...backlog])[0].length > 1 ||
      (committedLast !== null &&
        committedLast.revision !== buffer.lastLineRevision() &&
        committedLast.index !== committedHistory - 1);
    if (redraw) resetDisplay();
    committedHistoryStart = historyStart;

    const fresh = [];
    const grew =
      committedLast &&
      committedLast.index === committedHistory - 1 &&
      committedLast.revision !== buffer.lastLineRevision();
    if (grew) {
      fresh.push({
        rows: [buffer.historyRow(committedLast.index)],
        index: committedLast.index,
        skip: committedLast.cells,
      });
    }
    for (let i = committedHistory; i < historyRows; i++) {
      fresh.push({ rows: [buffer.historyRow(i)], index: i });
    }
    const screenRowsNew = redraw ? buffer.scrollbackRows() : backlog;
    for (const line of logicalLines(screenRowsNew)) {
      fresh.push({ rows: line });
      lastScreenRow = line.at(-1);
    }
    committedHistory = historyRows;
    committedScreen = screenRows;

    let out = "";
    if (fresh.length) {
      out += commitLines(fresh, cols, rows);
      painted = [];
    }
    out += paintViewport(cols, rows);

    const { x, y } = buffer.cursor();
    const nextCursor = `${y};${x}`;
    if (out || nextCursor !== cursorKey) {
      out += `\x1b[${y + 1};${x + 1}H`;
      cursorKey = nextCursor;
    }
    for (const [mode, on] of buffer.modes()) {
      if (drawnModes.get(mode) === on) continue;
      drawnModes.set(mode, on);
      out += `\x1b[?${mode}${on ? "h" : "l"}`;
    }
    if (!out) return undefined;
    paints++;
    const written = renderer.write(out);
    if (!redraw || keep === 0) return written;
    return written.then(() => renderer.scrollLines(-keep));
  }

  const frames = createPaintScheduler(buffer, () => {
    if (drawing) return drawing.then(() => frames.request());
    drawing = draw().finally(() => {
      drawing = null;
    });
    return drawing;
  });

  return {
    // Bring the display up to date with the buffer: now, or on the next
    // frame when this one is already painted or a draw is still reaching the
    // display. The promise resolves once the display reflects it.
    flush() {
      return frames.request();
    },
    // Resolves once every requested draw has reached the display.
    settle() {
      return Promise.resolve(frames.pending()).then(() => drawing);
    },
    invalidate() {
      full = true;
    },
    setSyncHold: (ms) => frames.setSyncHold(ms),
    fullRedraws() {
      return fullRedraws;
    },
    paints() {
      return paints;
    },
    dispose() {
      disposed = true;
      frames.dispose();
    },
  };
}
