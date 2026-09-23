// createReader — a standalone reader component on the terminal document seam
// (issue #206, D1).
//
// The reader is a sibling of the terminal, not engine code. It renders the
// terminal document (a read-only view of the active buffer, see
// terminal-document.js) as a phone-friendly document: proportional type,
// reflowed to the viewer's width, colours kept as styling, grouped into
// blocks, scrolled by touch. It is display-only — it never touches the
// session, the WebSocket, or the renderer.
//
// The engine has no knowledge that a reader exists. The SPA (TerminalIsland)
// mounts and unmounts it next to createTerminal and owns view state.
//
// ── Factory ─────────────────────────────────────────────────────────────
//   createReader({ host, document, handlers }) → reader handle
//     host      the #reader element the reader owns.
//     document  the terminal document contract: { snapshot, subscribe,
//               onOscDetected, oscDetected }.
//     handlers  cross-cutting callbacks the reader's gestures call up to the
//               owner (the terminal + the SPA view controller):
//                 onCommandMenu()          long-press / swipe-up → tmux menu
//                 onSwitchWindow(dir)      horizontal swipe → prev/next window
//                 onReconnect()            touch-to-reconnect
//                 onExit()                 double-tap → back to terminal + kbd
//                 onTwoPullMove(pull, vh)  two-finger pull progress
//                 onTwoPullEnd(pull, vh)   two-finger pull release
//
// ── Synthetic scrolling (D6) ────────────────────────────────────────────
// The reader does not scroll natively — it renders into an inner box that
// synthetic-scroll.js translates, driven by the same gesture recogniser +
// physics engine that powers the terminal view. See that module for why.

import { tokenize } from "./term-tokenizer.js";
import { createGestureRecognizer } from "./touch.js";
import { createSyntheticScroller } from "./synthetic-scroll.js";
import {
  speak,
  stopSpeech,
  speechAvailable,
  refreshEngineState,
} from "./speech.js";
import * as prefs from "./prefs.js";

const RENDER_THROTTLE_MS = 50;

// Module-level "what is currently speaking" tracker.
//
// The render loop calls `_inner.replaceChildren(frag)` when the buffer
// changes, which obliterates the speaker icon DOM. The new icon node has no
// `rb-speaking` class even though the voice is still reading the same
// content. We keep the speaking key here (survives re-render), the matching
// speech-end callback clears it, and after every render we walk the freshly
// built icons and re-apply the class to whichever one matches.
//
// Key: the block kind, whether it was an expand request, and the verbatim
// text. Stable across re-renders as long as the underlying content hasn't
// changed, which is the only state we care about preserving.
let speakingKey = null;

// The strip that says why nothing is being read. A speaker that goes quiet
// without a word is indistinguishable from a broken one, so every failure
// lands here. Module-level for the same reason speakingKey is: one reader is
// mounted at a time, and the render loop rebuilds the icons under it.
let speechNotice = null;

