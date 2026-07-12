// Block classifier for the reader.
//
// Groups the document's logical lines into semantic *blocks*. It reads the
// document contract's line shape ({ runs, text, osc }) — cell walking, palette
// decoding, and OSC lookup have moved engine-side into terminal-document.js
// (issue #206, D2). This half stays reader-side: the classification policy is
// a display concern.
//
// Block types:
//   blank   — empty line, used as a separator
//   rule    — a horizontal-rule line (mostly box-drawing chars)
//   prompt  — shell prompt line (OSC 133 A/B, or ends with $/#/>/❯ …)
//   header  — a single line like `[Section]` or `## Title`
//   code    — inside triple-backtick fences
//   text    — default; consecutive text lines coalesce into one block

// ── Classifiers ────────────────────────────────────────────────────
const PROMPT_RE = /(?:^|\s)([~/][^$#❯➜›▶›⟩>]*)?\s*[#$❯➜›▶➤⟩>]\s*$/u;
// Matches "[Word]" or "[Some Words]" alone on a line.
const HEADER_BRACKET_RE = /^\s*\[[A-Za-z][A-Za-z0-9 _-]*\]\s*$/;
// Matches markdown-ish headers "##", "###" etc.
const HEADER_HASH_RE = /^\s*#{1,4}\s+\S/;
// Box-drawing: U+2500..257F, plus = and -. Need length >= 8 and >=70% of
// non-space chars to be box-drawing.
const BOX_DRAW_RE = /[\u2500-\u257F=\u2500\u2501\u2550]/g;
const FENCE_RE = /^\s*```/;

function isRule(text) {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  const hits = (trimmed.match(BOX_DRAW_RE) || []).length;
  return hits / trimmed.length > 0.7;
}

function isPrompt(text) {
  if (text.length === 0) return false;
  // Must end with a prompt sigil possibly followed by trailing space we
  // already trimmed. Quick check first to avoid regex on every line.
  const trimmedRight = text.replace(/\s+$/u, "");
  const last = trimmedRight.slice(-1);
  if ("#$>❯➜›▶➤⟩".indexOf(last) === -1) return false;
  return PROMPT_RE.test(trimmedRight);
}

function isHeader(text) {
  return HEADER_BRACKET_RE.test(text) || HEADER_HASH_RE.test(text);
}

// Compute the bubble background for a line: the bg colour shared by every
// non-whitespace run, or null if the line is mixed / unbgd. Lines with a
// single colour spanning their whole content render as chat-bubble blocks
// rather than per-glyph chips, and consecutive lines with the same bubbleBg
// fuse into one bubble.
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

// ── Main entry point ───────────────────────────────────────────────
// `lines` is the document contract's logical-line array: each entry is
// { runs, text, osc } (osc = 'A'|'B'|'C'|'D'|null). OSC 133 markers are
// consulted before the heuristic classifiers: a row marked A/B is the prompt
// deterministically. Without markers the classifier falls back to the same
// heuristics — same behaviour for shells without integration.
export function tokenize(lines) {
  const blocks = [];
  let inFence = false;
  let codeLines = [];

  function flushCode() {
    if (codeLines.length === 0) return;
    blocks.push({ type: "code", lines: codeLines });
    codeLines = [];
  }

  function pushTextLine(line) {
    const last = blocks[blocks.length - 1];
    if (last && last.type === "text") last.lines.push(line);
    else blocks.push({ type: "text", lines: [line] });
  }

  for (const { runs, text, osc } of lines) {
    if (FENCE_RE.test(text)) {
      if (inFence) {
        flushCode();
        inFence = false;
      } else inFence = true;
      continue;
    }
    if (inFence) {
      codeLines.push({ runs, text, bubbleBg: lineBubbleBg(runs) });
      continue;
    }

    if (text.trim().length === 0) {
      blocks.push({ type: "blank" });
      continue;
    }
    // OSC 133 ; A / B marks the line as a prompt deterministically — no
    // sigil-guessing. `C` and `D` mark output start/end; they don't change the
    // line's own classification here.
    const isOscPrompt = osc === "A" || osc === "B";
    if (isRule(text)) {
      blocks.push({ type: "rule" });
      continue;
    }
    if (isHeader(text)) {
      blocks.push({ type: "header", runs, text });
      continue;
    }
    if (isOscPrompt || isPrompt(text)) {
      blocks.push({ type: "prompt", runs, text });
      continue;
    }
    pushTextLine({ runs, text, bubbleBg: lineBubbleBg(runs) });
  }
  if (inFence) flushCode();
  return blocks;
}

// Exposed for unit tests.
export const _internals = {
  isRule,
  isPrompt,
  isHeader,
  lineBubbleBg,
};
