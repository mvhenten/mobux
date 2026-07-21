// The terminal document contract — a read-only view of the active buffer for
// the reader (issue #206, D2).
//
// The reader renders scrollback as a document. It used to reach into the
// engine for the raw material: the active buffer, `cols`, the OSC 133 marker
// map, `onWriteParsed`, and the last-row-is-status convention. Those five
// contact points are collapsed here into one documented interface, built once
// over the renderer-agnostic buffer read model (R7) the engine already
// exposes. Cell walking, wrapped-row joining, palette decoding, OSC lookup,
// and the status-line peel live behind this contract; block classification
// stays reader-side.
//
// ── Contract ────────────────────────────────────────────────────────────
//   snapshot(): { lines, status }
//     lines   logical lines (wrapped rows already joined), each:
//               { runs: [{ text, attrs }], text, osc }
//             `osc` is null, or one or more OSC 133 marker payloads joined by
//             `|` when more than one lands on the same row (e.g. `'A'`,
//             `'C'`, `'D;0'`, `'D;0|A'`) — see terminal-engine.js's
//             `oscMarkers` doc comment. Consumers scan for a kind rather than
//             compare for equality; term-tokenizer.js's `oscHas`/
//             `oscExitCode` do this.
//     status  the tmux status line as a separate field: { runs } | null
//   subscribe(cb): Disposable    fires after each buffer write
//   onOscDetected(cb): Disposable   fires the first time an OSC 133 marker lands
//   oscDetected: boolean

// ── ANSI 256-colour palette (xterm default) ────────────────────────
// Index 0-15 are the basic ANSI colours, exposed via CSS variables so themes
// can tweak them. Index 16-255 are the standard xterm extended palette
// (216-colour cube + 24 greys).
const ANSI_BASIC_VARS = [
  "var(--ansi-0)",
  "var(--ansi-1)",
  "var(--ansi-2)",
  "var(--ansi-3)",
  "var(--ansi-4)",
  "var(--ansi-5)",
  "var(--ansi-6)",
  "var(--ansi-7)",
  "var(--ansi-8)",
  "var(--ansi-9)",
  "var(--ansi-10)",
  "var(--ansi-11)",
  "var(--ansi-12)",
  "var(--ansi-13)",
  "var(--ansi-14)",
  "var(--ansi-15)",
];

function buildExtendedPalette() {
  const palette = [];
  const cube = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette.push(`rgb(${cube[r]},${cube[g]},${cube[b]})`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette.push(`rgb(${v},${v},${v})`);
  }
  return palette;
}
const ANSI_EXTENDED = buildExtendedPalette(); // length 240, mapped to 16..255

function paletteColour(idx) {
  if (idx < 0) return null;
  if (idx < 16) return ANSI_BASIC_VARS[idx];
  if (idx < 256) return ANSI_EXTENDED[idx - 16];
  return null;
}

function rgbColour(packed) {
  // xterm packs RGB as 0xRRGGBB
  const r = (packed >> 16) & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = packed & 0xff;
  return `rgb(${r},${g},${b})`;
}

function cellColour(cell, kind) {
  // kind: 'fg' or 'bg'
  const isDefault = kind === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;
  const isRGB = kind === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = kind === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const value = kind === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (isRGB) return rgbColour(value);
  if (isPalette) return paletteColour(value);
  return null;
}

function cellAttrs(cell) {
  return {
    fg: cellColour(cell, "fg"),
    bg: cellColour(cell, "bg"),
    bold: !!cell.isBold(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    dim: !!cell.isDim(),
    inverse: !!cell.isInverse(),
  };
}

function attrsEqual(a, b) {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.dim === b.dim &&
    a.inverse === b.inverse
  );
}