export function createReader({ host, document: doc, handlers = {} } = {}) {
  let mounted = false;
  let inner = null;
  let statusBar = null;
  let oscHint = null;
  let scroller = null;

  let renderTimer = null;
  let changeSub = null;
  let oscSub = null;
  let gestures = null;
  const postRenderCallbacks = [];

  const onBufferChanged = () => scheduleRender();

  function scheduleRender() {
    if (!mounted) return;
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, RENDER_THROTTLE_MS);
  }

  function render() {
    if (!inner) return;
    const { lines, status } = doc.snapshot();

    scroller.contentChanged(() => {
      renderStatusBar(statusBar, status);

      const blocks = tokenize(lines);
      const frag = window.document.createDocumentFragment();
      for (const block of blocks) frag.appendChild(renderBlock(block));
      inner.replaceChildren(frag);
      // After replaceChildren the previous speaker icon (if any) is gone;
      // re-apply rb-speaking to whichever fresh icon matches the key the
      // synthesizer is currently reading.
      reapplySpeakingState(inner);
    });

    // Drain one-shot post-render callbacks (see awaitNextRender()). Snapshot
    // and clear first so callbacks registered during drain wait for the NEXT
    // render, not the current one.
    const cbs = postRenderCallbacks.splice(0);
    for (const cb of cbs) cb();
  }

  function buildOscHint() {
    const el = window.document.createElement("div");
    el.className = "reader-osc-hint";
    el.hidden = true;
    el.innerHTML =
      '<span>Reader uses heuristics. <a href="/settings#shell-integration">Set up OSC 133 →</a></span>' +
      '<button type="button" class="reader-osc-dismiss" aria-label="Dismiss">×</button>';
    el.querySelector(".reader-osc-dismiss").addEventListener("click", () => {
      prefs.set("osc133_hint_dismissed", true);
      el.hidden = true;
    });
    return el;
  }

  function buildSpeechNotice() {
    const el = window.document.createElement("div");
    el.className = "reader-speech-notice";
    el.hidden = true;
    el.setAttribute("role", "status");
    return el;
  }

  function refreshOscHint() {
    if (!oscHint) return;
    const dismissed = prefs.get("osc133_hint_dismissed") === true;
    oscHint.hidden = doc.oscDetected || dismissed;
  }

  function mountGestures() {
    if (gestures) return;
    gestures = createGestureRecognizer(
      host,
      {
        onReconnect: () => handlers.onReconnect?.(),
        onLongPress: () => handlers.onCommandMenu?.(),
        onSwipeUp: () => handlers.onCommandMenu?.(),
        onHSwipe: (dir) => handlers.onSwitchWindow?.(dir),
        onTap: () => {},
        // The reader has no cursor / no live editing affordance — a double-tap
        // to type drops back to the terminal first, then opens the keyboard so
        // the keystrokes have somewhere to land.
        onDoubleTap: () => handlers.onExit?.(),
        onScroll: (dy) => scrollBy(dy),
        onTwoPullMove: (pull, vh) => handlers.onTwoPullMove?.(pull, vh),
        onTwoPullEnd: (pull, vh) => handlers.onTwoPullEnd?.(pull, vh),
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

  function mount() {
    if (mounted) return;
    mounted = true;
    host.classList.remove("hidden");

    inner = window.document.createElement("div");
    inner.className = "reader-inner";
    statusBar = window.document.createElement("div");
    statusBar.className = "reader-statusbar";
    oscHint = buildOscHint();
    speechNotice = buildSpeechNotice();
    host.replaceChildren(inner, oscHint, speechNotice, statusBar);
    refreshOscHint();
    // The hint can also disappear after the first OSC 133 marker arrives
    // mid-session (e.g. the user just enabled shell integration and reloaded).
    oscSub = doc.onOscDetected(() => refreshOscHint());

    scroller = createSyntheticScroller({ host, inner, footerEl: statusBar });

    // The document's change subscription is the single source of truth for
    // "buffer changed" — history reload, WS data, and synthetic test injects
    // all flow through it.
    changeSub = doc.subscribe(onBufferChanged);

    mountGestures();
    render();

    // Whether this host has a voice of its own decides whether the speaker
    // icons are worth rendering at all; re-render once the answer lands.
    refreshEngineState().then(() => scheduleRender());
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    host.classList.add("hidden");

    unmountGestures();
    if (changeSub) {
      changeSub.dispose();
      changeSub = null;
    }
    if (oscSub) {
      oscSub.dispose();
      oscSub = null;
    }
    if (scroller) {
      scroller.dispose();
      scroller = null;
    }
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    stopAllSpeech();
    inner = null;
    statusBar = null;
    oscHint = null;
    speechNotice = null;
  }

  function dispose() {
    unmount();
  }

  return {
    mount,
    unmount,
    dispose,
    scrollBy,
    stickToBottom,
    forceRender: () => render(),
    awaitNextRender: () =>
      new Promise((resolve) => postRenderCallbacks.push(resolve)),
    forceScrollTop: () => scroller?.scrollToTop(),
    get mounted() {
      return mounted;
    },
    get scrollY() {
      return scroller ? scroller.scrollY : 0;
    },
    get maxScroll() {
      return scroller ? scroller.maxScroll : 0;
    },
    get innerHeight() {
      return scroller ? scroller.innerHeight : 0;
    },
    get atBottom() {
      return scroller ? scroller.atBottom : true;
    },
    statusBarOffsetHeight: () => (statusBar ? statusBar.offsetHeight : 0),
    statusBarFilled: () =>
      !!statusBar && statusBar.classList.contains("reader-statusbar--filled"),
  };
}

// ── Status bar (tmux's bottom row) ────────────────────────────────
// The document contract peels the last buffer row into a `status` field
// ({ runs } | null). It does not belong in the scrollable flow — render it
// into a dedicated bottom-pinned element.
function renderStatusBar(hostEl, status) {
  if (!hostEl) return;
  if (!status || !status.runs || status.runs.length === 0) {
    hostEl.replaceChildren();
    hostEl.classList.remove("reader-statusbar--filled");
    hostEl.style.background = "";
    return;
  }
  const runs = status.runs;
  const inner = window.document.createElement("div");
  inner.className = "reader-statusbar-inner";
  appendRuns(inner, runs);
  hostEl.replaceChildren(inner);
  hostEl.classList.add("reader-statusbar--filled");
  // Use the run with the dominant background as the strip background so the
  // bar reads as one continuous surface rather than chips.
  const bg = dominantBg(runs);
  hostEl.style.background = bg || "";
}

function dominantBg(runs) {
  const counts = new Map();
  for (const r of runs) {
    if (!r.attrs || !r.attrs.bg) continue;
    counts.set(
      r.attrs.bg,
      (counts.get(r.attrs.bg) || 0) + (r.text ? r.text.length : 0),
    );
  }
  let best = null;
  let bestCount = 0;
  for (const [bg, c] of counts)
    if (c > bestCount) {
      best = bg;
      bestCount = c;
    }
  return best;
}

// ── Block rendering ────────────────────────────────────────────────
function renderBlock(block) {
  switch (block.type) {
    case "blank":
      return makeEl("div", "rb rb-blank", "\u00A0");
    case "rule":
      return makeEl("hr", "rb rb-rule");
    case "header":
      return renderInlineBlock("rb rb-header", block.runs);
    case "prompt":
      return renderInlineBlock("rb rb-prompt", block.runs);
    case "command":
      return renderCommandBlock(block);
    case "text":
      return renderTextBlock(block);
    case "code":
      return renderCodeBlock(block);
    default:
      return makeEl("div", "rb", block.text || "");
  }
}

function renderInlineBlock(className, runs) {
  const el = window.document.createElement("div");
  el.className = className;
  appendRuns(el, runs);
  if (className === "rb rb-prompt") {
    addSpeakerIcon(el, "command", runs);
  }
  return el;
}

// A "command" block (issue #219) is the OSC 133 C..D span grouped with the
// prompt line that started it: the command line, its output, and a muted
// pass/fail chip once the exit code is known. `exitCode` is null while the
// command is still running (no D marker yet) — the block just omits the
// chip and grows on the next re-tokenize as more output streams in.
function renderCommandBlock(block) {
  const wrap = window.document.createElement("div");
  wrap.className = "rb rb-command";

  const cmdEl = window.document.createElement("div");
  cmdEl.className = "rb-command-line";
  appendRuns(cmdEl, block.runs);
  addSpeakerIcon(cmdEl, "command", block.runs);
  wrap.appendChild(cmdEl);

  if (block.lines.length > 0) {
    const outputEl = window.document.createElement("div");
    outputEl.className = "rb-command-output";
    appendLinesWithBubbles(outputEl, block.lines, "rb-line");
    addSpeakerIcons(outputEl, "output");
    wrap.appendChild(outputEl);
  }

  if (block.exitCode !== null) {
    const ok = block.exitCode === 0;
    const status = window.document.createElement("span");
    status.className = `rb-command-status ${ok ? "rb-status-ok" : "rb-status-fail"}`;
    status.textContent = ok ? "✓" : `✗ ${block.exitCode}`;
    status.title = `exit ${block.exitCode}`;
    wrap.appendChild(status);
  }

  return wrap;
}

function renderTextBlock(block) {
  const el = window.document.createElement("div");
  el.className = "rb rb-text";
  appendLinesWithBubbles(el, block.lines, "rb-line");
  addSpeakerIcons(el, "prose", block);
  return el;
}

// A code block gets two controls, because reading one aloud is almost never
// what the listener wanted: the speaker announces what it is and how long it
// is ("bash, twelve lines"), and the second button is the explicit request to
// hear the whole thing.
function renderCodeBlock(block) {
  const wrap = window.document.createElement("div");
  wrap.className = "rb rb-code";
  appendLinesWithBubbles(wrap, block.lines, "rb-codeline");

  const text = block.lines.map((l) => l.text).join("\n");
  const language = block.language || "";
  addSpeakerIcon(wrap, "code", text, { label: "Say what this code is", language });
  addSpeakerIcon(wrap, "code", text, {
    label: "Read the code in full",
    className: "rb-speaker rb-speaker-full",
    glyph: "⤢",
    expand: true,
    language,
  });
  return wrap;
}

function appendLinesWithBubbles(parent, lines, lineClass) {
  let i = 0;
  while (i < lines.length) {
    const bg = lines[i].bubbleBg;
    if (bg) {
      const bubble = window.document.createElement("div");
      bubble.className = "rb-bubble";
      bubble.style.background = bg;
      bubble.style.borderColor = `color-mix(in srgb, ${bg} 78%, white 22%)`;
      while (i < lines.length && lines[i].bubbleBg === bg) {
        const lineEl = window.document.createElement("div");
        lineEl.className = `${lineClass} rb-bubble-line`;
        appendRuns(lineEl, lines[i].runs, { skipBg: true });
        bubble.appendChild(lineEl);
        i++;
      }
      parent.appendChild(bubble);
      continue;
    }
    const lineEl = window.document.createElement("div");
    lineEl.className = lineClass;
    appendRuns(lineEl, lines[i].runs);
    parent.appendChild(lineEl);
    i++;
  }
}

function appendRuns(parent, runs, opts) {
  const skipBg = opts && opts.skipBg;
  if (!runs || runs.length === 0) {
    parent.appendChild(window.document.createTextNode("\u00A0"));
    return;
  }
  for (const run of runs) {
    if (!run.text) continue;
    const span = window.document.createElement("span");
    span.textContent = run.text;
    applyAttrs(span, run.attrs, skipBg);
    parent.appendChild(span);
  }
}

function applyAttrs(el, a, skipBg) {
  if (!a) return;
  if (a.fg) el.style.color = a.fg;
  if (a.bg && !skipBg) {
    el.style.background = a.bg;
    el.style.padding = "0 3px";
    el.style.borderRadius = "3px";
    el.style.border = `1px solid color-mix(in srgb, ${a.bg} 78%, white 22%)`;
    el.classList.add("rb-chip");
  }
  if (a.bold) el.style.fontWeight = "600";
  if (a.italic) el.style.fontStyle = "italic";
  if (a.underline) el.style.textDecoration = "underline";
  if (a.dim) el.style.opacity = "0.6";
  if (a.inverse && !skipBg) {
    const fg = el.style.color || "currentColor";
    const bg = el.style.background || "transparent";
    el.style.color = bg;
    el.style.background = fg;
  }
}

function makeEl(tag, className, text) {
  const el = window.document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// `kind` is the reader's own classification, and the server normalizes on it:
// "command" and "output" come from OSC 133 where shell integration is on, so
// the noisy-terminal rules run on output and never on prose.
function addSpeakerIcon(el, kind, content, options = {}) {
  if (!speechAvailable()) return;

  const text =
    typeof content === "string" ? content : extractTextFromRuns(content);
  const request = {
    text,
    kind,
    expand: !!options.expand,
    language: options.language || "",
  };

  const icon = window.document.createElement("button");
  icon.className = options.className || "rb-speaker";
  icon.type = "button";
  icon.setAttribute("aria-label", options.label || "Speak");
  icon.textContent = options.glyph || "▶";
  icon.dataset.kind = kind;
  icon.dataset.idle = icon.textContent;
  // Stable key for matching across re-renders (see speakingKey docs).
  icon.dataset.speechKey = speechKeyFor(request);

  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    handleSpeakerClick(icon, request);
  });

  el.appendChild(icon);
}

// Walk both naked `.rb-line` children and `.rb-bubble` descendants and drop a
// speaker icon on each — a single block can hold a mix when tokenization
// assigns bubble backgrounds to some lines but not others.
function addSpeakerIcons(el, kind) {
  if (!speechAvailable()) return;

  const bubbles = el.querySelectorAll(":scope > .rb-bubble");
  bubbles.forEach((bubble) => {
    const lines = bubble.querySelectorAll(".rb-bubble-line");
    if (lines.length === 0) return;
    const content = Array.from(lines)
      .map((l) => l.textContent)
      .join("\n");
    addSpeakerIcon(bubble, kind, content);
  });

  const nakedLines = el.querySelectorAll(":scope > .rb-line");
  if (nakedLines.length > 0) {
    const content = Array.from(nakedLines)
      .map((l) => l.textContent)
      .join("\n");
    // Attach to the block container itself so a single icon covers all
    // contiguous non-bubble lines in the block.
    addSpeakerIcon(el, kind, content);
  }
}

function speechKeyFor(request) {
  return `${request.kind}:${request.expand ? "full" : "brief"}::${request.text}`;
}

function handleSpeakerClick(icon, request) {
  const isSpeaking = icon.classList.contains("rb-speaking");

  stopAllSpeech();

  if (isSpeaking) return;

  const key = icon.dataset.speechKey || speechKeyFor(request);
  markSpeaking(icon);
  speakingKey = key;
  clearSpeechNotice();

  speak(request, {
    onEnd: () => {
      // Clear the original icon (whether still attached or not) and any
      // re-rendered icon currently wearing the class for the same key. Module
      // state goes last so we can't race a render mid-clear.
      if (icon.isConnected) markIdle(icon);
      window.document.querySelectorAll(".rb-speaker.rb-speaking").forEach((other) => {
        if (other.dataset.speechKey === key) markIdle(other);
      });
      if (speakingKey === key) speakingKey = null;
    },
    onError: (message) => showSpeechNotice(message),
  });
}

function markSpeaking(icon) {
  icon.classList.add("rb-speaking");
  icon.textContent = "■";
}

function markIdle(icon) {
  icon.classList.remove("rb-speaking");
  icon.textContent = icon.dataset.idle || "▶";
}

function showSpeechNotice(message) {
  if (!speechNotice) return;
  speechNotice.textContent = message;
  speechNotice.hidden = false;
}

function clearSpeechNotice() {
  if (!speechNotice) return;
  speechNotice.textContent = "";
  speechNotice.hidden = true;
}

function extractTextFromRuns(runs) {
  if (!runs) return "";
  if (Array.isArray(runs)) return runs.map((r) => r.text || "").join("");
  // Block objects expose `.lines` (array of { runs }) for text blocks.
  if (runs.lines && Array.isArray(runs.lines)) {
    return runs.lines
      .map((ln) => (ln.runs || []).map((r) => r.text || "").join(""))
      .join("\n");
  }
  return "";
}

function stopAllSpeech() {
  stopSpeech();
  speakingKey = null;
  window.document
    .querySelectorAll(".rb-speaker.rb-speaking")
    .forEach((icon) => markIdle(icon));
}

// After a re-render, the freshly-built icons have no rb-speaking class. Walk
// them, match against the stored speakingKey, and re-apply state.
function reapplySpeakingState(root) {
  if (!speakingKey || !root) return;
  const icons = root.querySelectorAll(".rb-speaker");
  for (const icon of icons) {
    if (icon.dataset.speechKey === speakingKey) {
      markSpeaking(icon);
      // We deliberately do NOT rebind the onEnd callback to this fresh icon.
      // The original onEnd closes over the original icon node; when it fires
      // it'll check `isConnected` (false for the detached one) and skip.
      // Speech-end clearing relies on speakingKey going null, so subsequent
      // renders won't re-apply.
      return;
    }
  }
}
