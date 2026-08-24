// Sterk renderer adapter.
//
// Implements the mobux renderer interface (see terminal-engine.js) over
// @kattebak/sterk (a clean-room VT core rendered through Ace's DOM text
// engine). This is one of the two adapters the single engine drives; the
// engine owns the WebSocket, reconnect, panes, tmux, history and OSC 133
// bookkeeping and never reaches into a renderer's internals.
//
// Every sterk-specific reach-through lives here and nowhere else: the Ace
// editor handle for theming, the `getViewportCellCount`/`getCellMetrics`
// probes, the DEC-private-mode suppression (alt-screen + mouse off), and the
// `window.__sterk` debug handle the visual test matrix reads.
//
// The sterk bundle (sterk.bundle.js) pins `window.Sterk = { createTerminal }`
// before the engine is constructed.

import { getStoredThemeId, getTheme } from "./themes.js";

export function createSterkRenderer(host, options = {}) {
  const Sterk = window.Sterk;
  if (!Sterk || !Sterk.createTerminal) {
    throw new Error(
      "sterk bundle not loaded — check vendor/sterk.bundle.js script tag",
    );
  }

  const bootTheme = getTheme(getStoredThemeId());

  let sterk;
  try {
    sterk = Sterk.createTerminal({
      cols: 120,
      rows: 35,
      scrollback: options.scrollback,
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      // Opt OUT of sterk's built-in font registry. Per the v2.6.0+ contract:
      // `font === ""` AND an explicit `fontFamily` means "consumer manages
      // their own font stack".
      font: "",
      theme: {
        foreground: bootTheme.foreground,
        background: bootTheme.background,
        palette: bootTheme.palette,
      },
    });
  } catch (err) {
    console.error("[sterk] createTerminal failed:", err);
    window.__sterkError = err;
    throw err;
  }

  try {
    sterk.open(host);
  } catch (err) {
    console.error("[sterk] open failed:", err);
    window.__sterkError = err;
    throw err;
  }

  // onWriteParsed fires once per write(); fan it out to every subscriber
  // (the reader relies on this) so multiple consumers can observe buffer
  // changes without competing for sterk's single hook.
  const writeParsedSubs = [];
  if (sterk.onWriteParsed) {
    sterk.onWriteParsed(() => {
      for (const cb of writeParsedSubs.slice()) cb();
    });
  }

  // Debug peephole for the visual test matrix (confined to this adapter).
  // Exposes the sterk instance and its live options so sterk-only tests can
  // read the Ace DOM and the applied palette.
  const debugHandle = {
    _sterk: sterk,
    get options() {
      return sterk.options;
    },
    get buffer() {
      return sterk.buffer;
    },
    scrollLines(n) {
      sterk.scrollLines(n);
    },
    scrollToBottom() {
      sterk.scrollToBottom();
    },
  };
  if (typeof window !== "undefined") {
    window.__sterk = debugHandle;
  }

  const cellSize = () => {
    const metrics = sterk.getCellMetrics ? sterk.getCellMetrics() : null;
    return metrics
      ? { width: metrics.width, height: metrics.height }
      : { width: 9, height: 18 };
  };

  const horizontalPadding = () => {
    try {
      const cs = getComputedStyle(host);
      return (
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      );
    } catch (_) {
      return 0;
    }
  };

  // Prefer sterk's `getViewportCellCount()` — the renderer's authoritative
  // answer that already accounts for internal padding / scrollbar
  // reservation, so there is no `- 1` fudge. Fall back to naive cell math
  // for older builds without the API.
  const computeCellGrid = (hostH) => {
    const count = sterk.getViewportCellCount
      ? sterk.getViewportCellCount()
      : null;
    if (count && count.cols > 0 && count.rows > 0) {
      return {
        cols: Math.max(20, count.cols),
        rows: Math.max(10, count.rows),
      };
    }
    const cell = cellSize();
    const pad = horizontalPadding();
    const hostW = host.clientWidth || window.innerWidth - pad;
    return {
      cols: Math.max(20, Math.floor(hostW / cell.width)),
      rows: Math.max(10, Math.floor(hostH / cell.height)),
    };
  };

  // Disposables sterk hands back for the subscriptions/handlers this adapter
  // registers on it; drained by dispose() so a remount leaves nothing behind.
  const rendererCleanups = [];

  // ── R13 links ───────────────────────────────────────────────────────
  // Sterk detects URLs itself; a link provider re-detects the http(s) subset
  // mobux opens and carries an `activate` handler. Provider links take
  // precedence over built-in detection at the same position, so a click on a
  // URL fans out to every onLink subscriber. The UI (terminal.js) decides how
  // to open — mobux routes it out of the app shell.
  const linkSubs = [];
  const emitLink = (uri) => {
    for (const cb of linkSubs.slice()) cb(uri);
  };
  const URL_RE = /https?:\/\/[^\s)"'>]+/g;
  // Trailing punctuation is not part of the URL. xterm's WebLinks addon forbids
  // a URL ending in punctuation (its final character class excludes `.,:!?` and
  // brackets); strip the same trailing set so the boundary matches the addon —
  // `see https://x/foo.` links `foo`, not `foo.`.
  const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;
  if (sterk.registerLinkProvider) {
    const sub = sterk.registerLinkProvider({
      provideLinks(bufferLineNumber, deliver) {
        const line = sterk.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) return deliver(undefined);
        const text = line.translateToString(false);
        const links = [];
        URL_RE.lastIndex = 0;
        let m;
        while ((m = URL_RE.exec(text)) !== null) {
          const uri = m[0].replace(TRAILING_PUNCT_RE, "");
          if (!uri) continue;
          const startX = m.index + 1; // 1-based start column
          const endX = m.index + uri.length; // 1-based inclusive last column
          links.push({
            range: {
              start: { x: startX, y: bufferLineNumber },
              end: { x: endX, y: bufferLineNumber },
            },
            text: uri,
            activate: (_event, activatedUri) => emitLink(activatedUri),
          });
        }
        deliver(links.length ? links : undefined);
      },
    });
    if (sub && typeof sub.dispose === "function") rendererCleanups.push(sub);
  }

  // ── R16 alt-screen + mouse-off ──────────────────────────────────────
  // mobux's standing policy: no alternate screen (tmux alt has no scrollback)
  // and no mouse-protocol reporting (touch gestures are the input model). We
  // own sterk, so we suppress the DEC private modes at the parser instead of
  // patching internals. A CSI `?<mode>h`/`?<mode>l` may pack several modes;
  // sterk's built-in handler applies the whole group all-or-nothing, so a
  // sequence that mixes a blocked mode with an allowed one (e.g.
  // `\x1b[?1049;25h`) would still switch the alt buffer if it fell through.
  // Consume any sequence carrying a blocked mode and re-emit only the allowed
  // modes so those still take effect; the re-emitted sequence carries no
  // blocked mode, so it falls through normally (no recursion).
  const blockedModes = new Set([
    // mouse tracking + encodings — kept off on both renderers.
    9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016,
  ]);
  if (options.altScreen === false) {
    blockedModes.add(47).add(1047).add(1049);
  }
  if (sterk.parser && sterk.parser.registerCsiHandler) {
    const scalar = (p) => (Array.isArray(p) ? p[0] : p);
    for (const final of ["h", "l"]) {
      const sub = sterk.parser.registerCsiHandler(
        { prefix: "?", final },
        (params) => {
          const modes = params.map(scalar);
          if (!modes.some((m) => blockedModes.has(m))) return false;
          const allowed = modes.filter((m) => !blockedModes.has(m));
          if (allowed.length > 0) {
            sterk.write(`\x1b[?${allowed.join(";")}${final}`);
          }
          return true;
        },
      );
      if (sub && typeof sub.dispose === "function") rendererCleanups.push(sub);
    }
  }

  return {
    // R1 — teardown: sterk releases its DOM + internal listeners.
    dispose() {
      writeParsedSubs.length = 0;
      linkSubs.length = 0;
      for (const sub of rendererCleanups.splice(0)) {
        try {
          sub.dispose();
        } catch (_) {}
      }
      try {
        sterk.dispose();
      } catch (_) {}
      if (typeof window !== "undefined" && window.__sterk === debugHandle) {
        delete window.__sterk;
      }
    },

    // R2 — resolves after the buffer reflects the data. Sterk resolves on its
    // own write callback (the semantics the existing suite already relies on);
    // the stronger slow-CI flush guarantee is the upstream sterk fix.
    write(data) {
      const text =
        typeof data === "string"
          ? data
          : new TextDecoder("utf-8", { fatal: false }).decode(data);
      return new Promise((resolve) => sterk.write(text, resolve));
    },

    // R3 — authoritative fit for the host's current size.
    resize(cols, rows) {
      sterk.resize(cols, rows);
    },
    measure() {
      const hostH = host.clientHeight || window.innerHeight;
      // Update .sterk-viewport height to match host so Ace sees a sized
      // viewport before we ask it for its grid count.
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
      return sterk.cols;
    },
    get rows() {
      return sterk.rows;
    },

    // R5 — keystrokes / IME output bound for the PTY.
    onInput(cb) {
      return sterk.onData(cb);
    },

    // R6 — scroll; viewport position is readable via the buffer.
    scrollLines(n) {
      sterk.scrollLines(n);
    },
    scrollToBottom() {
      sterk.scrollToBottom();
    },

    // R7 — xterm-shaped buffer read model.
    buffer: {
      get active() {
        return makeBufferAdapter(sterk);
      },
    },

    // R8 — fires after a write is parsed; multiple subscribers.
    onBufferChanged(cb) {
      writeParsedSubs.push(cb);
      return {
        dispose() {
          const i = writeParsedSubs.indexOf(cb);
          if (i >= 0) writeParsedSubs.splice(i, 1);
        },
      };
    },

    // R9 — alt-screen state, via sterk's public `buffer.active.type` (same
    // shape xterm reports). R16 keeps this false in normal operation by
    // suppressing the alt-screen switch at the parser.
    isAlternateScreenActive() {
      try {
        return sterk.buffer.active.type === "alternate";
      } catch (_) {
        return false;
      }
    },

    // R10 — OSC handler registration (the engine uses it for OSC 133).
    registerOscHandler(id, cb) {
      if (sterk.parser && sterk.parser.registerOscHandler) {
        return sterk.parser.registerOscHandler(id, cb);
      }
      return { dispose() {} };
    },

    // R11 — theming + font size. Sterk applies the palette in place on its
    // live options object and the Ace editor theme through its renderer.
    setTheme(theme) {
      const opts = sterk.options;
      if (opts && opts.theme && Array.isArray(opts.theme.palette)) {
        opts.theme.palette = theme.palette.slice(0, 16);
        opts.theme.background = theme.background || theme.palette[0];
        opts.theme.foreground =
          theme.foreground || theme.palette[7] || "#c5c8c6";
      }
      const editor =
        sterk.renderer && sterk.renderer.getEditor
          ? sterk.renderer.getEditor()
          : null;
      if (editor && typeof editor.setTheme === "function" && theme.aceTheme) {
        editor.setTheme(theme.aceTheme);
      }
    },
    setFontSize(px) {
      if (px !== sterk.options.fontSize) {
        sterk.options.fontSize = px;
      }
    },
    getFontSize() {
      return sterk.options.fontSize;
    },

    // R12 — selection. Sterk selects through Ace's native DOM selection, so
    // copy / long-press act on real text (the substrate #137 builds on).
    getSelection() {
      return sterk.getSelection ? sterk.getSelection() : "";
    },
    hasSelection() {
      return sterk.hasSelection ? sterk.hasSelection() : false;
    },
    clearSelection() {
      sterk.clearSelection?.();
    },
    selectAll() {
      sterk.selectAll?.();
    },
    onSelectionChange(cb) {
      return sterk.onSelectionChange
        ? sterk.onSelectionChange(cb)
        : { dispose() {} };
    },

    // R13 — links. Subscribe to URL activations detected by the sterk link
    // provider registered above; the UI decides how to open them.
    onLink(cb) {
      linkSubs.push(cb);
      return {
        dispose() {
          const i = linkSubs.indexOf(cb);
          if (i >= 0) linkSubs.splice(i, 1);
        },
      };
    },

    // R14 — bell. Reports the raw terminal BEL; the chime is driven only by
    // the server-gated push path, never this event (conformance probe only).
    onBell(cb) {
      return sterk.onBell ? sterk.onBell(cb) : { dispose() {} };
    },

    // R15 — input surface ownership. Release sterk's Ace text-input so it can't
    // steal focus or pop the soft keyboard while the mobile bar owns input;
    // re-enable restores it. Confined to this adapter (mirrors the xterm
    // textarea handling).
    focus() {
      try {
        host.querySelector(".ace_text-input")?.focus();
      } catch (_) {}
    },
    setNativeInputEnabled(enabled) {
      const ta = host.querySelector(".ace_text-input");
      if (enabled) {
        if (ta) {
          ta.removeAttribute("tabindex");
          ta.style.pointerEvents = "";
        }
      } else {
        try {
          sterk.blur?.();
        } catch (_) {}
        if (ta) {
          ta.setAttribute("tabindex", "-1");
          ta.style.pointerEvents = "none";
        }
      }
    },

    // Engine housekeeping used by window-switch / tmux commands.
    clear() {
      sterk.clear();
    },
  };
}

