// The buffer's logical lines (issue #315), shared by the reader's document
// (terminal-document.js) and sterk's screen source
// (terminal-screen-source.js): one line per history line, then the normal
// screen's scrollback grouped into logical lines, then the pane's lines. A
// line is { segments, key }; a segment is { rows, trim, fill }: the rows of
// a wrapped chain run on, a history row ends at its last cell.

import { isBlankCell, logicalLines } from "./terminal-buffer.js";

// `fill` rounds a trimmed row's end up to a multiple of it: the part of a
// straddling line captured into history is whole screen rows, trailing
// blanks included.
function* rowCells(row, trim, fill) {
  let end = row.length;
  if (trim) {
    while (end > 0 && isBlankCell(row.getCell(end - 1))) end--;
    if (fill) end = Math.min(row.length, Math.ceil(end / fill) * fill);
  }
  for (let x = 0; x < end; x++) {
    const cell = row.getCell(x);
    if (cell && cell.getWidth() > 0) yield cell;
  }
}

// A line's cells, wide characters once.
export function* lineCells(segments) {
  for (const { rows, trim, fill } of segments) {
    for (const row of rows) {
      if (row) yield* rowCells(row, trim, fill);
    }
  }
}

// History line `i`. The last one, while it straddles the top of the pane,
// is whole screen rows: the pane's first line goes on from its end.
export function historyLine(buffer, i) {
  const last = i === buffer.historyRowCount() - 1;
  const fill = last && buffer.straddles() ? buffer.cols : undefined;
  return {
    segments: [{ rows: [buffer.historyRow(i)], trim: true, fill }],
    key: buffer.historyStart() + i,
  };
}

// The buffer's lines as { segments, key }, the straddling pane line joined
// onto the last history line.
export function bufferLines(buffer) {
  const lines = [];
  const start = buffer.historyStart();
  const count = buffer.historyRowCount();
  for (let i = 0; i < count; i++) lines.push(historyLine(buffer, i));
  logicalLines(buffer.scrollbackRows()).forEach((rows, j) => {
    lines.push({ segments: [{ rows, trim: false }], key: start + count + j });
  });
  const straddles = buffer.straddles() && count > 0;
  buffer.screenLines().forEach(({ rows, key }, index) => {
    if (index === 0 && straddles) {
      lines[count - 1].segments.push({ rows, trim: false });
      return;
    }
    lines.push({ segments: [{ rows, trim: false }], key });
  });
  return lines;
}
