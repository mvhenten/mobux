// The redraw writer (issue #315): the only thing that writes into a display
// renderer. It draws the engine's buffer (terminal-buffer.js) as plain VT:
// history and normal-screen scrollback lines are appended to the display's
// scrollback once, and the viewport is repainted from the screen.

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

function isBlank(cell) {
  const ch = cell.getChars();
  return (
    (ch === "" || ch === " ") &&
    cell.isBgDefault() &&
    !cell.isInverse() &&
    !cell.isUnderline() &&
    !cell.isStrikethrough?.()
  );
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
        if (w > 0 && !isBlank(cell)) end = x + w;
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
// stating its own style.
function serializeLine(rows, cols) {
  const out = [];
  let text = "";
  let style = "\x1b[0m";
  let used = 0;
  for (const cell of lineCells(rows)) {
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
  out.push(text + rowTail(used, cols));
  return out;
}

// A wrapped flag outlives the text that set it (a row rewritten shorter
// after an autowrap keeps it), so a row only continues a line whose last
// column still holds text.
function reachesEdge(line) {
  const cell = line?.getCell(line.length - 1);
  return !!cell && (cell.getWidth() === 0 || !isBlank(cell));
}

// Group rows into logical lines by their wrapped flag.
function logicalLines(rows) {
  const lines = [];
  for (const row of rows) {
    const prev = lines.at(-1)?.at(-1);
    if (row?.isWrapped && reachesEdge(prev)) lines.at(-1).push(row);
    else lines.push([row]);
  }
  return lines;
}

// A display that keeps wrapped rows gets a long line in one write, so its
// own autowrap marks the continuation rows; any other display gets each row
// placed on its own.
export function createRedrawWriter(buffer, renderer) {
  const wraps = renderer.keepsWrappedRows === true;
  let committedHistory = 0;
  let committedHistoryStart = 0;
  let committedScreen = 0;
  let painted = [];
  let cursorKey = "";
  let drawnModes = new Map();
  let full = true;
  let queue = Promise.resolve();
  let pending = null;
  let disposed = false;

  function distanceFromBottom() {
    const buf = renderer.buffer.active;
    return Math.max(0, buf.length - renderer.rows - buf.viewportY);
  }

  function resetDisplay() {
    renderer.reset();
    committedHistory = 0;
    committedScreen = 0;
    painted = [];
    cursorKey = "";
    drawnModes = new Map();
    full = false;
  }

  // Erasing a whole row first clears a wrapped flag left on it.
  //
  // Paint on the viewport's top row, then scroll as many rows from the
  // bottom row so it lands in the display's scrollback. Only absolute cursor
  // moves and a linefeed on the last row: both displays agree on those.
  function commitLines(lines, cols, rows) {
    let out = "\x1b[0m";
    const commit = (text, count) =>
      `\x1b[1;1H\x1b[2K${text}\x1b[${rows};1H${"\n".repeat(count)}`;
    for (const line of lines) {
      const displayRows = serializeLine(line, cols);
      if (wraps && displayRows.length < rows) {
        out += commit(displayRows.join(""), displayRows.length);
      } else {
        for (const text of displayRows) out += commit(text, 1);
      }
    }
    return out;
  }

  function paintViewport(cols, rows) {
    const viewport = [];
    for (let r = 0; r < rows; r++) viewport.push(buffer.viewportRow(r));
    let out = "";
    let r = 0;
    for (const line of logicalLines(viewport)) {
      const displayRows = serializeLine(line, cols).slice(0, rows - r);
      const key = displayRows.join("\n");
      if (painted[r] !== key) {
        painted[r] = key;
        for (let i = 1; i < displayRows.length; i++) painted[r + i] = null;
        if (wraps) {
          out += `\x1b[${r + 1};1H\x1b[2K${displayRows.join("")}`;
        } else {
          displayRows.forEach((text, i) => {
            out += `\x1b[${r + i + 1};1H\x1b[2K${text}`;
          });
        }
      }
      r += displayRows.length;
      if (r >= rows) break;
    }
    return out;
  }

  function draw() {
    if (disposed) return undefined;
    const cols = buffer.cols;
    const rows = buffer.rows;
    const keep = distanceFromBottom();
    if (renderer.cols !== cols || renderer.rows !== rows) {
      renderer.resize(cols, rows);
      full = true;
    }
    const historyRows = buffer.historyRowCount();
    const historyStart = buffer.historyStart();
    const screenRows = buffer.screenScrollbackCount();
    const redraw =
      full ||
      historyStart !== committedHistoryStart ||
      historyRows < committedHistory ||
      screenRows < committedScreen ||
      (historyRows > committedHistory && committedScreen > 0);
    if (redraw) resetDisplay();
    committedHistoryStart = historyStart;

    const fresh = [];
    for (let i = committedHistory; i < historyRows; i++) {
      fresh.push([buffer.historyRow(i)]);
    }
    const screenBacklog = [];
    for (let i = committedScreen; i < screenRows; i++) {
      screenBacklog.push(buffer.screenScrollbackRow(i));
    }
    fresh.push(...logicalLines(screenBacklog));
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
    const written = renderer.write(out);
    if (!redraw || keep === 0) return written;
    return written.then(() => renderer.scrollLines(-keep));
  }

  return {
    // Bring the display up to date with the buffer. Calls made while a draw
    // is queued share it; the promise resolves once the display reflects it.
    flush() {
      if (pending) return pending;
      pending = queue = queue.then(() => {
        pending = null;
        return draw();
      });
      return pending;
    },
    invalidate() {
      full = true;
    },
    dispose() {
      disposed = true;
    },
  };
}