function makeBufferAdapter(sterk) {
  // Don't capture the buffer — read sterk.buffer.active fresh each time so we
  // see updated state after scrollToBottom() / scrollLines() / write().
  return {
    get length() {
      return sterk.buffer.active.length;
    },
    get cursorX() {
      return sterk.buffer.active.cursorX;
    },
    get cursorY() {
      return sterk.buffer.active.cursorY;
    },
    get baseY() {
      return sterk.buffer.active.baseY;
    },
    get viewportY() {
      return sterk.buffer.active.viewportY;
    },
    getLine(y) {
      const line = sterk.buffer.active.getLine(y);
      return line ? makeLineAdapter(line) : null;
    },
  };
}

function makeLineAdapter(line) {
  return {
    get isWrapped() {
      return line.isWrapped;
    },
    // xterm-shaped semantics (D7): `trimRight` trims the RIGHT edge only, so
    // column indices stay aligned with getCell(x). Sterk's own
    // translateToString(true) trims both edges, which would shift every column
    // on an indented line; read it raw and trim the right ourselves.
    translateToString(trimRight) {
      const raw = line.translateToString(false);
      return trimRight ? raw.replace(/\s+$/, "") : raw;
    },
    getCell(x) {
      return makeCellAdapter(line.getCell(x));
    },
  };
}

function makeCellAdapter(cell) {
  return {
    getChars() {
      return cell.getChars();
    },
    getCode() {
      return cell.getCode();
    },
    isFgRGB() {
      return cell.isFgRGB();
    },
    isBgRGB() {
      return cell.isBgRGB();
    },
    isFgPalette() {
      return cell.isFgPalette();
    },
    isBgPalette() {
      return cell.isBgPalette();
    },
    isFgDefault() {
      return cell.isFgDefault();
    },
    isBgDefault() {
      return cell.isBgDefault();
    },
    getFgColor() {
      return cell.getFgColor();
    },
    getBgColor() {
      return cell.getBgColor();
    },
    getFgColorMode() {
      return cell.getFgColorMode();
    },
    getBgColorMode() {
      return cell.getBgColorMode();
    },
    isBold() {
      return cell.isBold();
    },
    isItalic() {
      return cell.isItalic();
    },
    isUnderline() {
      return cell.isUnderline();
    },
    isInverse() {
      return cell.isInverse();
    },
    isDim() {
      return cell.isDim();
    },
  };
}