// ── Run extraction ─────────────────────────────────────────────────
// Walk a logical line's cells (possibly spanning multiple buffer rows when
// wrapped) and group consecutive cells with identical attrs into runs.
// Trailing default-attr whitespace is stripped.
//
// `rowChain` is an array of xterm-shaped IBufferLine objects (the wrapped
// chain), not a single line.
export function extractRuns(rowChain, cols) {
  const runs = [];
  let cur = null;
  for (const line of rowChain) {
    if (!line) continue;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const ch = cell.getChars();
      // Empty (null) cells past content: some apps fill with spaces, so we
      // can't fully skip mid-line — emit a space and let the trailing-trim
      // below drop the tail.
      const text = ch === "" ? " " : ch;
      const attrs = cellAttrs(cell);
      if (cur && attrsEqual(cur.attrs, attrs)) {
        cur.text += text;
      } else {
        if (cur) runs.push(cur);
        cur = { text, attrs };
      }
    }
  }
  if (cur) runs.push(cur);
  // Trim trailing whitespace from the last run. Terminal apps often pad lines
  // with spaces; when those carry a non-default bg they render as tiny empty
  // chips at the end of the line. Strip them regardless of attrs.
  while (runs.length > 0) {
    const last = runs[runs.length - 1];
    last.text = last.text.replace(/\s+$/u, "");
    if (last.text.length === 0) {
      runs.pop();
      continue;
    }
    break;
  }
  return runs;
}

// ── Logical-line iteration ─────────────────────────────────────────
// Coalesces wrapped rows so the reader gets one entry per logical line and can
// reflow on its own width. `startY` is the absolute buffer row where the chain
// begins — needed to look up OSC 133 markers attached to specific rows.
function* logicalLines(buffer, endY) {
  const total = endY != null ? endY : buffer.length;
  let chain = [];
  let chainStartY = -1;
  for (let y = 0; y < total; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (line.isWrapped && chain.length > 0) {
      chain.push(line);
    } else {
      if (chain.length > 0) yield { chain, startY: chainStartY };
      chain = [line];
      chainStartY = y;
    }
  }
  if (chain.length > 0) yield { chain, startY: chainStartY };
}

// First OSC 133 marker found anywhere in [startY, startY+len). A chain may
// span several wrapped rows; the marker can land on any of them (e.g. a prompt
// whose own line wraps).
function oscKindForChain(oscMarkers, startY, len) {
  if (!oscMarkers || oscMarkers.size === 0) return null;
  for (let y = startY; y < startY + len; y++) {
    const k = oscMarkers.get(y);
    if (k) return k;
  }
  return null;
}

// Build the document contract over the engine. The engine owns the buffer read
// model (R7), the OSC marker map, and the write/osc-detected events; this is
// the only place the reader's raw material is assembled.
export function createTerminalDocument(engine) {
  function snapshot() {
    const buffer = engine.getActiveBuffer();
    const cols = engine.cols;
    const total = buffer.length;
    // The very last buffer row is the tmux status line (when status is on). It
    // does not belong in the scrollable flow — peel it off into its own field
    // and stop the logical-line walk one row short.
    const statusEndY = total > 0 ? total - 1 : 0;

    const lines = [];
    for (const { chain, startY } of logicalLines(buffer, statusEndY)) {
      const runs = extractRuns(chain, cols);
      const text = runs.map((r) => r.text).join("");
      const osc = oscKindForChain(engine.oscMarkers, startY, chain.length);
      lines.push({ runs, text, osc });
    }
    // Drop the run of empty rows the terminal pads below the last output up to
    // the status line — the reader is a document, not a fixed grid, so trailing
    // blank space is noise (and would otherwise push the last real line off the
    // bottom of the scroll).
    while (
      lines.length > 0 &&
      (!lines[lines.length - 1].text ||
        lines[lines.length - 1].text.trim().length === 0)
    ) {
      lines.pop();
    }

    let status = null;
    if (total > 0) {
      const line = buffer.getLine(statusEndY);
      if (line) {
        const runs = extractRuns([line], cols);
        if (runs.some((r) => r.text && r.text.trim().length > 0)) {
          status = { runs };
        }
      }
    }

    return { lines, status };
  }

  function onOscDetected(cb) {
    const handler = () => cb();
    engine.addEventListener("osc-detected", handler);
    return {
      dispose() {
        engine.removeEventListener("osc-detected", handler);
      },
    };
  }

  return {
    snapshot,
    subscribe(cb) {
      return engine.onBufferChanged(cb);
    },
    onOscDetected,
    get oscDetected() {
      return engine.oscDetected;
    },
  };
}
