// createReadMode — the recorded conversation as a dialogue (issue #234).
//
// Read mode renders a session's recorded turns: the typed command on the
// left, its output on the right, proportional and reflowed, with a muted
// pass/fail chip. It is a third view alongside the terminal and the reader,
// and it answers a different question than either — completed turns, not the
// live screen.
//
// The component never receives the terminal document, the engine core, or a
// renderer handle. That absence is the design: reconciliation with the live
// terminal is not "removed" here, it is unrepresentable. Entries arrive
// through setEntries / appendEntries and nothing else.
//
// ── Factory ─────────────────────────────────────────────────────────────
//   createReadMode({ host, session, handlers }) → read-mode handle
//     host      the element read mode owns.
//     session   the tmux session name the entries belong to. The conversation
//               record is keyed on session name alone, so there is no node.
//     handlers  cross-cutting callbacks:
//                 onExit()  double-tap → back to the terminal
//
// There is no fetching here. The poll loop feeds this component; it does not
// live in it.
//
// ── Synthetic scrolling ─────────────────────────────────────────────────
// Read mode does not scroll natively — it renders into an inner box that
// synthetic-scroll.js translates. See that module for why.

import { createGestureRecognizer } from "./touch.js";
import { createSyntheticScroller } from "./synthetic-scroll.js";

// Hard DOM bound on one turn's output, behind the endpoint's own wire cap:
// 16 KiB of one-character lines is still thousands of nodes.
const OUTPUT_LINE_LIMIT = 200;

// The prompt prefix is de-emphasised, never removed, so a wrong split costs
// nothing but weight. `> ` is deliberately absent: it is a redirection far
// more often than a prompt, and splitting at the last one mis-reads
// `make > build.log`.
const PROMPT_SIGILS = ["$ ", "% ", "# ", "❯ ", "➜ "];

const EMPTY_COMMAND_TEXT = "(command not recorded)";
const EMPTY_STATE_TEXT =
  "Nothing recorded yet. Commands appear here as they finish.";

export function createReadMode({ host, session = "", handlers = {} } = {}) {
  let mounted = false;
  let inner = null;
  let scroller = null;
  let gestures = null;
  let entries = [];

  function mountGestures() {
    if (gestures) return;
    gestures = createGestureRecognizer(
      host,
      {
        onScroll: (dy) => scrollBy(dy),
        onTap: () => {},
        // Read mode is not a live view: no long-press command menu, and no
        // horizontal window switch, because the record is per session and
        // windows have no meaning in it.
        onDoubleTap: () => handlers.onExit?.(),
      },
      { passiveScroll: false },
    );
  }

  function unmountGestures() {
    if (!gestures) return;
    gestures.destroy();
    gestures = null;
  }

  function scrollBy(dy) {
    if (!mounted) return;
    scroller.scrollBy(dy);
  }

  function stickToBottom() {
    if (!mounted) return;
    scroller.stickToBottom();
  }

  function render() {
    if (!inner) return;
    scroller.contentChanged(() => {
      const frag = window.document.createDocumentFragment();
      if (entries.length === 0) frag.appendChild(buildEmptyState());
      else for (const entry of entries) frag.appendChild(buildEntry(entry));
      inner.replaceChildren(frag);
    });
  }

  function setEntries(next) {
    entries = Array.isArray(next) ? next.slice() : [];
    render();
  }

  function appendEntries(next) {
    const added = Array.isArray(next) ? next : [];
    if (added.length === 0) return;
    const wasEmpty = entries.length === 0;
    entries = entries.concat(added);
    if (!inner) return;
    if (wasEmpty) {
      render();
      return;
    }
    // Existing turns are left alone — appending below never moves content
    // above, so nothing already rendered is rebuilt.
    scroller.contentChanged(() => {
      const frag = window.document.createDocumentFragment();
      for (const entry of added) frag.appendChild(buildEntry(entry));
      inner.appendChild(frag);
    });
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    host.classList.remove("hidden");
    host.classList.add("cv-host");

    inner = window.document.createElement("div");
    inner.className = "cv-inner";
    host.replaceChildren(inner);

    scroller = createSyntheticScroller({ host, inner });

    mountGestures();
    render();
    scroller.stickToBottom();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    host.classList.add("hidden");

    unmountGestures();
    if (scroller) {
      scroller.dispose();
      scroller = null;
    }
    host.replaceChildren();
    inner = null;
  }

  function dispose() {
    unmount();
  }

  return {
    mount,
    unmount,
    dispose,
    setEntries,
    appendEntries,
    scrollBy,
    stickToBottom,
    get session() {
      return session;
    },
    get mounted() {
      return mounted;
    },
    get entryCount() {
      return entries.length;
    },
    get scrollY() {
      return scroller ? scroller.scrollY : 0;
    },
    get maxScroll() {
      return scroller ? scroller.maxScroll : 0;
    },
    get atBottom() {
      return scroller ? scroller.atBottom : true;
    },
  };
}

// ── Escape stripping ───────────────────────────────────────────────
// Escape sequences are stripped, not interpreted. Colour is not preserved:
// keeping SGR means a colour parser, which is the first step back toward the
// terminal emulation read mode exists to avoid, and proportional reflow has
// already discarded the grid most coloured output depends on.
export function ansiToText(input) {
  if (typeof input !== "string" || input === "") return "";

  let out = "";
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    if (ch !== "\u001b") {
      out += ch;
      i++;
      continue;
    }
    i++;
    if (i >= n) break;
    const kind = input[i];
    if (kind === "[") {
      i = skipControlSequence(input, i + 1);
      continue;
    }
    // OSC (including any OSC 133 marker that leaked into `output`), DCS, SOS,
    // PM and APC all run until BEL or ST.
    if (
      kind === "]" ||
      kind === "P" ||
      kind === "X" ||
      kind === "^" ||
      kind === "_"
    ) {
      i = skipStringSequence(input, i + 1);
      continue;
    }
    // SS2 / SS3 shift the single character that follows.
    if (kind === "N" || kind === "O") {
      i += 2;
      continue;
    }
    // Everything else: optional intermediates, then one final byte.
    while (i < n && isIntermediateByte(input.charCodeAt(i))) i++;
    if (i < n) i++;
  }

  return normaliseControls(out);
}

