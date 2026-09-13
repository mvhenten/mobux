// createReadMode — the recorded conversation as a dialogue (issue #234).
//
// Read mode renders a session's recorded turns as a conversation: each turn
// is a card, the typed command in its header with a muted pass/fail chip,
// what came back below it. It is a third view alongside the terminal and the
// reader, and it answers a different question than either — completed turns,
// not the live screen.
//
// Output is not one typeface. A line whose alignment carries meaning —
// indented, columned, box-drawn, a diff — goes into a monospace block,
// because proportional type would destroy the only thing that made it
// readable. Everything else is prose and reads as prose: proportional, a
// real line-height, and a measure that stops before the line gets too long
// to track back to. Read mode is not a picture of a terminal, so it does
// not wear one.
//
// The component never receives the terminal document, the engine core, or a
// renderer handle. That absence is the design: reconciliation with the live
// terminal is not "removed" here, it is unrepresentable. Entries arrive
// through setEntries / appendEntries and nothing else.
//
// ── Factory ─────────────────────────────────────────────────────────────
//   createReadMode({ host, session, handlers, fetchPage, pollIntervalMs })
//     host      the element read mode owns.
//     session   the tmux session name the entries belong to. The conversation
//               record is keyed on session name alone, so there is no node.
//     handlers  cross-cutting callbacks:
//                 onExit()  double-tap → back to the terminal
//     fetchPage (path) → Promise of { entries, nextCursor }. The SPA passes
//               lib/api.js's apiGet, so a failure arrives as an ApiError.
//               Omitted, read mode fetches nothing and is driven entirely by
//               setEntries / appendEntries.
//     pollIntervalMs  refresh cadence; three seconds by default.
//
// ── The loop (issue #236) ───────────────────────────────────────────────
// Mount is one request for the newest turns; every refresh after it resumes
// from the cursor the last response handed back, and new entries are appended
// to the DOM rather than rebuilding it. The tab going hidden stops the timer;
// coming back visible restarts it with an immediate fetch. One request is in
// flight at a time — a tick arriving on top of a pending one is dropped, and
// the interval is the retry interval, so there is no backoff and no queue.
//
// ── Reaching what came before ───────────────────────────────────────────
// That loop only ever moves forward, so on its own the mount page is also
// the ceiling: whatever the server retains before it stays unreachable no
// matter how far you scroll. Scrolling towards the top pulls the previous
// page in through the endpoint's `before` cursor and prepends it, and the
// scroller carries the viewport down by however tall the insertion turned
// out to be so nothing jumps. Backward paging has its own in-flight slot —
// the live refresh must never block a viewer reading history, and vice
// versa — and it stops on the server saying the record has no more, never
// on a page coming back empty.
//
// A failed fetch keeps the last good content and says so in a strip at the
// bottom. It is caught here and never escalated to the SPA's fail-hard error
// page: a stale conversation is not a dead app.
//
// ── Synthetic scrolling ─────────────────────────────────────────────────
// Read mode does not scroll natively — it renders into an inner box that
// synthetic-scroll.js translates. See that module for why.

import { u } from "./base.js";
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
const ERROR_TEXT = "can't reach the server — retrying";

// Three seconds so a finished command appears while you are still looking at
// the screen. The mount asks for the newest turns; a refresh is bounded by the
// endpoint's own page budget, so the limit is a ceiling, not an expectation.
const POLL_INTERVAL_MS = 3000;
const MOUNT_TAIL = 200;
const REFRESH_LIMIT = 500;
// One backward page. Same order as the mount tail: enough that a viewer
// scrolling steadily does not outrun it, small enough to stay one round
// trip on a phone.
const OLDER_LIMIT = 200;
// How close to the top starts the next backward page. A screen or so of
// lead time, so the content is usually there before the viewer arrives.
const NEAR_TOP_PX = 800;

const OLDER_BUTTON_TEXT = "Show earlier";
const OLDER_LOADING_TEXT = "Loading earlier turns…";
const RECORD_START_TEXT = "Start of the recorded conversation";

