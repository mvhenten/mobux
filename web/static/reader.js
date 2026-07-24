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
//   createReader({ host, document, handlers, session }) → reader handle
//     host      the #reader element the reader owns.
//     document  the terminal document contract: { snapshot, subscribe,
//               onOscDetected, oscDetected }.
//     session   tmux session name — fetches server-side conversation history
//               (issue #220) from it for the chat view's past turns (issue
//               #221). Omitted ⇒ no fetch; renders from the live document
//               alone (used by synthetic-document tests).
//     handlers  cross-cutting callbacks the reader's gestures call up to the
//               owner (the terminal + the SPA view controller):
//                 onCommandMenu()          long-press / swipe-up → tmux menu
//                 onSwitchWindow(dir)      horizontal swipe → prev/next window
//                 onReconnect()            touch-to-reconnect
//                 onExit()                 double-tap → back to terminal + kbd
//                 onTwoPullMove(pull, vh)  two-finger pull progress
//                 onTwoPullEnd(pull, vh)   two-finger pull release
//
// ── Chat view (issue #221, #230) ────────────────────────────────────────
// Once at least one command has run through OSC 133 (C..D) grouping,
// render() switches from the plain top-to-bottom block list to a chat
// layout: each command is a turn, the typed command on the left, its
// output/exit status on the right — see buildTurns()/renderCommandBlock().
// Any command still present in the live terminal document (open, or
// completed but not yet scrolled out of the terminal's own bounded buffer)
// renders from that live document — the real terminal emulator's own
// attribution, not the server segmenter. Only turns that have scrolled out
// of the live buffer entirely fall back to the server's conversation-
// history endpoint (decoupled from tmux scrollback, survives reattach) —
// see buildTurns()'s own doc for the sourcing rule. Sessions that never
// produce a command grouping (no shell integration, or nothing typed yet)
// keep the original block-list rendering unchanged.
//
// ── Off the PTY hot path (issue #230) ───────────────────────────────────
// The chat view once measurably destabilized the terminal ENGINE's own OSC
// 133 marker classification under load (unrelated content occasionally
// misclassified as its own prompt row) — not from render() being slow in
// isolation (it wasn't), but from render()'s DOM-rebuild and its
// `recomputeBounds()` layout read running on the same setTimeout macrotask
// tier the PTY WS message intake and the renderer's own write-completion
// signalling share, and from forceRender() (the poll-driven test surface)
// repeating that full cost on every tick regardless of whether anything had
// changed. See scheduleRender()'s and render()'s own doc comments for the
// fix: the DOM write is scheduled on an animation frame instead of an
// arbitrary timer tick, the layout-forcing bounds read defers one frame
// further by default, and a `dirty` flag makes a redundant forceRender()
// call a no-op.
//
// ── Synthetic scrolling (D6) ────────────────────────────────────────────
// Native `overflow: auto` on the target mobile WebViews has failed repeatedly
// (engaged-only-after-fresh-touch on iOS Safari, locked state on Android
// Chrome with large scrollbacks). The reader renders into an inner box and
// translates it itself, driven by the same gesture recogniser + physics engine
// that powers the terminal view. `_scrollY` is positive-down in CSS pixels:
//   _scrollY = 0          → top of content visible
//   _scrollY = _maxScroll → bottom of content visible
// The inner box is translated by `translate3d(0, -_scrollY, 0)`. `scrollBy(dy)`
// adds `dy`, matching the terminal's convention so finger-DOWN reveals content
// above (dy < 0 from the recogniser), preserving muscle memory between views.

import { tokenize } from "./term-tokenizer.js";
import { createGestureRecognizer } from "./touch.js";
import { loadPrefs } from "./listen-prefs.js";
import * as prefs from "./prefs.js";
import { createChatHistory } from "./chat-history.js";

const SPEECH_AVAILABLE = "speechSynthesis" in window;

