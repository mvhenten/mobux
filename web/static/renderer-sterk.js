// Sterk renderer adapter.
//
// Implements the mobux renderer interface (see terminal-engine.js) as a
// sterk buffer view over the engine's text buffer: sterk draws the buffer
// through a ScreenSource (terminal-screen-source.js) and nothing writes into
// it. The engine owns the WebSocket, the buffer, reconnect, panes, tmux,
// history and OSC 133 bookkeeping.
//
// Every sterk-specific reach-through lives here and nowhere else: the Ace
// editor handle for theming, the `getViewportCellCount`/`getCellMetrics`
// probes, and the `window.__sterk` debug handle the visual test matrix reads.
//
// sterk's BufferView type offers built-in fonts and themes only: no font size,
// no custom palette, and no read of a drawn row. mobux reaches the Ace surface
// the view is built on for those — `setFontSize`, `getEditor` — so the text
// read back is the text drawn, not the source a frame ahead of it.
//
// The sterk bundle (sterk.bundle.js) pins
// `window.Sterk = { createBufferView, screenLineFromCells }` before the
// engine is constructed.

import { getStoredThemeId, getTheme } from "./themes.js";
import { createScreenSource } from "./terminal-screen-source.js";

// The grid the engine starts its buffer at, before the first measure.
const BOOT_GRID = { cols: 120, rows: 35 };
const HIDDEN_FALLBACK_MS = 100;

// Trailing punctuation is not part of the URL. xterm's WebLinks addon forbids
// a URL ending in punctuation (its final character class excludes `.,:!?` and
// brackets); strip the same trailing set so the boundary matches the addon —
// `see https://x/foo.` links `foo`, not `foo.`.
const URL_RE = /https?:\/\/[^\s)"'>]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;