export function createReadMode({
  host,
  session = "",
  handlers = {},
  fetchPage = null,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  let mounted = false;
  let inner = null;
  let scroller = null;
  let gestures = null;
  let entries = [];
  let cursor = null;
  let inflight = null;
  let timer = null;
  let errorEl = null;
  // The backward half: where the next older page resumes from, whether the
  // server says one exists, and its own in-flight slot.
  let olderCursor = null;
  let hasOlder = false;
  let olderInflight = null;
  let olderEl = null;
  // Bumped on unmount so a response that lands after it can neither advance
  // the cursor nor paint into the next mount's DOM.
  let generation = 0;

  function mountGestures() {
    if (gestures) return;
    gestures = createGestureRecognizer(
      host,
      {
        onScroll: (dy) => scrollBy(dy),
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
    maybeLoadOlder();
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
      inner.replaceChildren(olderEl, frag);
      refreshOlderStrip();
    });
  }

  // The strip sits above everything on screen, so any change to it moves
  // the content below by its own height difference — the same problem a
  // prepended page has, and the same fix. Swapping the button for the
  // loading line is otherwise a visible jump mid-scroll.
  function restripOlder() {
    if (!scroller) {
      refreshOlderStrip();
      return;
    }
    scroller.contentPrepended(() => refreshOlderStrip());
  }

  // The strip above the oldest turn on screen: what the viewer can still
  // reach, or that there is nothing left to reach. It is a control as well
  // as a status, because a conversation shorter than the viewport never
  // generates a scroll to trigger the fetch.
  function refreshOlderStrip() {
    if (!olderEl) return;
    if (olderInflight) {
      olderEl.replaceChildren(
        makeEl("div", "cv-older-status", OLDER_LOADING_TEXT),
      );
      return;
    }
    if (hasOlder) {
      const button = makeEl("button", "cv-older-btn", OLDER_BUTTON_TEXT);
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        loadOlder();
      });
      olderEl.replaceChildren(button);
      return;
    }
    if (entries.length === 0) {
      olderEl.replaceChildren();
      return;
    }
    olderEl.replaceChildren(makeEl("div", "cv-older-start", RECORD_START_TEXT));
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

  // Older turns arrive above everything on screen, so the whole mutation —
  // the strip swapping out of its loading state included — goes through the
  // scroller in one pass. Split across two, the height it measures would
  // miss whichever half ran outside it and the view would jump.
  function prependEntries(next) {
    const added = Array.isArray(next) ? next : [];
    const wasEmpty = entries.length === 0;
    entries = added.concat(entries);
    if (!inner) return;
    if (wasEmpty) {
      render();
      return;
    }
    scroller.contentPrepended(() => {
      refreshOlderStrip();
      if (added.length === 0) return;
      const frag = window.document.createDocumentFragment();
      for (const entry of added) frag.appendChild(buildEntry(entry));
      inner.insertBefore(frag, olderEl.nextSibling);
    });
  }

  // Without a cursor there is nothing to resume from, so the request is the
  // mount request — which is also what a failed mount retries with.
  function conversationPath() {
    const params =
      cursor === null
        ? { tail: String(MOUNT_TAIL) }
        : { cursor, limit: String(REFRESH_LIMIT) };
    const query = new URLSearchParams(params).toString();
    return u(
      `api/sessions/${encodeURIComponent(session)}/conversation?${query}`,
    );
  }

  function olderPath() {
    const query = new URLSearchParams({
      before: olderCursor,
      limit: String(OLDER_LIMIT),
    }).toString();
    return u(
      `api/sessions/${encodeURIComponent(session)}/conversation?${query}`,
    );
  }

  function applyPage(page) {
    const fetched = Array.isArray(page?.entries) ? page.entries : [];
    const first = cursor === null;
    if (typeof page?.nextCursor === "string" && page.nextCursor !== "") {
      cursor = page.nextCursor;
    }
    clearError();
    if (!first) {
      appendEntries(fetched);
      return;
    }
    // Only the mount page establishes where the record continues backwards:
    // a forward refresh's own prevCursor describes its own oldest entry,
    // which is newer than everything already on screen.
    adoptOlderCursor(page, fetched);
    setEntries(fetched);
    maybeLoadOlder();
  }

  function adoptOlderCursor(page, fetched) {
    if (typeof page?.prevCursor === "string" && page.prevCursor !== "") {
      olderCursor = page.prevCursor;
    }
    // An empty page claiming more would spin: a page that carried nothing
    // cannot have moved the cursor, so the next request repeats this one.
    hasOlder =
      page?.hasOlder === true && fetched.length > 0 && olderCursor !== null;
  }

  function applyOlderPage(page) {
    const fetched = Array.isArray(page?.entries) ? page.entries : [];
    adoptOlderCursor(page, fetched);
    clearError();
    prependEntries(fetched);
    maybeLoadOlder();
  }

  function maybeLoadOlder() {
    if (!mounted || !hasOlder || olderInflight || !scroller) return;
    if (scroller.scrollY > NEAR_TOP_PX) return;
    loadOlder();
  }

  function loadOlder() {
    if (!mounted || !fetchPage) return Promise.resolve();
    if (olderInflight) return olderInflight;
    if (!hasOlder || olderCursor === null) return Promise.resolve();
    const gen = generation;
    // The slot is cleared inside the settle, before anything paints, so the
    // strip's own height change rides the same scroller pass as the turns.
    const settle = (handle) => (value) => {
      if (gen !== generation) return;
      olderInflight = null;
      handle(value);
    };
    const request = fetchPage(olderPath()).then(
      settle((older) => applyOlderPage(older)),
      settle(() => {
        showError();
        restripOlder();
      }),
    );
    olderInflight = request;
    restripOlder();
    return request;
  }

  function poll() {
    if (!mounted || !fetchPage) return Promise.resolve();
    if (inflight) return inflight;
    const gen = generation;
    const request = fetchPage(conversationPath())
      .then(
        (page) => {
          if (gen === generation) applyPage(page);
        },
        () => {
          if (gen === generation) showError();
        },
      )
      .finally(() => {
        if (gen === generation) inflight = null;
      });
    inflight = request;
    return request;
  }

  function visible() {
    return window.document.visibilityState === "visible";
  }

  function startTimer() {
    if (timer !== null) return;
    timer = window.setInterval(poll, pollIntervalMs);
  }

  function stopTimer() {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
  }

  // A phone in a pocket does not poll; picking it back up refreshes at once
  // rather than waiting out an interval.
  function onVisibilityChange() {
    if (!mounted) return;
    if (!visible()) {
      stopTimer();
      return;
    }
    startTimer();
    poll();
  }

  function showError() {
    if (!mounted || errorEl) return;
    errorEl = makeEl("div", "cv-error", ERROR_TEXT);
    host.appendChild(errorEl);
  }

  function clearError() {
    if (!errorEl) return;
    errorEl.remove();
    errorEl = null;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    host.classList.remove("hidden");
    host.classList.add("cv-host");

    inner = window.document.createElement("div");
    inner.className = "cv-inner";
    olderEl = makeEl("div", "cv-older");
    host.replaceChildren(inner);

    scroller = createSyntheticScroller({ host, inner });

    mountGestures();
    // A fresh scroller starts at the bottom, and render() runs through
    // contentChanged, so the first paint is already pinned there.
    render();

    if (!fetchPage) return;
    window.document.addEventListener("visibilitychange", onVisibilityChange);
    if (!visible()) return;
    startTimer();
    poll();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    host.classList.add("hidden");

    generation++;
    stopTimer();
    window.document.removeEventListener("visibilitychange", onVisibilityChange);
    inflight = null;
    cursor = null;
    errorEl = null;
    olderInflight = null;
    olderCursor = null;
    hasOlder = false;
    olderEl = null;

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

  // Fetch now and resolve once the resulting render is on screen — the whole
  // of read mode's imperative surface. There is deliberately no forceRender():
  // a caller that can re-render on demand is a caller that can spin, which is
  // what made PR #230's poll loop the main thread's busiest tenant.
  function refreshNow() {
    return poll();
  }

  return {
    mount,
    unmount,
    dispose,
    setEntries,
    appendEntries,
    refreshNow,
    loadOlderNow: () => loadOlder(),
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
    get hasOlder() {
      return hasOlder;
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
    if (ch === "\u001b") {
      i = skipEscape(input, i + 1);
      continue;
    }
    // 8-bit C1 introducers. tmux normalises to 7-bit, but anything reaching
    // storage unnormalised would otherwise leak its parameters into the
    // rendered text.
    const code = input.charCodeAt(i);
    if (code >= 0x80 && code <= 0x9f) {
      if (code === 0x9b) i = skipControlSequence(input, i + 1);
      else if (isC1StringIntroducer(code)) i = skipStringSequence(input, i + 1);
      else i += 1;
      continue;
    }
    out += ch;
    i++;
  }

  return normaliseControls(out);
}

function skipEscape(text, start) {
  const n = text.length;
  if (start >= n) return n;
  const kind = text[start];
  if (kind === "[") return skipControlSequence(text, start + 1);
  // OSC (including any OSC 133 marker that leaked into `output`), DCS, SOS,
  // PM and APC.
  if (
    kind === "]" ||
    kind === "P" ||
    kind === "X" ||
    kind === "^" ||
    kind === "_"
  ) {
    return skipStringSequence(text, start + 1);
  }
  // SS2 / SS3 shift the single character that follows.
  if (kind === "N" || kind === "O") return start + 2;
  // Everything else: optional intermediates, then one final byte.
  let i = start;
  while (i < n && isIntermediateByte(text.charCodeAt(i))) i++;
  return i < n ? i + 1 : n;
}

// DCS, SOS, OSC, PM, APC.
function isC1StringIntroducer(code) {
  return (
    code === 0x90 ||
    code === 0x98 ||
    code === 0x9d ||
    code === 0x9e ||
    code === 0x9f
  );
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

// A string sequence whose terminator never arrives must not swallow the rest
// of the turn. An entry's tail can end mid-sequence by construction — storage
// keeps the first 256 KiB and the wire cap keeps the last 16 KiB — and output
// disappearing with nothing on screen to say so is the one failure read mode
// cannot have. Bound the scan the way xterm.js's own OSC parser does: BEL and
// ST end the string, a newline or an ESC that is not ST aborts it, and the
// aborting byte is left in place to be handled as itself.
function skipStringSequence(text, start) {
  let i = start;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "\u0007" || ch === "\u009c") return i + 1;
    if (ch === "\n") return i;
    if (ch === "\u001b") return text[i + 1] === "\\" ? i + 2 : i;
    i++;
  }
  return n;
}

function normaliseControls(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => lastWrittenSegment(stripControls(line)))
    .join("\n");
}

