// The engine buffer as a sterk ScreenSource (issue #315): what sterk's
// buffer view draws. History rows are the buffer's history lines, then the
// normal screen's scrollback, the lines cut into rows at the pane width;
// screen rows are tmux's client screen as the buffer holds it. Each buffer
// change is reported against what was reported last.
//
// `toLine` is sterk's screenLineFromCells.

import { historyLine, lineCells } from "./terminal-lines.js";
import { createPaintScheduler } from "./paint-frame.js";

const BLANK = { runs: [], wrapped: false };

// A wide character that does not fit a row's end starts the next row.
function cutRows(cells, cols) {
  const rows = [[]];
  let used = 0;
  for (const cell of cells) {
    const width = cell.getWidth();
    if (used > 0 && used + width > cols) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1).push(cell);
    used += width;
  }
  return rows;
}

export function createScreenSource(buffer, toLine) {
  const listeners = new Set();
  let historyRows = [];
  // The rows each history line was cut into, and the scrollback rows.
  let lineRows = [];
  let scrollRows = [];
  let screenRows = [];
  let screenKeys = [];
  let cursor = null;
  let cursorKey = "";
  let seen = null;
  let fullRepaints = 0;
  let paints = 0;

  function rowsOfLine(i, cols) {
    const cells = [...lineCells(historyLine(buffer, i).segments)];
    return cutRows(cells, cols).map((row, r) =>
      toLine({ isWrapped: r > 0, getCell: (x) => row[x] }, row.length),
    );
  }

  const scrollback = (from, cols) =>
    buffer.scrollbackRows(from).map((row) => toLine(row, cols));

  function state() {
    return {
      cols: buffer.cols,
      rows: buffer.rows,
      alternate: buffer.isAlternate(),
      epoch: buffer.historyEpoch(),
      start: buffer.historyStart(),
      count: buffer.historyRowCount(),
      revision: buffer.lastLineRevision(),
      scrollback: buffer.screenScrollbackCount(),
      trimmed: buffer.screenTrimmed(),
    };
  }

  function rebuild(now) {
    lineRows = [];
    for (let i = 0; i < now.count; i++) lineRows.push(rowsOfLine(i, now.cols));
    scrollRows = scrollback(0, now.cols);
    historyRows = lineRows.flat().concat(scrollRows);
  }

  // How the history rows moved since the last report, applied to the rows
  // held; null when that is not rows off the top and rows onto the end.
  function historyChange(now) {
    if (now.cols !== seen.cols || now.epoch !== seen.epoch) return null;
    const dropped = now.start - seen.start;
    if (dropped < 0 || dropped > seen.count) return null;
    const linesMoved =
      dropped > 0 || now.count !== seen.count || now.revision !== seen.revision;
    if (linesMoved && scrollRows.length > 0) return null;
    const trimmed = now.trimmed - seen.trimmed;
    if (trimmed > 0 && (now.count > 0 || trimmed > scrollRows.length)) {
      return null;
    }
    if (now.scrollback < scrollRows.length - trimmed) return null;

    let removedTop = 0;
    for (let i = 0; i < dropped; i++) removedTop += lineRows[i].length;
    lineRows = lineRows.slice(dropped);
    const kept = seen.count - dropped;
    const added = [];
    if (now.revision !== seen.revision) {
      if (kept === 0) return null;
      const held = lineRows[kept - 1];
      const grown = rowsOfLine(kept - 1, now.cols);
      const prefix = held.every(
        (row, r) => JSON.stringify(row) === JSON.stringify(grown[r]),
      );
      if (!prefix) return null;
      lineRows[kept - 1] = grown;
      added.push(...grown.slice(held.length));
    }
    for (let i = kept; i < now.count; i++) {
      const rows = rowsOfLine(i, now.cols);
      lineRows.push(rows);
      added.push(...rows);
    }
    removedTop += trimmed;
    scrollRows = scrollRows.slice(trimmed);
    const fresh = scrollback(scrollRows.length, now.cols);
    scrollRows = scrollRows.concat(fresh);
    added.push(...fresh);
    historyRows = historyRows.slice(removedTop).concat(added);
    return { removedTop, appended: added.length };
  }

  // The pane's first row goes on from the last history row while that
  // line straddles the top of the pane.
  function readScreen() {
    const rows = buffer.viewportRows();
    const joined =
      buffer.straddles() &&
      buffer.historyRowCount() > 0 &&
      buffer.paneRows().first === 0;
    return rows.map((row, r) => {
      if (!row) return BLANK;
      const line = toLine(row, buffer.cols);
      return r === 0 && joined ? { ...line, wrapped: true } : line;
    });
  }

  function readCursor() {
    const { x, y } = buffer.cursor();
    return { x, y, visible: buffer.modes().get(25) !== false };
  }

  function refresh() {
    const now = state();
    let history = seen ? historyChange(now) : null;
    if (!history) rebuild(now);
    const full =
      !history || now.rows !== seen.rows || now.alternate !== seen.alternate;
    if (full && seen) fullRepaints++;
    seen = now;

    screenRows = readScreen();
    const keys = screenRows.map((line) => JSON.stringify(line));
    const changedRows = [];
    keys.forEach((key, r) => {
      if (full || key !== screenKeys[r]) changedRows.push(r);
    });
    screenKeys = keys;
    cursor = readCursor();
    const nextCursor = JSON.stringify(cursor);
    const cursorMoved = nextCursor !== cursorKey;
    cursorKey = nextCursor;

    const change = {
      history: history ?? { removedTop: 0, appended: 0 },
      screenRows: changedRows,
      full,
    };
    const quiet =
      !full &&
      change.history.removedTop === 0 &&
      change.history.appended === 0 &&
      changedRows.length === 0 &&
      !cursorMoved;
    return quiet ? null : change;
  }

  refresh();
  const frames = createPaintScheduler(buffer, () => {
    const change = refresh();
    if (!change) return;
    paints++;
    for (const listener of [...listeners]) listener(change);
  });
  const sub = buffer.onChange(() => frames.request());

  return {
    get rows() {
      return seen.rows;
    },
    get cols() {
      return seen.cols;
    },
    history: {
      get length() {
        return historyRows.length;
      },
      line: (i) => historyRows[i] ?? BLANK,
    },
    screen: {
      line: (r) => screenRows[r] ?? BLANK,
    },
    get cursor() {
      return cursor;
    },
    // Resolves once every buffer change so far has been reported.
    settle() {
      return Promise.resolve(frames.pending());
    },
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fullRepaints() {
      return fullRepaints;
    },
    paints() {
      return paints;
    },
    dispose() {
      sub.dispose();
      listeners.clear();
      frames.dispose();
    },
  };
}
