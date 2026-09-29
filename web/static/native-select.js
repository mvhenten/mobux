// Select mode for the live terminal view. A long-press on the touch overlay
// shows the rows on screen as real text over the renderer's cell grid and
// hands the gesture to the browser: its own selection, handles, toolbar and
// link menu. The text comes from the engine buffer (terminal-text.js), so
// xterm and sterk select the same text.

import { linkCells, wordAt } from "./terminal-text.js";

const PROBE_CHARS = 64;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function element(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

// The row's cells as DOM, and per column the text node and offsets that
// hold the character drawn there. A wide character gets a box two cells
// wide, so the columns after it stay on the grid. A row that ends its
// logical line ends in a line break, so a copy across rows keeps the lines
// apart; a row the next one continues keeps its trailing blanks instead.
function buildRow(row, hrefs, cellWidth, continued) {
  const node = element("div", "select-row");
  const cells = row.cells;
  let last = cells.length - 1;
  if (!continued) {
    while (last >= 0 && (cells[last] === " " || cells[last] === "")) last--;
  }
  const map = [];
  const runs = [];
  let parent = node;
  let href = null;
  let run = null;
  for (let col = 0; col <= last; col++) {
    const ch = cells[col];
    if (ch === "") {
      map[col] = map[col - 1];
      continue;
    }
    if ((hrefs[col] ?? null) !== href) {
      href = hrefs[col] ?? null;
      parent = node;
      if (href) {
        parent = document.createElement("a");
        parent.href = href;
        node.append(parent);
      }
      run = null;
    }
    const wide = cells[col + 1] === "";
    if (wide || !run) {
      run = { text: "", parent, wide };
      runs.push(run);
    }
    map[col] = {
      run,
      start: run.text.length,
      end: run.text.length + ch.length,
    };
    run.text += ch;
    if (wide) run = null;
  }
  for (const r of runs) {
    r.node = document.createTextNode(r.text);
    if (!r.wide) {
      r.parent.append(r.node);
      continue;
    }
    const box = element("span", "select-wide");
    box.style.width = `${cellWidth * 2}px`;
    box.append(r.node);
    r.parent.append(box);
  }
  if (!continued) node.append(document.createTextNode("\n"));
  return { node, map };
}

const blankRow = (cols) => ({ cells: Array(cols).fill(" "), wrapped: false });

const rowKey = (row) => (row ? `${row.wrapped}:${row.cells.join("")}` : "");

export function createNativeSelection({
  core,
  root,
  overlay,
  fontFamily,
  releaseOverlay,
}) {
  const layer = element("div", "select-layer");
  root.append(layer);

  let active = null;

  // Everything the layer's rows stand for besides their text: once any of it
  // changes, the rows no longer lie on the text drawn under them.
  const layoutKey = () => {
    const pane = core.panes[core.activeIndex];
    return [
      core.textLayout(),
      core.isAlternateScreenActive(),
      core.rows,
      pane?.id,
      pane?.alternateOn,
    ].join(":");
  };

  function render() {
    const cell = core.cellSize();
    const origin = core.cellOrigin();
    const box = root.getBoundingClientRect();
    const { top, rows: count } = core.textViewport();
    const rows = core.textRows(top, count).map((r) => r ?? blankRow(core.cols));
    const links = linkCells(rows);

    layer.style.left = `${origin.x - box.left}px`;
    layer.style.top = `${origin.y - box.top}px`;
    layer.style.fontFamily = fontFamily;
    layer.style.fontSize = `${core.getFontSize()}px`;
    layer.style.lineHeight = `${cell.height}px`;
    layer.style.letterSpacing = "0px";
    layer.replaceChildren();

    const probe = element("span", "select-probe");
    probe.textContent = "0".repeat(PROBE_CHARS);
    layer.append(probe);
    const advance = probe.getBoundingClientRect().width / PROBE_CHARS;
    probe.remove();
    layer.style.letterSpacing = `${cell.width - advance}px`;

    const maps = rows.map((row, i) => {
      const continued = !!rows[i + 1]?.wrapped;
      const built = buildRow(row, links[i], cell.width, continued);
      built.node.style.top = `${i * cell.height}px`;
      built.node.style.height = `${cell.height}px`;
      layer.append(built.node);
      return built.map;
    });
    return { cell, origin, rows, maps, top, keys: rows.map(rowKey) };
  }

  function selectWord(grid, x, y) {
    const row = clamp(
      Math.floor((y - grid.origin.y) / grid.cell.height),
      0,
      grid.rows.length - 1,
    );
    const col = clamp(
      Math.floor((x - grid.origin.x) / grid.cell.width),
      0,
      core.cols - 1,
    );
    const word = wordAt(grid.rows, row, col);
    if (!word) return false;
    const from = grid.maps[word.start.row][word.start.col];
    const to = grid.maps[word.end.row][word.end.col];
    getSelection().setBaseAndExtent(
      from.run.node,
      from.start,
      to.run.node,
      to.end,
    );
    return true;
  }

  const selectionInLayer = () => {
    const sel = getSelection();
    return (
      sel.rangeCount > 0 &&
      !sel.isCollapsed &&
      layer.contains(sel.anchorNode) &&
      layer.contains(sel.focusNode)
    );
  };

  function enter(x, y) {
    if (active) return true;
    layer.classList.add("visible");
    const grid = render();
    if (!selectWord(grid, x, y)) {
      layer.classList.remove("visible");
      layer.replaceChildren();
      return false;
    }
    active = { layout: layoutKey(), top: grid.top, keys: grid.keys };
    overlay.style.pointerEvents = "none";
    return true;
  }

  function leave() {
    if (!active) return;
    active = null;
    releaseOverlay();
    if (selectionInLayer()) getSelection().removeAllRanges();
    layer.classList.remove("visible");
    layer.replaceChildren();
  }

  const onSelectionChange = () => {
    if (active && !selectionInLayer()) leave();
  };
  document.addEventListener("selectionchange", onSelectionChange);
  const onResize = () => leave();
  window.addEventListener("resize", onResize);
  // The text drawn under the layer moved or changed: a new line, a status
  // line tick, a redraw.
  const rowsMoved = () => {
    const { top, rows: count } = core.textViewport();
    if (top !== active.top || count !== active.keys.length) return true;
    return core
      .textRows(top, count)
      .some((row, i) => rowKey(row) !== active.keys[i]);
  };
  const onLayout = () => {
    if (!active) return;
    if (active.layout !== layoutKey() || rowsMoved()) leave();
  };
  const bufferSub = core.onBufferChanged(onLayout);
  core.addEventListener("panes", onLayout);

  return {
    enter,
    leave,
    active: () => !!active,
    state: () => ({
      active: !!active,
      text: getSelection().toString(),
      inLayer: selectionInLayer(),
    }),
    dispose() {
      leave();
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("resize", onResize);
      bufferSub.dispose();
      core.removeEventListener("panes", onLayout);
      layer.remove();
    },
  };
}