// Tabs and carriage returns survive this pass; the rest of C0, DEL and the
// whole C1 block do not.
function stripControls(line) {
  return line.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    "",
  );
}

// A line rewritten in place by bare carriage returns — a progress bar —
// renders as its final state rather than a hundred overwritten copies. The
// final state is the last segment that was actually written: a progress bar's
// last byte is nearly always the carriage return before the shell's next
// output, and taking the empty tail after it would erase the line.
function lastWrittenSegment(line) {
  const segments = line.split("\r");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "") return segments[i];
  }
  return "";
}

// ── DOM ────────────────────────────────────────────────────────────
function buildEntry(entry) {
  if (typeof entry.raw === "string") return buildRaw(entry);
  return buildTurn(entry);
}

function buildTurn(entry) {
  const turn = makeEl("article", "cv-turn");
  turn.dataset.seq = String(entry.seq);

  const head = makeEl("header", "cv-turn-head");
  head.appendChild(buildCommand(entry.command));
  const chip = buildExitChip(entry.exitCode);
  if (chip) head.appendChild(chip);
  turn.appendChild(head);

  const output = buildOutput(entry);
  if (output) turn.appendChild(output);

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

  for (const group of groupByShape(lines)) {
    el.appendChild(
      group.mono ? buildCodeGroup(group.lines) : buildProseGroup(group.lines),
    );
  }
  return el;
}

