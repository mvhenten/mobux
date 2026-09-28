// Touch selection and long-press links for the live terminal view. The
// touch overlay sits above both renderers, so neither sees a touch: mobux
// reads the text from the engine buffer (terminal-text.js) and draws the
// highlight, the handles, the action bar and the link sheet itself.

import { textBetween, urlAt, wordAt } from "./terminal-text.js";

// Rows read either side of a long-pressed row to find its logical line.
const LINE_WINDOW = 64;
const HANDLE_PX = 28;
const HANDLE_HIT_PX = 32;
const BAR_GAP_PX = 8;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const before = (p, q) => p.row < q.row || (p.row === q.row && p.col < q.col);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, action) {
  const b = el("button", "touch-select-btn", label);
  b.type = "button";
  b.dataset.action = action;
  return b;
}

function legacyCopy(text) {
  const ta = el("textarea", "touch-select-clip");
  ta.value = text;
  ta.setAttribute("readonly", "");
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok
    ? Promise.resolve()
    : Promise.reject(new Error("the browser refused to copy"));
}

function copyText(text) {
  if (!navigator.clipboard?.writeText) return legacyCopy(text);
  return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
}

const reason = (err) => err?.message || err?.name || String(err);

export function createTouchSelection({ core, termEl, overlay, openExternal }) {
  const root = overlay.parentNode;

  const layer = el("div", "touch-select-layer");
  const highlight = el("div", "touch-select-highlight");
  const startHandle = el(
    "div",
    "touch-select-handle touch-select-handle-start",
  );
  const endHandle = el("div", "touch-select-handle touch-select-handle-end");
  layer.append(highlight, startHandle, endHandle);

  const bar = el("div", "touch-select-bar");
  bar.setAttribute("role", "toolbar");
  const barStatus = el("div", "touch-select-status");
  barStatus.setAttribute("aria-live", "polite");
  bar.append(
    button("Copy", "copy"),
    button("Select all", "select-all"),
    button("Paste", "paste"),
    button("Done", "done"),
    barStatus,
  );

  const sheetBg = el("div", "link-sheet-bg");
  const sheet = el("div", "link-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Link");
  const sheetHeader = el("div", "link-sheet-header");
  sheetHeader.append(el("h3", "", "Link"), button("Close", "close"));
  const sheetUrl = el("div", "link-sheet-url");
  const sheetActions = el("div", "link-sheet-actions");
  sheetActions.append(
    button("Open in browser", "open"),
    button("Copy link", "copy-link"),
  );
  const sheetStatus = el("div", "touch-select-status");
  sheetStatus.setAttribute("aria-live", "polite");
  sheet.append(sheetHeader, sheetUrl, sheetActions, sheetStatus);

  root.append(layer, bar, sheetBg, sheet);

  // Endpoints in display rows (the renderer's viewport() row space), end
  // inclusive; `a` is where the selection began, `b` where it went.
  let sel = null;
  let drag = null;
  let sheetLink = null;
  let frame = null;

  function geometry() {
    const cell = core.cellSize();
    const term = termEl.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    return {
      cw: cell.width,
      ch: cell.height,
      term,
      dx: term.left - box.left,
      dy: term.top - box.top,
      top: core.viewport().top,
      rows: core.rows,
    };
  }

  function cellAt(x, y) {
    const g = geometry();
    return {
      row: g.top + clamp(Math.floor((y - g.term.top) / g.ch), 0, g.rows - 1),
      col: clamp(Math.floor((x - g.term.left) / g.cw), 0, core.cols - 1),
    };
  }

  function ordered() {
    return before(sel.b, sel.a)
      ? { start: sel.b, end: sel.a }
      : { start: sel.a, end: sel.b };
  }

  // Handle anchors in client coordinates: the start handle hangs below the
  // start cell's left edge, the end handle below the end cell's right edge.
  function handlePoints(g = geometry()) {
    if (!sel) return null;
    const { start, end } = ordered();
    const visible = (row) => row >= g.top && row < g.top + g.rows;
    const below = (row) => g.term.top + (row - g.top + 1) * g.ch;
    return {
      start: visible(start.row)
        ? {
            x: g.term.left + start.col * g.cw - HANDLE_PX / 2,
            y: below(start.row) + HANDLE_PX / 2,
          }
        : null,
      end: visible(end.row)
        ? {
            x: g.term.left + (end.col + 1) * g.cw + HANDLE_PX / 2,
            y: below(end.row) + HANDLE_PX / 2,
          }
        : null,
    };
  }

  function place(node, point, g) {
    node.classList.toggle("visible", !!point);
    if (!point) return;
    node.style.left = `${point.x - g.term.left + g.dx - HANDLE_PX / 2}px`;
    node.style.top = `${point.y - g.term.top + g.dy - HANDLE_PX / 2}px`;
  }

  function render() {
    frame = null;
    const active = !!sel && !termEl.classList.contains("hidden");
    layer.classList.toggle("visible", active);
    bar.classList.toggle("visible", active);
    highlight.replaceChildren();
    if (!active) return;
    const g = geometry();
    const { start, end } = ordered();
    for (let row = Math.max(start.row, g.top); row <= end.row; row++) {
      if (row >= g.top + g.rows) break;
      const from = row === start.row ? start.col : 0;
      const to = row === end.row ? end.col : core.cols - 1;
      const rect = el("div", "touch-select-rect");
      rect.style.left = `${g.dx + from * g.cw}px`;
      rect.style.top = `${g.dy + (row - g.top) * g.ch}px`;
      rect.style.width = `${(to - from + 1) * g.cw}px`;
      rect.style.height = `${g.ch}px`;
      highlight.append(rect);
    }
    const points = handlePoints(g);
    place(startHandle, points.start, g);
    place(endHandle, points.end, g);

    const barHeight = bar.offsetHeight;
    const selTop = g.dy + (start.row - g.top) * g.ch;
    const selBottom = g.dy + (end.row - g.top + 1) * g.ch + HANDLE_PX;
    const above = selTop - barHeight - BAR_GAP_PX;
    const beneath = selBottom + BAR_GAP_PX;
    const limit = g.dy + g.rows * g.ch - barHeight;
    bar.style.top = `${above >= g.dy ? above : clamp(beneath, g.dy, limit)}px`;
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(render);
  }

  function setStatus(node, text) {
    node.textContent = text;
    schedule();
  }

  function select(a, b) {
    sel = { a, b };
    barStatus.textContent = "";
    render();
  }

  function clear() {
    sel = null;
    drag = null;
    barStatus.textContent = "";
    render();
  }

  function text() {
    if (!sel) return "";
    const { start, end } = ordered();
    const rows = core.textRows(start.row, end.row - start.row + 1);
    return textBetween(
      rows,
      { row: 0, col: start.col },
      { row: end.row - start.row, col: end.col },
    );
  }

  function openSheet(url) {
    sheetLink = url;
    sheetUrl.textContent = url;
    sheetStatus.textContent = "";
    sheet.classList.add("visible");
    sheetBg.classList.add("visible");
  }

  function closeSheet() {
    sheetLink = null;
    sheet.classList.remove("visible");
    sheetBg.classList.remove("visible");
  }

  function longPress(x, y) {
    if (termEl.classList.contains("hidden")) return;
    const cell = cellAt(x, y);
    const rows = core.textRows(cell.row - LINE_WINDOW, LINE_WINDOW * 2 + 1);
    const url = urlAt(rows, LINE_WINDOW, cell.col);
    if (url) {
      clear();
      openSheet(url);
      return;
    }
    const word = wordAt(rows, LINE_WINDOW, cell.col);
    if (!word) {
      select(cell, cell);
      return;
    }
    const shift = cell.row - LINE_WINDOW;
    select(
      { row: word.start.row + shift, col: word.start.col },
      { row: word.end.row + shift, col: word.end.col },
    );
  }

  function tap(x, y) {
    if (!sel) return;
    const cell = cellAt(x, y);
    const { start, end } = ordered();
    const inside = !before(cell, start) && !before(end, cell);
    if (!inside) clear();
  }

  // A touch that starts on a handle drags it, keeping the finger's offset
  // from the cell it moves.
  function handleStart(x, y) {
    const points = handlePoints();
    if (!points) return false;
    const dist = (p) => (p ? Math.hypot(p.x - x, p.y - y) : Infinity);
    const toStart = dist(points.start);
    const toEnd = dist(points.end);
    if (Math.min(toStart, toEnd) > HANDLE_HIT_PX) return false;
    const { start } = ordered();
    const grabStart = toStart <= toEnd;
    const key = grabStart === (start === sel.a) ? "a" : "b";
    const g = geometry();
    const point = sel[key];
    drag = {
      key,
      dx: x - (g.term.left + (point.col + 0.5) * g.cw),
      dy: y - (g.term.top + (point.row - g.top + 0.5) * g.ch),
    };
    return true;
  }

  function handleMove(x, y) {
    if (!drag || !sel) return;
    sel[drag.key] = cellAt(x - drag.dx, y - drag.dy);
    schedule();
  }

  function handleEnd() {
    drag = null;
  }

  function selectAll() {
    const top = core.viewport().top;
    select(
      { row: top, col: 0 },
      { row: top + core.rows - 1, col: core.cols - 1 },
    );
  }

  function copySelection() {
    copyText(text()).then(clear, (err) =>
      setStatus(barStatus, `Copy failed: ${reason(err)}`),
    );
  }

  function paste() {
    if (!navigator.clipboard?.readText) {
      setStatus(
        barStatus,
        "Paste failed: this browser gives no clipboard access",
      );
      return;
    }
    navigator.clipboard.readText().then(
      (clip) => {
        if (!clip) {
          setStatus(barStatus, "Paste failed: the clipboard is empty");
          return;
        }
        core.paste(clip);
        clear();
      },
      (err) =>
        setStatus(
          barStatus,
          `Paste failed: ${reason(err)}. Allow clipboard access for this site.`,
        ),
    );
  }

  const barActions = {
    copy: copySelection,
    "select-all": selectAll,
    paste,
    done: clear,
  };

  const sheetActionsByName = {
    open: () => {
      const url = sheetLink;
      closeSheet();
      if (url) openExternal(url);
    },
    "copy-link": () => {
      copyText(sheetLink || "").then(closeSheet, (err) =>
        setStatus(sheetStatus, `Copy failed: ${reason(err)}`),
      );
    },
    close: closeSheet,
  };

  const keepFocus = (e) => e.preventDefault();
  const onBarClick = (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    barActions[action]?.();
  };
  const onSheetClick = (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    sheetActionsByName[action]?.();
  };
  bar.addEventListener("mousedown", keepFocus);
  bar.addEventListener("click", onBarClick);
  sheet.addEventListener("mousedown", keepFocus);
  sheet.addEventListener("click", onSheetClick);
  sheetBg.addEventListener("click", closeSheet);

  const bufferSub = core.onBufferChanged(() => {
    if (sel) schedule();
  });
  const onResize = () => {
    if (sel) schedule();
  };
  window.addEventListener("resize", onResize);

  return {
    longPress,
    tap,
    handleStart,
    handleMove,
    handleEnd,
    refresh: () => {
      if (sel) schedule();
    },
    active: () => !!sel,
    state: () => ({
      active: !!sel,
      text: text(),
      handles: handlePoints(),
      status: barStatus.textContent,
      sheetUrl: sheetLink,
      sheetStatus: sheetStatus.textContent,
    }),
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      bufferSub.dispose();
      window.removeEventListener("resize", onResize);
      layer.remove();
      bar.remove();
      sheet.remove();
      sheetBg.remove();
    },
  };
}
