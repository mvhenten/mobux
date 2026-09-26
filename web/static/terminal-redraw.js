// The redraw writer (issue #315): the only thing that writes into a display
// renderer. It draws the engine's buffer (terminal-buffer.js) as plain VT:
// history and normal-screen scrollback rows are appended to the display's
// scrollback once, and the viewport is repainted row by row from the screen.
// The display never sees the tmux stream, so it never switches screens and
// its scrollback holds exactly the buffer's rows.

function cellStyle(cell) {
  const p = ["0"];
  if (cell.isBold()) p.push("1");
  if (cell.isDim()) p.push("2");
  if (cell.isItalic()) p.push("3");
  if (cell.isUnderline()) p.push("4");
  if (cell.isInverse()) p.push("7");
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
    !cell.isUnderline()
  );
}

// A buffer row as display chunks at most `cols` cells wide, trailing blanks
// trimmed. `limit` caps the number of chunks (the viewport takes one).
function serializeRow(line, cols, limit = Infinity) {
  if (!line) return [{ text: "", width: 0 }];
  let end = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    const w = cell.getWidth();
    if (w > 0 && !isBlank(cell)) end = x + w;
  }
  const chunks = [];
  let text = "";
  let width = 0;
  let style = "\x1b[0m";
  for (let x = 0; x < end; x++) {
    const cell = line.getCell(x);
    const w = cell.getWidth();
    if (w === 0) continue;
    if (width + w > cols) {
      chunks.push({ text, width });
      if (chunks.length >= limit) return chunks;
      text = style === "\x1b[0m" ? "" : style;
      width = 0;
    }
    const next = cellStyle(cell);
    if (next !== style) {
      text += next;
      style = next;
    }
    text += cell.getChars() || " ";
    width += w;
  }
  chunks.push({ text, width });
  return chunks;
}

function rowTail(width, cols) {
  return width < cols ? "\x1b[0m\x1b[K" : "\x1b[0m";
}

export function createRedrawWriter(buffer, renderer) {
  let committedHistory = 0;
  let committedScreen = 0;
  let painted = [];
  let cursorKey = "";
  let drawnModes = new Map();
  let full = true;
  let queue = Promise.resolve();
  let pending = null;
  let disposed = false;

  function resetDisplay() {
    renderer.reset();
    committedHistory = 0;
    committedScreen = 0;
    painted = [];
    cursorKey = "";
    drawnModes = new Map();
    full = false;
  }

  // Paint each row on the viewport's top line, then scroll one line from the
  // bottom so it lands in the display's scrollback. Only absolute cursor
  // moves and a linefeed on the last row: both displays agree on those.
  function commitRows(lines, cols, rows) {
    let out = "\x1b[0m";
    for (const line of lines) {
      for (const { text, width } of serializeRow(line, cols)) {
        out += `\x1b[1;1H${text}${rowTail(width, cols)}\x1b[${rows};1H\n`;
      }
    }
    return out;
  }

  function paintViewport(cols, rows) {
    let out = "";
    for (let r = 0; r < rows; r++) {
      const [{ text, width }] = serializeRow(buffer.viewportRow(r), cols, 1);
      if (painted[r] === text) continue;
      painted[r] = text;
      out += `\x1b[${r + 1};1H${text}${rowTail(width, cols)}`;
    }
    return out;
  }

  function draw() {
    if (disposed) return undefined;
    const cols = buffer.cols;
    const rows = buffer.rows;
    if (renderer.cols !== cols || renderer.rows !== rows) {
      renderer.resize(cols, rows);
      full = true;
    }
    const historyRows = buffer.historyRowCount();
    const screenRows = buffer.screenScrollbackCount();
    if (
      full ||
      historyRows < committedHistory ||
      screenRows < committedScreen ||
      (historyRows > committedHistory && committedScreen > 0)
    ) {
      resetDisplay();
    }

    let out = "";
    const fresh = [];
    for (let i = committedHistory; i < historyRows; i++) {
      fresh.push(buffer.historyRow(i));
    }
    for (let i = committedScreen; i < screenRows; i++) {
      fresh.push(buffer.screenScrollbackRow(i));
    }
    committedHistory = historyRows;
    committedScreen = screenRows;
    if (fresh.length) {
      out += commitRows(fresh, cols, rows);
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
    out += buffer.takeQueries();
    return out ? renderer.write(out) : undefined;
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
    // Redraw everything on the next flush (resize, history replaced).
    invalidate() {
      full = true;
    },
    dispose() {
      disposed = true;
    },
  };
}
