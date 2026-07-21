// Block classifier for the reader.
//
// Groups the document's logical lines into semantic *blocks*. It reads the
// document contract's line shape ({ runs, text, osc }) — cell walking, palette
// decoding, and OSC lookup have moved engine-side into terminal-document.js
// (issue #206, D2). This half stays reader-side: the classification policy is
// a display concern.
//
// Block types:
//   blank    — empty line, used as a separator
//   rule     — a horizontal-rule line (mostly box-drawing chars)
//   prompt   — shell prompt line (OSC 133 A, or ends with $/#/>/❯ …) not
//              followed by a command (OSC 133 not installed, or the prompt
//              is still awaiting input)
//   command  — OSC 133 C..D span grouped with the prompt line that started
//              it: one block per command + its output + its exit status
//              (issue #219). Only produced when C/D markers are present.
//   header   — a single line like `[Section]` or `## Title`
//   code     — inside triple-backtick fences
//   text     — default; consecutive text lines coalesce into one block

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

// A line's `osc` field can carry more than one marker joined by `|` (see
// terminal-engine.js's `oscMarkers` doc comment) — never compare it for
// equality against a single kind.
function oscHas(osc, kind) {
  if (!osc) return false;
  for (const part of osc.split("|")) {
    if (part.charAt(0) === kind) return true;
  }
  return false;
}

// The exit code riding a `D;<code>` marker, or null if the line carries no D
// marker or the payload isn't a number.
function oscExitCode(osc) {
  if (!osc) return null;
  for (const part of osc.split("|")) {
    if (part.charAt(0) !== "D") continue;
    const n = Number(part.slice(2));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// The C..D span immediately following the prompt row at `promptIndex`, or
// null if the prompt isn't followed by a command (OSC 133 not installed
// past this point, or this is the still-open trailing prompt awaiting
// input).
//
// The span's lines run from the C row up to but NOT including the D row.
// The shell always emits `D;$?` immediately followed by `A` in the same
// PS1 write, so by the time a D marker is visible here its row already
// doubles as the START of the next prompt cycle — excluding it lets the
// caller re-enter the main loop on that row and pick up the next command.
// A command with zero output degenerates to an empty span: C and D land on
// the very same row (nothing moved the cursor between them), so `end`
// equals `promptIndex + 1` immediately.
//
// If no D has landed yet, the command is still running: the span extends to
// the end of the document and `exitCode` is null — the caller renders it
// open-ended, same as any other live-streaming block, and it grows on the
// next re-tokenize once more output (or the D) arrives.
function findCommandSpan(lines, promptIndex) {
  const first = lines[promptIndex + 1];
  if (!first || !oscHas(first.osc, "C")) return null;
  let end = promptIndex + 1;
  while (end < lines.length && !oscHas(lines[end].osc, "D")) end++;
  const exitCode = end < lines.length ? oscExitCode(lines[end].osc) : null;
  return {
    outputLines: lines.slice(promptIndex + 1, end),
    endIndex: end,
    exitCode,
  };
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
// { runs, text, osc }, `osc` being null or one or more marker payloads
// joined by `|` (see terminal-document.js's contract doc comment). OSC 133
// markers are consulted before the heuristic classifiers: a row marked A is
// the prompt deterministically. Without markers the classifier falls back to
// the same heuristics — same behaviour for shells without integration.
//
// Classification deliberately keys off A only, never B. tmux forwards each
// DCS passthrough envelope bracketed by its own cursor-position sync; the D+A
// pair rides one envelope immediately followed by the prompt's own text in
// the same shell write, so it inherits the correct cursor position. B closes
// the prompt with nothing riding after it in that write, so under real tmux
// (3.4, confirmed; likely earlier too) it arrives as a lone envelope and
// tmux's sync resets to the pane's home position instead of the true cursor
// row — B lands on whatever line is at the top of the viewport, not the
// prompt's own line. Trusting B for classification turns that line (e.g. a
// motd banner) into a spurious prompt block. A alone is sufficient: it always
// marks the start of the visible prompt text.
export function tokenize(lines) {
  const blocks = [];
  let inFence = false;
  let codeLines = [];
  let i = 0;

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

  while (i < lines.length) {
    const { runs, text, osc } = lines[i];

    if (FENCE_RE.test(text)) {
      if (inFence) {
        flushCode();
        inFence = false;
      } else inFence = true;
      i++;
      continue;
    }
    if (inFence) {
      codeLines.push({ runs, text, bubbleBg: lineBubbleBg(runs) });
      i++;
      continue;
    }

    if (text.trim().length === 0) {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }
    if (isRule(text)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (isHeader(text)) {
      blocks.push({ type: "header", runs, text });
      i++;
      continue;
    }
    // OSC 133 ; A marks the line as a prompt deterministically — no
    // sigil-guessing. `B` doesn't change the line's own classification —
    // see the module doc comment for why it's untrustworthy for row
    // attribution under tmux. When this prompt row is immediately followed
    // by a `C..D` span, the whole span groups into one "command" block
    // instead of a bare "prompt" block (issue #219) — command output falls
    // back to plain lines, not the rule/header/fence classifiers above,
    // since it's raw program output rather than freeform chat text.
    const isOscPrompt = oscHas(osc, "A");
    if (isOscPrompt) {
      const span = findCommandSpan(lines, i);
      if (span) {
        blocks.push({
          type: "command",
          runs,
          text,
          lines: span.outputLines.map((l) => ({
            runs: l.runs,
            text: l.text,
            bubbleBg: lineBubbleBg(l.runs),
          })),
          exitCode: span.exitCode,
        });
        i = span.endIndex;
        continue;
      }
    }
    if (isOscPrompt || isPrompt(text)) {
      blocks.push({ type: "prompt", runs, text });
      i++;
      continue;
    }
    pushTextLine({ runs, text, bubbleBg: lineBubbleBg(runs) });
    i++;
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
  oscHas,
  oscExitCode,
  findCommandSpan,
};
