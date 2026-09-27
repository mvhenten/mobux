// The terminal document contract — a read-only view of the engine's text
// buffer (terminal-buffer.js) for the reader (issues #206, #315).
//
// The reader draws the same buffer the displays draw, never a display. The
// lines come from the buffer's line model: one line per history line, then
// the screen's scrollback and viewport grouped into logical lines, the
// viewport line that continues the last history line (a straddle) joined
// onto it. Cell walking, palette decoding, OSC lookup by line key, and the
// tmux status-line peel live behind this contract; block classification
// stays reader-side.
//
// ── Contract ────────────────────────────────────────────────────────────
//   snapshot(): { lines, status }
//     lines   logical lines, each: { runs: [{ text, attrs }], text, osc }
//             `osc` is null, or one or more OSC 133 marker payloads joined by
//             `|` when more than one lands on the same line (e.g. `'A'`,
//             `'C'`, `'D;0'`, `'D;0|A'`) — see terminal-engine.js's
//             `oscMarkers` doc comment. Consumers scan for a kind rather than
//             compare for equality; term-tokenizer.js's `oscHas`/
//             `oscExitCode` do this.
//     status  the tmux status line as a separate field: { runs } | null
//   subscribe(cb): Disposable    fires after each buffer change
//   onOscDetected(cb): Disposable   fires the first time an OSC 133 marker lands
//   oscDetected: boolean

import { isBlankCell, logicalLines } from "./terminal-buffer.js";

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

// A row's cells, the trailing blank ones left out when `trim`.
function* rowCells(row, trim) {
  let end = row.length;
  if (trim) {
    while (end > 0 && isBlankCell(row.getCell(end - 1))) end--;
  }
  for (let x = 0; x < end; x++) {
    const cell = row.getCell(x);
    if (cell && cell.getWidth() > 0) yield cell;
  }
}

// ── Run extraction ─────────────────────────────────────────────────
// Group a logical line's cells into runs of identical attrs. `segments` are
// { rows, trim }: the rows of a wrapped chain run on, a history row ends at
// its last cell. Trailing whitespace is stripped.
function extractRuns(segments) {
  const runs = [];
  let cur = null;
  for (const { rows, trim } of segments) {
    for (const row of rows) {
      if (!row) continue;
      for (const cell of rowCells(row, trim)) {
        const text = cell.getChars() || " ";
        const attrs = cellAttrs(cell);
        if (cur && attrsEqual(cur.attrs, attrs)) {
          cur.text += text;
        } else {
          if (cur) runs.push(cur);
          cur = { text, attrs };
        }
      }
    }
  }
  if (cur) runs.push(cur);
  // Terminal apps pad lines with spaces; with a non-default bg they would
  // render as empty chips at the end of the line.
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

// The buffer's lines as { segments, key }, and the rows outside the pane
// (tmux's status line) on the side.
function bufferLines(buffer, paneRows) {
  const lines = [];
  const start = buffer.historyStart();
  const count = buffer.historyRowCount();
  for (let i = 0; i < count; i++) {
    lines.push({
      segments: [{ rows: [buffer.historyRow(i)], trim: true }],
      key: start + i,
    });
  }
  logicalLines(buffer.scrollbackRows()).forEach((rows, j) => {
    lines.push({ segments: [{ rows, trim: false }], key: start + count + j });
  });

  const { first, last } = paneRows;
  const base = buffer.screenKeyBase();
  const straddles = buffer.straddles() && count > 0;
  const status = [];
  let row = 0;
  logicalLines(buffer.viewportRows()).forEach((rows, index) => {
    const at = row;
    row += rows.length;
    if (at < first || at > last) {
      status.push(...rows);
      return;
    }
    if (index === 0 && straddles) {
      lines[count - 1].segments.push({ rows, trim: false });
      return;
    }
    lines.push({ segments: [{ rows, trim: false }], key: base + index });
  });
  return { lines, status };
}

// Build the document contract over the engine: its buffer, its OSC marker
// map by line key, its pane rows, and its buffer-change and osc-detected
// events.
export function createTerminalDocument(engine) {
  function snapshot() {
    const markers = engine.oscMarkers;
    const { lines: raw, status: statusRows } = bufferLines(
      engine.buffer,
      engine.paneRows(),
    );
    const lines = raw.map(({ segments, key }) => {
      const runs = extractRuns(segments);
      const text = runs.map((r) => r.text).join("");
      return { runs, text, osc: markers.get(key) || null };
    });
    // The reader is a document, not a fixed grid: the blank rows below the
    // last output are noise.
    while (lines.length > 0 && lines[lines.length - 1].text.trim() === "") {
      lines.pop();
    }

    let status = null;
    for (const row of statusRows) {
      const runs = extractRuns([{ rows: [row], trim: false }]);
      if (runs.some((r) => r.text.trim().length > 0)) {
        status = { runs };
        break;
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