function isIntermediateByte(code) {
  return code >= 0x20 && code <= 0x2f;
}

function skipControlSequence(text, start) {
  let i = start;
  const n = text.length;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code < 0x30 || code > 0x3f) break;
    i++;
  }
  while (i < n && isIntermediateByte(text.charCodeAt(i))) i++;
  if (i < n) i++;
  return i;
}

function skipStringSequence(text, start) {
  let i = start;
  const n = text.length;
  while (i < n) {
    if (text[i] === "\u0007") return i + 1;
    if (text[i] === "\u001b" && text[i + 1] === "\\") return i + 2;
    i++;
  }
  return n;
}

function normaliseControls(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      // A line rewritten in place by bare carriage returns — a progress bar —
      // renders as its final state, not a hundred overwritten copies.
      const at = line.lastIndexOf("\r");
      const kept = at === -1 ? line : line.slice(at + 1);
      return kept.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
    })
    .join("\n");
}

// ── DOM ────────────────────────────────────────────────────────────
function buildEntry(entry) {
  if (typeof entry.raw === "string") return buildRaw(entry);
  return buildTurn(entry);
}

function buildTurn(entry) {
  const turn = makeEl("article", "cv-turn");
  turn.dataset.seq = String(entry.seq);
  turn.appendChild(buildCommand(entry.command));

  const output = buildOutput(entry);
  if (output) turn.appendChild(output);

  const chip = buildExitChip(entry.exitCode);
  if (chip) turn.appendChild(chip);

  return turn;
}

function buildCommand(command) {
  const el = makeEl("div", "cv-cmd");
  const text = typeof command === "string" ? command : "";

  // The segmenter has a known timing gap that can land a turn with no command
  // text. Render the placeholder so the dialogue structure holds and the
  // output is still attributed to something.
  if (text.trim() === "") {
    el.classList.add("cv-cmd--empty");
    el.textContent = EMPTY_COMMAND_TEXT;
    return el;
  }

  const { prefix, rest } = splitPrompt(text);
  if (prefix) {
    const prefixEl = makeEl("span", "cv-cmd-prompt");
    prefixEl.textContent = prefix;
    el.appendChild(prefixEl);
  }
  const textEl = makeEl("span", "cv-cmd-text");
  textEl.textContent = rest;
  el.appendChild(textEl);
  return el;
}

function splitPrompt(text) {
  let cut = -1;
  for (const sigil of PROMPT_SIGILS) {
    const at = text.lastIndexOf(sigil);
    if (at === -1) continue;
    const end = at + sigil.length;
    if (end > cut) cut = end;
  }
  if (cut === -1) return { prefix: "", rest: text };
  return { prefix: text.slice(0, cut), rest: text.slice(cut) };
}

function buildOutput(entry) {
  let lines = toLines(ansiToText(entry.output || ""));
  const droppedLines = Math.max(0, lines.length - OUTPUT_LINE_LIMIT);
  const droppedBytes = Number(entry.outputTruncatedBytes) || 0;
  if (lines.length === 0 && droppedBytes <= 0) return null;

  const el = makeEl("div", "cv-out");

  // The two markers report different facts — the server dropped bytes off the
  // front of the wire payload, the clamp dropped lines off what arrived —
  // so both render when both apply.
  if (droppedBytes > 0) {
    const kb = Math.max(1, Math.round(droppedBytes / 1024));
    el.appendChild(
      makeEl(
        "div",
        "cv-trunc cv-trunc--server",
        `… ${kb} KB dropped by the server`,
      ),
    );
  }
  if (droppedLines > 0) {
    el.appendChild(
      makeEl(
        "div",
        "cv-trunc cv-trunc--clamp",
        `… ${droppedLines} earlier lines`,
      ),
    );
    lines = lines.slice(-OUTPUT_LINE_LIMIT);
  }

  for (const line of lines) {
    el.appendChild(makeEl("div", "cv-line", line === "" ? "\u00a0" : line));
  }
  return el;
}

function toLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildExitChip(exitCode) {
  if (exitCode === null || exitCode === undefined) return null;
  const ok = exitCode === 0;
  const chip = makeEl(
    "span",
    `cv-exit ${ok ? "cv-exit--ok" : "cv-exit--fail"}`,
    ok ? "✓" : `✗ ${exitCode}`,
  );
  chip.title = `exit ${exitCode}`;
  return chip;
}

function buildRaw(entry) {
  const el = makeEl("div", "cv-raw", ansiToText(entry.raw));
  el.dataset.seq = String(entry.seq);
  return el;
}

// An un-instrumented shell is the likeliest reason for an empty record, so
// the hint is unconditional — read mode does not consult the terminal
// document to find out whether OSC 133 is installed.
function buildEmptyState() {
  const wrap = makeEl("div", "cv-empty");
  wrap.appendChild(makeEl("p", "cv-empty-text", EMPTY_STATE_TEXT));
  const link = makeEl("a", "cv-empty-link", "Set up shell integration →");
  link.href = "/settings#shell-integration";
  wrap.appendChild(link);
  return wrap;
}

function makeEl(tag, className, text) {
  const el = window.document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
