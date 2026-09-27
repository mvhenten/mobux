// OSC 133 markers by line key (issue #315).
//
// A marker recorded on the screen is keyed at once from the screen's line
// keys, which count the rows scrolled off since the last sync as lines. The
// sync then says which history lines those rows were; a marker whose row
// scrolled off is placed on its history line, one still on the screen is
// re-keyed from where it now is. When the sync's lines do not add up to the
// rows counted (tmux repainted instead of scrolling), the screen as it was
// at the marker is found again among the new history lines and the screen
// now, and the marker goes to its line there.

export function createMarkerBook(buffer) {
  // { payload, key, vrow, snapshot, lineIndex }; vrow is null once placed
  // in history.
  let entries = [];
  let map = new Map();

  function rebuild() {
    map = new Map();
    for (const { key, payload } of entries) {
      const existing = map.get(key);
      map.set(key, existing ? `${existing}|${payload}` : payload);
    }
  }

  function historyCandidates(from) {
    const out = [];
    const start = buffer.historyStart();
    for (let i = Math.max(0, from - start); i < buffer.historyRowCount(); i++) {
      out.push({ key: start + i, text: buffer.historyText(i) });
    }
    return out;
  }

  // The pane as it was when the marker was recorded, found again among the
  // lines added to history since and the pane now. A line may have grown since
  // (typing after a prompt), so a recorded line matches the start of one.
  // The latest place the whole screen fits wins.
  function findSnapshot(entry, stream) {
    const { snapshot, lineIndex } = entry;
    const fits = (o) =>
      snapshot.every((text, j) => {
        if (!text.trim()) return true;
        const line = stream[o + j];
        return !!line && line.text.trimEnd().startsWith(text.trimEnd());
      });
    for (let o = stream.length - snapshot.length; o >= 0; o--) {
      if (fits(o)) return stream[o + lineIndex];
    }
    return null;
  }

  function placeExactly(entry, segments, rows) {
    if (entry.vrow >= rows) {
      entry.vrow -= rows;
      return;
    }
    let row = 0;
    for (const segment of segments) {
      if (entry.vrow < row + segment.rows) {
        entry.key = segment.key;
        entry.vrow = null;
        return;
      }
      row += segment.rows;
    }
  }

  function placeByText(entry, before) {
    const screen = buffer.screenLines();
    const found = findSnapshot(entry, [
      ...historyCandidates(before - 1),
      ...screen,
    ]);
    if (!found) {
      entry.vrow = null;
      return;
    }
    entry.key = found.key;
    entry.vrow = found.row === undefined ? null : found.row;
  }

  return {
    get map() {
      return map;
    },
    record(payload) {
      entries.push({ payload, ...buffer.cursorPlace() });
      rebuild();
    },
    clear() {
      entries = [];
      rebuild();
    },
    // After a sync. `scrolledAtFetch` is the rows the screen had scrolled
    // off when the capture was fetched.
    place(result, scrolledAtFetch) {
      const { replaced, before, after, segments } = result;
      const rows = segments ? segments.reduce((sum, s) => sum + s.rows, 0) : -1;
      const exact = !replaced && rows === scrolledAtFetch;
      const first = buffer.historyStart();
      const kept = [];
      for (const entry of entries) {
        if (entry.vrow === null) {
          if (replaced && entry.key >= before) {
            entry.key = entry.key - before + after;
          } else if (replaced || entry.key < first) {
            continue;
          }
          kept.push(entry);
          continue;
        }
        if (exact) placeExactly(entry, segments, rows);
        else placeByText(entry, before);
        kept.push(entry);
      }
      if (exact) buffer.consumeScrolledRows(rows);
      else buffer.consumeScrolledRows(buffer.scrolledRows());
      for (const entry of kept) {
        if (entry.vrow === null) continue;
        const key = buffer.rowKey(entry.vrow - buffer.scrolledRows());
        if (key !== null) entry.key = key;
      }
      entries = kept;
      rebuild();
    },
  };
}