// ── Shape classification ───────────────────────────────────────────
// Whether a line needs a fixed-width grid to stay readable. Indentation,
// interior column gaps, box drawing and diff markers all mean the same
// thing: the horizontal positions are the content.
const INDENTED_RE = /^(?: {2,}|\t)/;
const COLUMNED_RE = /\S {2,}\S/;
const BOX_DRAWN_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]/;
const DIFF_RE = /^(?:[+-]{1,3}[ \t]|@@ )/;
const CODEY_RE = /[{}[\]();]|=>|::|\|\||&&|^\s*[$#>]\s/;

function isMonoLine(text) {
  if (text === "") return false;
  return (
    INDENTED_RE.test(text) ||
    COLUMNED_RE.test(text) ||
    BOX_DRAWN_RE.test(text) ||
    DIFF_RE.test(text) ||
    CODEY_RE.test(text)
  );
}

// Consecutive lines of the same shape form one block. A blank line joins
// whatever block it sits in rather than splitting it, so a code listing
// with a gap in it stays one listing.
function groupByShape(lines) {
  const groups = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && (line === "" || last.mono === isMonoLine(line))) {
      last.lines.push(line);
      continue;
    }
    if (line === "") continue;
    groups.push({ mono: isMonoLine(line), lines: [line] });
  }
  for (const group of groups) trimBlankEdges(group.lines);
  return groups.filter((group) => group.lines.length > 0);
}

function trimBlankEdges(lines) {
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 0 && lines[0] === "") lines.shift();
}

function buildProseGroup(lines) {
  const block = makeEl("div", "cv-prose");
  for (const line of lines) {
    block.appendChild(makeEl("div", "cv-line", line === "" ? "\u00a0" : line));
  }
  return block;
}

function buildCodeGroup(lines) {
  const block = makeEl("pre", "cv-code");
  for (const line of lines) {
    block.appendChild(
      makeEl("div", "cv-codeline", line === "" ? "\u00a0" : line),
    );
  }
  return block;
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
  link.href = u("settings#shell-integration");
  wrap.appendChild(link);
  return wrap;
}

function makeEl(tag, className, text) {
  const el = window.document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
