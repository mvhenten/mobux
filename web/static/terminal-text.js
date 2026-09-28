// The engine buffer read as the display's rows (issue #315 keeps the buffer
// the source of truth): history lines cut at the pane width, the normal
// screen's scrollback, then the screen. Touch selection and long-press link
// detection read cells from here, never from a renderer, so xterm and sterk
// select the same text.

import { logicalLines } from "./terminal-buffer.js";
import { historyLine, lineCells } from "./terminal-lines.js";

// A row is { cells, wrapped }: one string per column, "" for the second
// column of a wide character; `wrapped` when it continues the row above.
function rowOfCells(cells, cols, wrapped) {
  const out = [];
  for (const cell of cells) {
    if (out.length >= cols) break;
    out.push(cell.getChars() || " ");
    if (cell.getWidth() === 2) out.push("");
  }
  while (out.length < cols) out.push(" ");
  return { cells: out.slice(0, cols), wrapped };
}

function rowOfLine(line, cols, wrapped) {
  const cells = [];
  for (let x = 0; x < cols; x++) {
    const cell = line?.getCell(x);
    if (!cell) {
      cells.push(" ");
      continue;
    }
    cells.push(cell.getWidth() === 0 ? "" : cell.getChars() || " ");
  }
  return { cells, wrapped };
}

function groupedRows(rows, cols) {
  const out = [];
  for (const line of logicalLines(rows)) {
    line.forEach((row, i) => out.push(rowOfLine(row, cols, i > 0)));
  }
  return out;
}

// A wide character that does not fit a row's end starts the next row.
function cutHistoryLine(buffer, i, cols) {
  const rows = [[]];
  let used = 0;
  for (const cell of lineCells(historyLine(buffer, i).segments)) {
    const width = cell.getWidth();
    if (used > 0 && used + width > cols) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1).push(cell);
    used += width;
  }
  return rows.map((cells, r) => rowOfCells(cells, cols, r > 0));
}

// The last `count` display rows, top to bottom; fewer when the display
// holds fewer.
export function rowsFromBottom(buffer, count) {
  const cols = buffer.cols;
  let rows = groupedRows(buffer.viewportRows(), cols);
  if (rows.length < count) {
    rows = groupedRows(buffer.scrollbackRows(), cols).concat(rows);
  }
  for (let i = buffer.historyRowCount() - 1; i >= 0; i--) {
    if (rows.length >= count) break;
    rows = cutHistoryLine(buffer, i, cols).concat(rows);
  }
  return rows.slice(Math.max(0, rows.length - count));
}

const URL_RE = /https?:\/\/[^\s)"'>]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'">]+$/;

// The logical line through row `index` of `rows` (an array of row objects),
// as { text, cells: [{ row, col }] } with one entry per character of text.
export function logicalLineAt(rows, index) {
  let first = index;
  while (first > 0 && rows[first]?.wrapped) first--;
  let last = index;
  while (rows[last + 1]?.wrapped) last++;
  let text = "";
  const cells = [];
  for (let r = first; r <= last; r++) {
    rows[r]?.cells.forEach((ch, col) => {
      if (ch === "") return;
      for (const unit of ch) {
        text += unit;
        cells.push({ row: r, col });
      }
    });
  }
  return { text, cells };
}

// The index into the line of the character drawn at (row, col); the second
// column of a wide character is the character itself.
function indexOfCell(rows, line, row, col) {
  const at = rows[row].cells[col] === "" && col > 0 ? col - 1 : col;
  return line.cells.findIndex((c) => c.row === row && c.col === at);
}

// The http(s) URL under cell (row, col), or null.
export function urlAt(rows, row, col) {
  if (!rows[row]) return null;
  const line = logicalLineAt(rows, row);
  const at = indexOfCell(rows, line, row, col);
  if (at === -1) return null;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(line.text)) !== null) {
    const url = m[0].replace(TRAILING_PUNCT_RE, "");
    if (at >= m.index && at < m.index + url.length) return url;
  }
  return null;
}

// The run of non-whitespace cells through (row, col) across the logical
// line, as { start, end } cell positions (end inclusive), or null on a
// blank cell.
export function wordAt(rows, row, col) {
  if (!rows[row]) return null;
  const line = logicalLineAt(rows, row);
  const at = indexOfCell(rows, line, row, col);
  if (at === -1 || /\s/.test(line.text[at])) return null;
  let from = at;
  while (from > 0 && !/\s/.test(line.text[from - 1])) from--;
  let to = at;
  while (to + 1 < line.text.length && !/\s/.test(line.text[to + 1])) to++;
  const start = line.cells[from];
  const end = line.cells[to];
  const endWide = rows[end.row].cells[end.col + 1] === "";
  return {
    start: { row: start.row, col: start.col },
    end: { row: end.row, col: endWide ? end.col + 1 : end.col },
  };
}

// The text from cell `start` to `end` (inclusive): wrapped rows join, a new
// logical line starts on "\n", trailing whitespace trimmed per line.
export function textBetween(rows, start, end) {
  const lines = [];
  let current = "";
  for (let r = start.row; r <= end.row; r++) {
    const row = rows[r];
    if (!row) continue;
    if (r > start.row && !row.wrapped) {
      lines.push(current);
      current = "";
    }
    const from = r === start.row ? start.col : 0;
    const to = r === end.row ? end.col : row.cells.length - 1;
    current += row.cells.slice(from, to + 1).join("");
  }
  lines.push(current);
  return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
}