const RENDER_THROTTLE_MS = 50;
// How many chat turns render at once (issue #221) — the rest sit behind the
// "load older" affordance. All of a session's history is already resident in
// memory once `chatHistory.loadAll()` resolves (the server's cursor only
// pages forward, so there's no cheap way to fetch "just the last N" — see
// chat-history.js), so this is a DOM/render-cost window, not a network one:
// "load older" reveals more of what's already fetched instead of re-hitting
// the endpoint.
const CHAT_WINDOW_SIZE = 24;
// A scroll counts as "at the bottom" (and so keeps following live output) only
// when it reaches the very bottom edge. Streaming keeps the viewport exactly
// there via the re-pin in render(); an explicit scroll away — even a little —
// drops the follow so the reader holds position (R2). The epsilon only absorbs
// sub-pixel rounding, not a real scroll-up.
const BOTTOM_EPSILON_PX = 2;

// Module-level "what is currently speaking" tracker.
//
// The render loop calls `_inner.replaceChildren(frag)` when the buffer
// changes, which obliterates the speaker icon DOM. The new icon node has no
// `rb-speaking` class even though `speechSynthesis` is still reading the same
// content. We keep the speaking key here (survives re-render), the matching
// utterance-end callback clears it, and after every render we walk the freshly
// built icons and re-apply the class to whichever one matches.
//
// Key: the verbatim `text` passed to `speakText()`. Stable across re-renders
// as long as the underlying content hasn't changed, which is the only state we
// care about preserving.
let speakingKey = null;
let speakingOnEnd = null;

