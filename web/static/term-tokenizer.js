// Streaming terminal-output tokenizer.
//
// Reads xterm.js's already-parsed buffer and emits a list of *blocks*
// (semantic groupings of lines) with per-cell colour and attribute
// information preserved as *runs*.
//
// Pure function over the buffer — no DOM, no xterm dependency at the
// type level. ReaderView calls `tokenize(buffer)` after each write and
// re-renders. We can swap in a smarter incremental version later.
//
// Block types (v1):
//   blank   — empty line, used as a separator
//   rule    — a horizontal-rule line (mostly box-drawing chars)
//   prompt  — shell prompt line (ends with $/#/>/❯ or matches cwd-ish)
//   header  — a single line like `[Section]` or `## Title`
//   code    — inside triple-backtick fences, JSON-ish multi-line
//   text    — default; consecutive text lines coalesce into one block
//
// Runs:
//   { text, fg, bg, bold, italic, underline, dim, inverse }
//   fg/bg are CSS colour strings or null (= default theme colour).

// ── ANSI 256-colour palette (xterm default) ────────────────────────
// Index 0-15 are the basic ANSI colours; we expose those via CSS
// variables so themes can tweak them. Index 16-255 are the standard
// xterm extended palette (216-colour cube + 24 greys).
const ANSI_BASIC_VARS = [
  'var(--ansi-0)',  'var(--ansi-1)',  'var(--ansi-2)',  'var(--ansi-3)',
  'var(--ansi-4)',  'var(--ansi-5)',  'var(--ansi-6)',  'var(--ansi-7)',
  'var(--ansi-8)',  'var(--ansi-9)',  'var(--ansi-10)', 'var(--ansi-11)',
  'var(--ansi-12)', 'var(--ansi-13)', 'var(--ansi-14)', 'var(--ansi-15)',
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
const ANSI_EXTENDED = buildExtendedPalette(); // length 240, mapped to indices 16..255

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
  const isDefault = kind === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;
  const isRGB = kind === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = kind === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const value = kind === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (isRGB) return rgbColour(value);
  if (isPalette) return paletteColour(value);
  return null;
}

function cellAttrs(cell) {
  return {
    fg: cellColour(cell, 'fg'),
    bg: cellColour(cell, 'bg'),
    bold: !!cell.isBold(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    dim: !!cell.isDim(),
    inverse: !!cell.isInverse(),
  };
}

function attrsEqual(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold
    && a.italic === b.italic && a.underline === b.underline
    && a.dim === b.dim && a.inverse === b.inverse;
}

function attrsAreDefault(a) {
  return a.fg === null && a.bg === null && !a.bold && !a.italic
    && !a.underline && !a.dim && !a.inverse;
}

// ── Run extraction ─────────────────────────────────────────────────
// Walk a logical line's cells (possibly spanning multiple buffer rows
// when wrapped) and group consecutive cells with identical attrs into
// runs. Trailing default-attr whitespace is stripped.
//
// `line` here is an array of xterm IBufferLine objects (the wrapped
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
      // Empty (null) cells past content: stop adding to runs once we
      // hit one with no character AND default attrs. We can't fully
      // skip them mid-line because some apps fill with spaces.
      const text = ch === '' ? ' ' : ch;
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
  // Trim trailing default-attr whitespace from the last run.
  if (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (attrsAreDefault(last.attrs)) {
      last.text = last.text.replace(/\s+$/u, '');
      if (last.text.length === 0) runs.pop();
    }
  }
  return runs;
}