export function createSterkRenderer(host, options = {}) {
  const Sterk = window.Sterk;
  if (!Sterk || !Sterk.createBufferView) {
    throw new Error(
      "sterk bundle not loaded — check vendor/sterk.bundle.js script tag",
    );
  }

  const bootTheme = getTheme(getStoredThemeId());
  // The live settings, read by the visual test matrix through __sterk.
  const settings = {
    scrollback: options.scrollback,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    theme: {
      foreground: bootTheme.foreground,
      background: bootTheme.background,
      palette: bootTheme.palette,
    },
  };

  let view = null;
  let source = null;
  const cleanups = [];
  const linkSubs = [];
  const emitLink = (uri) => {
    for (const cb of linkSubs.slice()) cb(uri);
  };

  const debugHandle = {
    get _sterk() {
      return view;
    },
    get options() {
      return settings;
    },
    scrollLines(n) {
      view?.scrollLines(n);
    },
    scrollToBottom() {
      view?.scrollToBottom();
    },
  };
  window.__sterk = debugHandle;

  // Sterk detects URLs itself; a link provider re-detects the http(s)
  // subset mobux opens and carries an `activate` handler, so a click on a
  // URL fans out to every onLink subscriber. The UI (terminal.js) decides
  // how to open — mobux routes it out of the app shell.
  function drawnRow(y) {
    if (y < 0 || y >= view.length) return null;
    return view.getEditor().session.getLine(y).replace(/\s+$/, "");
  }

  function provideLinks(bufferLineNumber, deliver) {
    const text = drawnRow(bufferLineNumber - 1);
    if (!text) return deliver(undefined);
    const links = [];
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
      const uri = m[0].replace(TRAILING_PUNCT_RE, "");
      if (!uri) continue;
      links.push({
        range: {
          start: { x: m.index + 1, y: bufferLineNumber },
          end: { x: m.index + uri.length, y: bufferLineNumber },
        },
        text: uri,
        activate: (_event, activatedUri) => emitLink(activatedUri),
      });
    }
    deliver(links.length ? links : undefined);
  }

  function drawBuffer(buffer) {
    source = createScreenSource(buffer, Sterk.screenLineFromCells);
    try {
      view = Sterk.createBufferView(host, source, {
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        // `font === ""` with an explicit `fontFamily`: mobux manages its
        // own font stack.
        font: "",
        theme: settings.theme,
      });
    } catch (err) {
      console.error("[sterk] createBufferView failed:", err);
      window.__sterkError = err;
      throw err;
    }
    cleanups.push(view.registerLinkProvider({ provideLinks }));
    // The view renders on an animation frame, which a hidden tab never
    // runs; there the change counts as drawn once the view has it.
    const unrendered = new Set();
    const settleRender = (wait) => {
      unrendered.delete(wait);
      clearTimeout(wait.timer);
      wait.sub.dispose();
      wait.resolve();
    };
    let rendered = Promise.resolve();
    cleanups.push(
      source.subscribe(() => {
        rendered = new Promise((resolve) => {
          const wait = { resolve };
          wait.sub = view.onRender(() => settleRender(wait));
          const whileHidden = () => {
            if (document.visibilityState === "hidden") settleRender(wait);
            else wait.timer = setTimeout(whileHidden, HIDDEN_FALLBACK_MS);
          };
          wait.timer = setTimeout(whileHidden, HIDDEN_FALLBACK_MS);
          unrendered.add(wait);
        });
      }),
      { dispose: () => [...unrendered].forEach(settleRender) },
    );
    return {
      flush: () => source.settle().then(() => rendered),
      settle: () => source.settle().then(() => view.refresh()),
      invalidate() {},
      fullRedraws: () => source.fullRepaints(),
      paints: () => source.paints(),
      setSyncHold: (ms) => source.setSyncHold(ms),
      dispose: () => source.dispose(),
    };
  }

  const cellSize = () => {
    const metrics = view?.getCellMetrics();
    return metrics
      ? { width: metrics.width, height: metrics.height }
      : { width: 9, height: 18 };
  };

  const horizontalPadding = () => {
    const cs = getComputedStyle(host);
    return (
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
    );
  };

  // Prefer sterk's `getViewportCellCount()` — the view's own answer that
  // already accounts for internal padding / scrollbar reservation. Fall
  // back to naive cell math before Ace has measured itself.
  const computeCellGrid = (hostH) => {
    const count = view?.getViewportCellCount();
    if (count && count.cols > 0 && count.rows > 0) {
      return {
        cols: Math.max(20, count.cols),
        rows: Math.max(10, count.rows),
      };
    }
    const cell = cellSize();
    const hostW = host.clientWidth || window.innerWidth - horizontalPadding();
    return {
      cols: Math.max(20, Math.floor(hostW / cell.width)),
      rows: Math.max(10, Math.floor(hostH / cell.height)),
    };
  };

  return {
    // Draws the engine's buffer; the engine uses the returned view in place
    // of its redraw writer.
    drawBuffer,

    // R1 — teardown: sterk releases its DOM + internal listeners.
    dispose() {
      linkSubs.length = 0;
      for (const sub of cleanups.splice(0)) sub.dispose();
      view?.dispose();
      if (window.__sterk === debugHandle) delete window.__sterk;
    },

    // R3 — authoritative fit for the host's current size. The view follows
    // the buffer's grid.
    measure() {
      const hostH = host.clientHeight || window.innerHeight;
      // Size .sterk-viewport to the host so Ace sees a sized viewport
      // before it is asked for its grid count.
      const viewport = host.querySelector(".sterk-viewport");
      if (viewport && hostH > 0) {
        viewport.style.height = `${hostH}px`;
      }
      const { cols, rows } = computeCellGrid(hostH);
      const cell = cellSize();
      return { cols, rows, cellWidth: cell.width, cellHeight: cell.height };
    },
    cellSize,

    // R4 — current grid.
    get cols() {
      return source ? source.cols : BOOT_GRID.cols;
    },
    get rows() {
      return source ? source.rows : BOOT_GRID.rows;
    },

    // R5 — keystrokes / IME output bound for the PTY.
    onInput(cb) {
      return view.onData(cb);
    },

    // R6 — scroll.
    scrollLines(n) {
      view.scrollLines(n);
    },
    scrollToBottom() {
      view.scrollToBottom();
    },

    // R7 — scroll position and a row's text, in the view's row space.
    viewport() {
      return { length: view.length, top: view.viewportY };
    },
    rowText(y) {
      return drawnRow(y);
    },

    // R11 — theming + font size: the Ace editor theme through the view's
    // editor.
    setTheme(theme) {
      settings.theme = {
        palette: theme.palette.slice(0, 16),
        background: theme.background || theme.palette[0],
        foreground: theme.foreground || theme.palette[7] || "#c5c8c6",
      };
      if (theme.aceTheme) view?.getEditor().setTheme(theme.aceTheme);
    },
    setFontSize(px) {
      if (px === settings.fontSize) return;
      settings.fontSize = px;
      view?.setFontSize(px);
    },
    getFontSize() {
      return settings.fontSize;
    },

    // R12 — selection. Sterk selects through Ace's native DOM selection, so
    // copy / long-press act on real text (the substrate #137 builds on).
    getSelection() {
      return view.getSelection();
    },
    hasSelection() {
      return view.hasSelection();
    },
    clearSelection() {
      view.clearSelection();
    },
    selectAll() {
      view.selectAll();
    },
    onSelectionChange(cb) {
      return view.onSelectionChange(cb);
    },

    // R13 — links detected by the provider above; the UI decides how to
    // open them.
    onLink(cb) {
      linkSubs.push(cb);
      return {
        dispose() {
          const i = linkSubs.indexOf(cb);
          if (i >= 0) linkSubs.splice(i, 1);
        },
      };
    },

    // R15 — input surface ownership. Release the view's Ace text-input so it
    // can't steal focus or pop the soft keyboard while the mobile bar owns
    // input; re-enable restores it.
    focus() {
      host.querySelector(".ace_text-input")?.focus();
    },
    setNativeInputEnabled(enabled) {
      const ta = host.querySelector(".ace_text-input");
      if (enabled) {
        if (ta) {
          ta.removeAttribute("tabindex");
          ta.style.pointerEvents = "";
        }
        return;
      }
      view?.blur();
      if (ta) {
        ta.setAttribute("tabindex", "-1");
        ta.style.pointerEvents = "none";
      }
    },
  };
}