export function createReader({
  host,
  document: doc,
  handlers = {},
  session = null,
} = {}) {
  let mounted = false;
  let inner = null;
  let statusBar = null;
  let oscHint = null;

  // Server-side conversation history (issue #220/#221) — the source of
  // truth for everything already flushed. `null` when no session was given
  // (unit-style tests driving a synthetic document) or before the first
  // mount; the render path falls back to the live document alone in that
  // case, matching the reader's pre-#221 behaviour.
  let chatHistory = null;
  let visibleTurnCount = CHAT_WINDOW_SIZE;
  // The live tail command's text while it's still open (exitCode === null),
  // or null when nothing is open — see render()'s refreshTailOnceClosed().
  let openTailKey = null;

  // Set whenever something render() would need to reflect has actually
  // happened (a document mutation, freshly-loaded history) — cleared right
  // after render() rebuilds the DOM. forceRender() (the test-only API
  // spa.spec.cjs/reader-chat-history.spec.cjs poll in a tight loop to
  // observe newly-arrived WS data) checks this and no-ops when nothing is
  // pending, instead of unconditionally repeating the full snapshot-walk +
  // buildTurns + DOM-rebuild pipeline. Issue #230's real CPU-profile
  // capture, taken WHILE mimicking that poll loop, found forceRender()
  // alone accounted for the majority of main-thread busy time during an OSC
  // 133 burst — an unthrottled, uncoalesced repeat of render()'s full cost
  // on every poll tick, competing directly with the engine's own PTY
  // message processing for the same thread. scheduleRender() doesn't need
  // this gate — every caller that reaches it (onBufferChanged, a history
  // load/refresh landing) already corresponds to a real change, and its own
  // `renderTimer` already collapses a burst of those into one render.
  let dirty = true;

  let scrollY = 0;
  let maxScroll = 0;
  // True when the viewport is at the bottom edge (following live output).
  // Captured at the most recent scroll/render so the re-pin doesn't re-derive
  // it from the about-to-change maxScroll.
  let atBottom = true;

  let renderTimer = null;
  // Pending requestAnimationFrame handles for the two deferral points below
  // (scheduleRender's render-on-next-frame, render()'s deferBounds
  // settle-on-the-frame-after) — cancelled on unmount() so a rAF callback
  // scheduled by one mount cycle can never run against a DIFFERENT mount's
  // fresh `inner`/state after a fast unmount+remount (view toggle, or the
  // same-document remount terminal.js's dispose() does).
  let renderRafId = null;
  let boundsRafId = null;
  let changeSub = null;
  let oscSub = null;
  let resizeObserver = null;
  let gestures = null;
  const postRenderCallbacks = [];

  const onWindowResize = () => handleResize();
  const onBufferChanged = () => {
    dirty = true;
    scheduleRender();
  };

  // Pulls anything the server has recorded since the last fetch (see
  // chat-history.js's refreshTail) — called at most once per command, right
  // after render() observes the live tail command close (exitCode goes from
  // null to non-null). The live document already shows that command's exit
  // status and output instantly (buildTurns() renders it from the live
  // block regardless), so this isn't on the critical path for what's on
  // screen; it's what keeps history caught up so that once this command
  // eventually scrolls out of the live document's own bounded buffer,
  // it's already safely recorded to fall back to — and so a "load older"
  // reveal sees it. Deliberately not a poll/timer — nothing here needs the
  // network more often than "a command just finished".
  function refreshTailOnceClosed() {
    if (!chatHistory) return;
    chatHistory
      .refreshTail()
      .then(() => {
        dirty = true;
        if (mounted) scheduleRender();
      })
      .catch(() => {
        // Transient fetch failure — the live document keeps the reader
        // useful in the meantime; the next command's completion retries.
      });
  }

  function applyTransform() {
    if (!inner) return;
    inner.style.transform = `translate3d(0, ${-scrollY}px, 0)`;
  }

  function setScroll(y) {
    const clamped = Math.max(0, Math.min(maxScroll, y));
    atBottom = clamped >= maxScroll - BOTTOM_EPSILON_PX;
    if (clamped === scrollY) return;
    scrollY = clamped;
    applyTransform();
  }

  function recomputeBounds() {
    if (!inner) {
      maxScroll = 0;
      return;
    }
    const innerH = inner.scrollHeight;
    const statusH = statusBar ? statusBar.offsetHeight : 0;
    const hostH = host.clientHeight - statusH;
    maxScroll = Math.max(0, innerH - hostH);
  }

  function handleResize() {
    if (!mounted || !inner) return;
    // Host height changed (orientation, virtual keyboard, parent layout).
    // Re-measure and re-pin if we were at the bottom.
    recomputeBounds();
    if (atBottom) scrollY = maxScroll;
    else scrollY = Math.min(scrollY, maxScroll);
    applyTransform();
  }

  function scheduleRender() {
    if (!mounted) return;
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      // The DOM mutation itself runs on the next animation frame rather
      // than directly in this timer callback, and render() defers its own
      // layout-dependent bookkeeping one frame further (see render()'s
      // `deferBounds` doc comment) — issue #230's real CPU-profile capture
      // (not wall-clock deltas — those had already ruled out render()'s
      // own duration) found the reader's render() was the single largest
      // main-thread consumer during an OSC 133 burst, because it runs on
      // the SAME setTimeout macrotask tier the PTY WS message intake and
      // the renderer's own write-completion signalling share. A `setTimeout`
      // callback lands at an arbitrary point relative to that traffic; an
      // animation-frame callback runs at the point the browser has already
      // set aside for this frame's rendering work, off the critical path.
      renderRafId = requestAnimationFrame(() => {
        renderRafId = null;
        if (mounted) render({ deferBounds: true });
      });
    }, RENDER_THROTTLE_MS);
  }

  // Reveals the next window of already-fetched history (see
  // CHAT_WINDOW_SIZE's doc comment — this never hits the network, the data
  // is already resident) and compensates scroll so the turns the user was
  // already looking at don't jump. A user-triggered, one-shot click handler
  // — not the PTY hot path — so it opts back into the immediate
  // (non-deferred) bounds read render()'s `deferBounds` doc comment
  // describes: the delta math below needs `inner.scrollHeight` to reflect
  // the just-added turns right now, not one frame from now.
  function revealOlderTurns() {
    const prevHeight = inner ? inner.scrollHeight : 0;
    visibleTurnCount += CHAT_WINDOW_SIZE;
    render({ deferBounds: false });
    if (!inner) return;
    const delta = inner.scrollHeight - prevHeight;
    setScroll(scrollY + delta);
  }

  function renderLoadOlderButton(hiddenCount) {
    const btn = window.document.createElement("button");
    btn.type = "button";
    btn.className = "rb-chat-loadmore";
    btn.textContent = `Load ${hiddenCount} older turn${hiddenCount === 1 ? "" : "s"}…`;
    btn.addEventListener("click", () => revealOlderTurns());
    return btn;
  }

  // `deferBounds` (default true): see scheduleRender()'s doc comment.
  // `recomputeBounds()` reads `scrollHeight`/`clientHeight`/`offsetHeight` —
  // right after `replaceChildren()` below, that forces the browser to
  // synchronously recompute style+layout on the spot instead of doing it
  // lazily on its own schedule. Issue #230's real CPU-profile capture
  // (Chrome DevTools Protocol `Tracing.start`, not `performance.now()`
  // deltas around render() — those measure the JS bracket, not a
  // forced-reflow cost that lands on whichever call happens to trigger it)
  // found this forced reflow was the single largest self-time entry on the
  // main thread during an OSC 133 burst with the chat view active, ahead of
  // every OSC-attribution function itself — and NOT just from the
  // throttled scheduleRender() path: `forceRender()` (the test surface
  // `spa.spec.cjs` and `reader-chat-history.spec.cjs` poll on) calls
  // render() directly, and a real-tmux OSC test polls it in a tight loop
  // while commands are still streaming in over the WS, each call forcing
  // its own synchronous reflow squarely inside the burst window being
  // measured. Defer by default so every caller gets the frame-timed read
  // unless it explicitly opts out. The DOM content write above is never
  // deferred — only the layout-dependent bookkeeping after it — so a
  // caller reading `.textContent`/`.querySelectorAll(...)` synchronously
  // right after calling render() still sees this call's content.
  // revealOlderTurns() is the one caller that legitimately needs the
  // bounds read to happen NOW (its own prevHeight/newHeight scroll-
  // compensation math), so it opts out explicitly.
  function render({ deferBounds = true } = {}) {
    if (!inner) return;
    const { lines, status } = doc.snapshot();
    const wasAtBottom = atBottom;

    renderStatusBar(statusBar, status);

    const liveBlocks = tokenize(lines);
    const liveCommandBlocks = liveBlocks.filter((b) => b.type === "command");
    const trailingBlock = liveBlocks[liveBlocks.length - 1];

    // A command just closed (was the open tail last render, isn't open
    // anymore) — pull it into chatHistory.turns once. See
    // refreshTailOnceClosed's doc comment for why this, not a poll.
    const tailBlock = liveCommandBlocks[liveCommandBlocks.length - 1];
    const tailOpenNow = tailBlock && tailBlock.exitCode === null;
    if (openTailKey && (!tailOpenNow || tailBlock.text !== openTailKey)) {
      refreshTailOnceClosed();
    }
    openTailKey = tailOpenNow ? tailBlock.text : null;

    const historyTurns = chatHistory ? chatHistory.turns : [];
    // The chat layout (issue #221) only applies once there's at least one
    // OSC 133 C..D command grouping to show — either already flushed to
    // history or still open in the live buffer. Without it (no shell
    // integration, or nothing typed yet) the reader renders exactly as it
    // did before #221: the plain top-to-bottom block list.
    const hasChatContent =
      liveCommandBlocks.length > 0 ||
      historyTurns.some((t) => t.kind === "command");

    const frag = window.document.createDocumentFragment();

    if (!hasChatContent) {
      for (const block of liveBlocks) frag.appendChild(renderBlock(block));
    } else {
      const turns = buildTurns(historyTurns, liveCommandBlocks);
      const total = turns.length;
      const visible = Math.min(visibleTurnCount, total);
      const hiddenCount = total - visible;

      if (hiddenCount > 0) {
        frag.appendChild(renderLoadOlderButton(hiddenCount));
      }
      for (const turn of turns.slice(total - visible)) {
        frag.appendChild(
          turn.kind === "raw"
            ? renderTextBlock({ lines: linesFromPlainText(turn.text) })
            : renderCommandBlock(turn.block),
        );
      }
      // The still-open idle prompt (nothing typed yet) isn't a turn — keep
      // showing it exactly as before so the chat feed ends on "awaiting
      // input" the same way the plain reader always has.
      if (trailingBlock && trailingBlock.type === "prompt") {
        frag.appendChild(renderInlineBlock("rb rb-prompt", trailingBlock.runs));
      }
    }

    inner.replaceChildren(frag);
    // After replaceChildren the previous speaker icon (if any) is gone;
    // re-apply rb-speaking to whichever fresh icon matches the key the
    // synthesizer is currently reading.
    reapplySpeakingState(inner);
    // The content this render() call needed to reflect is now on screen —
    // see the `dirty` doc comment. Cleared here (synchronously, right after
    // the DOM rebuild) rather than in settleBounds() below: a caller polling
    // forceRender() again before the deferred bounds settle still correctly
    // sees nothing new to do.
    dirty = false;

    const settleBounds = () => {
      recomputeBounds();
      if (wasAtBottom) scrollY = maxScroll;
      else scrollY = Math.min(scrollY, maxScroll);
      applyTransform();

      // Drain one-shot post-render callbacks (see awaitNextRender()).
      // Snapshot and clear first so callbacks registered during drain wait
      // for the NEXT render, not this one.
      const cbs = postRenderCallbacks.splice(0);
      for (const cb of cbs) cb();
    };

    if (deferBounds) {
      boundsRafId = requestAnimationFrame(() => {
        boundsRafId = null;
        settleBounds();
      });
    } else {
      settleBounds();
    }
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
    setScroll(scrollY + dy);
  }

  function stickToBottom() {
    if (!mounted) return;
    atBottom = true;
    setScroll(maxScroll);
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
    host.replaceChildren(inner, oscHint, statusBar);
    refreshOscHint();
    // The hint can also disappear after the first OSC 133 marker arrives
    // mid-session (e.g. the user just enabled shell integration and reloaded).
    oscSub = doc.onOscDetected(() => refreshOscHint());

    scrollY = 0;
    maxScroll = 0;
    atBottom = true;
    visibleTurnCount = CHAT_WINDOW_SIZE;
    openTailKey = null;
    dirty = true;

    // Server-side history (issue #220) is the source of truth for the chat
    // view's past turns — see this file's module doc and buildTurns()
    // below. No session (unit-style tests with a synthetic document) ⇒ no
    // fetch; render() falls back to the live document alone.
    chatHistory = session ? createChatHistory({ session }) : null;
    if (chatHistory) {
      // Mount frequently lands mid-burst — swap-to-reader only waits for
      // the FIRST OSC marker (issue #230's review), so a run of several
      // quick commands is often still streaming in over the WS when this
      // fires. Kicking off the history fetch (and the response's JSON
      // parse + regex-based stripAnsi work) inline would compete with that
      // stream on the same client for CPU/network right when tmux's own
      // redraw-burst reordering is already the tightest — a self-inflicted
      // version of the timing sensitivity issue #230's review measured.
      // Yielding one tick first lets whatever's already in flight drain
      // before the fetch goes out; buildTurns() only ever gets to use this
      // once it's resolved either way.
      setTimeout(() => {
        if (!mounted) return;
        chatHistory
          .loadAll()
          .then(() => {
            dirty = true;
            if (mounted) scheduleRender();
          })
          .catch(() => {
            // Endpoint unreachable — the live document still renders
            // whatever's in the current buffer (see render()'s fallback).
          });
      }, 0);
    }

    // The document's change subscription is the single source of truth for
    // "buffer changed" — history reload, WS data, and synthetic test injects
    // all flow through it.
    changeSub = doc.subscribe(onBufferChanged);

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => handleResize());
      resizeObserver.observe(host);
    }
    window.addEventListener("resize", onWindowResize);

    mountGestures();
    render();
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
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    window.removeEventListener("resize", onWindowResize);
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (renderRafId !== null) {
      cancelAnimationFrame(renderRafId);
      renderRafId = null;
    }
    if (boundsRafId !== null) {
      cancelAnimationFrame(boundsRafId);
      boundsRafId = null;
    }
    chatHistory = null;
    inner = null;
    statusBar = null;
    oscHint = null;
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
    // See the `dirty` doc comment — a no-op when nothing has changed since
    // the last render, so a caller polling this in a loop (spa.spec.cjs,
    // reader-chat-history.spec.cjs) doesn't pay the full snapshot-walk +
    // buildTurns + DOM-rebuild cost on every tick, only when there's
    // actually something new to reflect.
    forceRender: () => {
      if (dirty) render();
    },
    awaitNextRender: () =>
      new Promise((resolve) => postRenderCallbacks.push(resolve)),
    forceScrollTop: () => {
      atBottom = false;
      scrollY = 0;
      applyTransform();
    },
    get mounted() {
      return mounted;
    },
    get scrollY() {
      return scrollY;
    },
    get maxScroll() {
      return maxScroll;
    },
    get innerHeight() {
      return inner ? inner.scrollHeight : 0;
    },
    get atBottom() {
      return atBottom;
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

// ── Chat turns (issue #221, #230) ────────────────────────────────────
// Reconciles server-fetched history with the live document into one
// ordered array `render()` slices for display. Both sources normalize to
// the same shape renderCommandBlock() already renders (a "block": { runs,
// lines, exitCode }) — a history turn's plain command/output strings
// become single-run/plain-line equivalents of what the live tokenizer
// already hands renderCommandBlock for a real terminal block, so one
// render path covers a rich (coloured, bubbled) live command and a
// plain-text historical one alike.
//
// Sourcing rule: any CLOSED command still present in the live document
// supersedes its history counterpart, rendering from the LIVE path never
// the server segmenter — regardless of whether it completed just now or
// several turns ago. session_history.rs's minimal byte-between-C-and-D
// cursor model can, under tmux's own redraw-burst timing, land a command's
// text empty (`""`), bled into the next entry, or lose its output entirely
// (issue #230's review); the live buffer is driven by a real terminal
// emulator parsing the same bytes and doesn't have that gap.
//
// Matching can't lean on a raw trailing-N-entries count: the live document
// and the fetched history are two independently-updated views of the same
// event stream (refreshTailOnceClosed() only pulls history forward on a
// detected open→closed edge, which a fast burst of commands can skip
// entirely — see that function's doc), so at any given render the live
// buffer can legitimately be a few commands BEHIND where history has
// already reached, or missing one it hasn't finished classifying yet
// (term-tokenizer.js only turns a C..D span into a "command" block once the
// D marker lands). Cutting history's last N entries by position would treat
// those in-sync (already-correct) rows as superseded and silently drop the
// ones actually behind — never acceptable, so this never removes a history
// entry it can't specifically justify.
//
// Each closed live block is matched to its own history entry by identity
// (command text + exit code, immutable once a command has finished — an
// exact match is unambiguous) and supersedes it in place. A live block with
// no match — its history counterpart hasn't landed yet, or is one of the
// corrupted/bled rows above and will never textually match — is spliced in
// right after the most recent match found so far (or at the very front if
// none yet), preserving chronological order without deleting anything: the
// worst case is a corrupted history row rendering ALONGSIDE the clean live
// one, never in place of it. Raw (non-command) history entries are never
// covered by the live document's command tokenizer, so they're untouched.
// A still-open command (no D marker yet) can never have a history
// counterpart, so it's always appended last.
function buildTurns(historyTurns, liveCommandBlocks) {
  if (historyTurns.length === 0) {
    // No history yet — session omitted (synthetic-document tests), brand
    // new, or still loading. Show everything currently in the live buffer
    // instead of going blank; this is also what makes a bare synthetic
    // snapshot with several OSC 133 commands render all of them, matching
    // the reader's pre-#221 behaviour.
    return liveCommandBlocks.map(normalizeLiveBlock);
  }
  if (liveCommandBlocks.length === 0) {
    // Nothing left in the live buffer (un-instrumented segment, or every
    // command has scrolled out of the terminal's own scrollback) — history
    // is the only source left.
    return historyTurns.map(normalizeHistoryTurn);
  }

  const turns = historyTurns.map(normalizeHistoryTurn);
  const tailBlock = liveCommandBlocks[liveCommandBlocks.length - 1];
  const tailOpen = tailBlock.exitCode === null;
  const closedLiveBlocks = tailOpen
    ? liveCommandBlocks.slice(0, -1)
    : liveCommandBlocks;

  // supersedes: historyTurns index -> the live block replacing it in place.
  // inserts: historyTurns index (or -1 for "before everything") -> live
  // blocks with no match, to splice in right after that index. Both built
  // in one forward pass — closed live blocks and history are both
  // chronological, so the search pointer only moves forward, which also
  // pairs a repeated identical command with its correct occurrence.
  const supersedes = new Map();
  const inserts = new Map();
  let searchFrom = 0;
  let lastAnchor = -1;
  for (const block of closedLiveBlocks) {
    let foundIdx = -1;
    for (let i = searchFrom; i < historyTurns.length; i++) {
      const t = historyTurns[i];
      // The live block's `text` is the whole prompt row (prompt + typed
      // command, e.g. "user@host:~$ echo two" — term-tokenizer.js never
      // strips the prompt off it); the server's `command` field is the same
      // row content it parsed off the live byte stream, so in real usage
      // it carries the prompt too and the two are byte-for-byte equal.
      // Exact equality deliberately, not a substring/suffix check: a
      // corrupted live block from the same class of tmux redraw-burst
      // bleeding this whole function exists to route AROUND (issue #230's
      // review) can easily contain an unrelated command's text as a
      // substring, which a loose match would misidentify as a match and
      // supersede the WRONG history entry with garbage — worse than
      // leaving both visible.
      if (
        t.kind === "command" &&
        t.exitCode === block.exitCode &&
        t.command.length > 0 &&
        block.text === t.command
      ) {
        foundIdx = i;
        break;
      }
    }
    if (foundIdx === -1) {
      if (!inserts.has(lastAnchor)) inserts.set(lastAnchor, []);
      inserts.get(lastAnchor).push(block);
      continue;
    }
    supersedes.set(foundIdx, block);
    searchFrom = foundIdx + 1;
    lastAnchor = foundIdx;
  }

  const merged = (inserts.get(-1) || []).map(normalizeLiveBlock);
  turns.forEach((turn, i) => {
    merged.push(
      supersedes.has(i) ? normalizeLiveBlock(supersedes.get(i)) : turn,
    );
    for (const block of inserts.get(i) || [])
      merged.push(normalizeLiveBlock(block));
  });
  if (tailOpen) merged.push(normalizeLiveBlock(tailBlock));
  return merged;
}

function normalizeHistoryTurn(turn) {
  if (turn.kind === "raw") return { kind: "raw", text: turn.text };
  return {
    kind: "command",
    block: {
      runs: turn.command ? [{ text: turn.command, attrs: {} }] : [],
      lines: linesFromPlainText(turn.output),
      exitCode: turn.exitCode,
    },
  };
}

function normalizeLiveBlock(block) {
  return {
    kind: "command",
    block: { runs: block.runs, lines: block.lines, exitCode: block.exitCode },
  };
}

// Splits a server-provided plain string (already ANSI-stripped by
// chat-history.js) into the same { runs, text, bubbleBg } line shape the
// live tokenizer produces, minus colour (history carries none) — so
// appendLinesWithBubbles/appendRuns render it identically either way. A
// blank line gets an empty runs array so appendRuns falls back to its own
// nbsp placeholder, matching how the live path renders a blank buffer row.
// Trailing blank lines from the output's own final newline are dropped, same
// as the terminal document trims a trailing blank buffer row.
function linesFromPlainText(text) {
  if (!text) return [];
  const raw = text.split("\n");
  while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((t) => ({
    runs: t.length ? [{ text: t, attrs: {} }] : [],
    text: t,
    bubbleBg: null,
  }));
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
    addSpeakerIcon(el, "prompt", runs);
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
  addSpeakerIcon(cmdEl, "prompt", block.runs);
  wrap.appendChild(cmdEl);

  if (block.lines.length > 0) {
    const outputEl = window.document.createElement("div");
    outputEl.className = "rb-command-output";
    appendLinesWithBubbles(outputEl, block.lines, "rb-line");
    addSpeakerIcons(outputEl, "text");
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
  addSpeakerIcons(el, "text", block);
  return el;
}

function renderCodeBlock(block) {
  const wrap = window.document.createElement("div");
  wrap.className = "rb rb-code";
  appendLinesWithBubbles(wrap, block.lines, "rb-codeline");
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

function addSpeakerIcon(el, kind, content) {
  if (!SPEECH_AVAILABLE) return;

  const icon = window.document.createElement("button");
  icon.className = "rb-speaker";
  icon.type = "button";
  icon.setAttribute("aria-label", "Speak");
  icon.textContent = "▶";
  icon.dataset.kind = kind;
  // Stable key for matching across re-renders (see speakingKey docs).
  const text =
    typeof content === "string" ? content : extractTextFromRuns(content);
  icon.dataset.speechKey = speechKeyFor(kind, text);

  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    handleSpeakerClick(icon, kind, text);
  });

  el.appendChild(icon);
}

// Walk both naked `.rb-line` children and `.rb-bubble` descendants and drop a
// speaker icon on each — a single block can hold a mix when tokenization
// assigns bubble backgrounds to some lines but not others.
function addSpeakerIcons(el, kind) {
  if (!SPEECH_AVAILABLE) return;

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

function speechKeyFor(kind, text) {
  return `${kind}::${text}`;
}

function handleSpeakerClick(icon, kind, text) {
  const isSpeaking = icon.classList.contains("rb-speaking");

  stopAllSpeech();

  if (isSpeaking) return;

  const key = icon.dataset.speechKey || speechKeyFor(kind, text);
  icon.classList.add("rb-speaking");
  icon.textContent = "■";

  let utteranceText = text;
  if (kind === "prompt") {
    utteranceText = "command: " + utteranceText;
  }

  const onEnd = () => {
    // Clear the original icon (whether still attached or not) and any
    // re-rendered icon currently wearing the class for the same key. Module
    // state goes last so we can't race a render mid-clear.
    if (icon.isConnected) {
      icon.classList.remove("rb-speaking");
      icon.textContent = "▶";
    }
    window.document
      .querySelectorAll(`.rb-speaker.rb-speaking`)
      .forEach((other) => {
        if (other.dataset.speechKey === key) {
          other.classList.remove("rb-speaking");
          other.textContent = "▶";
        }
      });
    if (speakingOnEnd === onEnd) {
      speakingKey = null;
      speakingOnEnd = null;
    }
  };

  speakingKey = key;
  speakingOnEnd = onEnd;

  speakText(utteranceText, onEnd);
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
  window.speechSynthesis.cancel();
  speakingKey = null;
  speakingOnEnd = null;
  window.document
    .querySelectorAll(".rb-speaker.rb-speaking")
    .forEach((icon) => {
      icon.classList.remove("rb-speaking");
      icon.textContent = "▶";
    });
}

// After a re-render, the freshly-built icons have no rb-speaking class. Walk
// them, match against the stored speakingKey, and re-apply state.
function reapplySpeakingState(root) {
  if (!speakingKey || !root) return;
  const icons = root.querySelectorAll(".rb-speaker");
  for (const icon of icons) {
    if (icon.dataset.speechKey === speakingKey) {
      icon.classList.add("rb-speaking");
      icon.textContent = "■";
      // We deliberately do NOT rebind the onEnd callback to this fresh icon.
      // The original onEnd closes over the original icon node; when it fires
      // it'll check `isConnected` (false for the detached one) and skip.
      // Speech-end clearing relies on speakingKey going null, so subsequent
      // renders won't re-apply.
      return;
    }
  }
}

function splitIntoSentences(text) {
  const chunks = text.split(/([.!?])\s+/);
  const sentences = [];
  for (let i = 0; i < chunks.length; i += 2) {
    const base = chunks[i];
    const punct = chunks[i + 1] || "";
    if (base.trim()) sentences.push(base + punct);
  }
  return sentences.length > 0 ? sentences : [text];
}

function speakText(text, onEnd) {
  const listenPrefs = loadPrefs();
  const sentences = splitIntoSentences(text.trim());
  let index = 0;

  function speakNext() {
    if (index >= sentences.length) {
      if (onEnd) onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(sentences[index]);
    utterance.rate = listenPrefs.rate;
    utterance.pitch = listenPrefs.pitch;

    if (listenPrefs.voice) {
      const voices = window.speechSynthesis.getVoices();
      const selected = voices.find((v) => v.name === listenPrefs.voice);
      if (selected) utterance.voice = selected;
    }

    utterance.onend = () => {
      index++;
      speakNext();
    };

    utterance.onerror = () => {
      if (onEnd) onEnd();
    };

    window.speechSynthesis.speak(utterance);
  }

  speakNext();
}