// ── Classifiers ────────────────────────────────────────────────────
const PROMPT_RE = /(?:^|\s)([~/][^$#❯➜›▶›⟩>]*)?\s*[#$❯➜›▶➤⟩>]\s*$/u;
// Matches "[Word]" or "[Some Words]" alone on a line.
const HEADER_BRACKET_RE = /^\s*\[[A-Za-z][A-Za-z0-9 _-]*\]\s*$/;
// Matches markdown-ish headers "##", "###" etc.
const HEADER_HASH_RE = /^\s*#{1,4}\s+\S/;
// Box-drawing: U+2500..257F, plus = and -. Need length >= 8 and >=70%
// of non-space chars to be box-drawing.
const BOX_DRAW_RE = /[\u2500-\u257F=─━═]/g;
const FENCE_RE = /^\s*```/;

function isRule(text) {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  const hits = (trimmed.match(BOX_DRAW_RE) || []).length;
  return hits / trimmed.length > 0.7;
}

function isPrompt(text) {
  if (text.length === 0) return false;
  // Must end with a prompt sigil possibly followed by trailing space
  // we already trimmed. Quick check first to avoid regex on every line.
  const trimmedRight = text.replace(/\s+$/u, '');
  const last = trimmedRight.slice(-1);
  if ('#$>❯➜›▶➤⟩'.indexOf(last) === -1) return false;
  return PROMPT_RE.test(trimmedRight);
}

function isHeader(text) {
  return HEADER_BRACKET_RE.test(text) || HEADER_HASH_RE.test(text);
}

// Compute the bubble background for a line: the bg colour shared by
// every non-whitespace run, or null if the line is mixed / unbgd.
// Lines with a single colour spanning their whole content render as
// chat-bubble blocks rather than per-glyph chips, and consecutive
// lines with the same bubbleBg fuse into one bubble.
function lineBubbleBg(runs) {
  let bg = null;
  let sawContent = false;
  for (const r of runs) {
    if (!r.text || r.text.trim().length === 0) continue;
    sawContent = true;
    if (r.attrs.bg === null) return null;
    if (bg === null) bg = r.attrs.bg;
    else if (bg !== r.attrs.bg) return null;
  }
  return sawContent ? bg : null;
}

// ── Logical-line iteration ─────────────────────────────────────────
// Coalesces wrapped rows so the reader gets one entry per logical
// line and can reflow on its own width.
function* logicalLines(buffer) {
  const total = buffer.length;
  let chain = [];
  for (let y = 0; y < total; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (line.isWrapped && chain.length > 0) {
      chain.push(line);
    } else {
      if (chain.length > 0) yield chain;
      chain = [line];
    }
  }
  if (chain.length > 0) yield chain;
}

// ── Main entry point ───────────────────────────────────────────────
export function tokenize(buffer, cols) {
  const blocks = [];
  let inFence = false;
  let codeLines = [];

  function flushCode() {
    if (codeLines.length === 0) return;
    blocks.push({ type: 'code', lines: codeLines });
    codeLines = [];
  }

  function pushTextLine(line) {
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') last.lines.push(line);
    else blocks.push({ type: 'text', lines: [line] });
  }

  for (const chain of logicalLines(buffer)) {
    const runs = extractRuns(chain, cols);
    const text = runs.map((r) => r.text).join('');

    if (FENCE_RE.test(text)) {
      if (inFence) { flushCode(); inFence = false; }
      else inFence = true;
      continue;
    }
    if (inFence) {
      codeLines.push({ runs, text, bubbleBg: lineBubbleBg(runs) });
      continue;
    }

    if (text.trim().length === 0) {
      blocks.push({ type: 'blank' });
      continue;
    }
    if (isRule(text)) {
      blocks.push({ type: 'rule' });
      continue;
    }
    if (isHeader(text)) {
      blocks.push({ type: 'header', runs, text });
      continue;
    }
    if (isPrompt(text)) {
      blocks.push({ type: 'prompt', runs, text });
      continue;
    }
    pushTextLine({ runs, text, bubbleBg: lineBubbleBg(runs) });
  }
  if (inFence) flushCode();
  return blocks;
}

// Exposed for unit tests.
export const _internals = {
  isRule, isPrompt, isHeader, attrsEqual, attrsAreDefault,
  paletteColour, rgbColour, lineBubbleBg,
};
