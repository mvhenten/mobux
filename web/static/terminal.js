import { TerminalCore } from "./terminal-core.js";
import { ReaderView } from "./reader-view.js";
import { createGestureRecognizer } from "./touch.js";
import { createInputBar } from "./input-bar.js";
import { createTopBar } from "./top-bar.js";
import { applyTheme, getStoredThemeId } from "./themes.js";
import { navigateToUrl, openExternal } from "./external-link.js";
import * as prefs from "./prefs.js";

// ── Loading screen quotes ───────────────────────────────────────────
const quotes = [
  ["Simplicity is prerequisite for reliability.", "Edsger W. Dijkstra"],
  [
    "If debugging is the process of removing bugs, then programming must be the process of putting them in.",
    "Edsger W. Dijkstra",
  ],
  [
    "The Analytical Engine weaves algebraical patterns just as the Jacquard loom weaves flowers and leaves.",
    "Ada Lovelace",
  ],
  [
    "We can only see a short distance ahead, but we can see plenty there that needs to be done.",
    "Alan Turing",
  ],
  ["Those who can imagine anything, can create the impossible.", "Alan Turing"],
  [
    "The most dangerous phrase in the language is: we’ve always done it this way.",
    "Grace Hopper",
  ],
  ["The best way to predict the future is to invent it.", "Alan Kay"],
  ["Premature optimization is the root of all evil.", "Donald Knuth"],
  ["Talk is cheap. Show me the code.", "Linus Torvalds"],
  [
    "Controlling complexity is the essence of computer programming.",
    "Brian Kernighan",
  ],
  [
    "Any sufficiently advanced technology is indistinguishable from magic.",
    "Arthur C. Clarke",
  ],
  ["Information is the resolution of uncertainty.", "Claude Shannon"],
  [
    "Looking back, we were the luckiest people in the world; there was no choice but to be pioneers.",
    "Margaret Hamilton",
  ],

  // Contemporary craft
  [
    "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.",
    "Martin Fowler",
  ],
  ["Truth can only be found in one place: the code.", "Robert C. Martin"],
  [
    "I'm not a great programmer; I'm just a good programmer with great habits.",
    "Kent Beck",
  ],
  ["Duplication is far cheaper than the wrong abstraction.", "Sandi Metz"],
  ["It's harder to read code than to write it.", "Joel Spolsky"],
  ["I call it my billion-dollar mistake.", "Tony Hoare, on null"],
  [
    "Programmers know the value of everything and the cost of nothing.",
    "Rich Hickey",
  ],
  [
    "Fancy algorithms are slow when n is small, and n is usually small.",
    "Rob Pike",
  ],
  [
    "There are only two kinds of programming languages: the ones people complain about and the ones nobody uses.",
    "Bjarne Stroustrup",
  ],
  ["Ruby is designed to make programmers happy.", "Yukihiro Matsumoto"],
  [
    "The three chief virtues of a programmer are: laziness, impatience, and hubris.",
    "Larry Wall",
  ],
  [
    "If you're not failing every now and again, it's a sign you're not doing anything very innovative.",
    "John Carmack",
  ],
];

// ── Terminal engine factory ─────────────────────────────────────────
//
// createTerminal({ node, session, host, renderer }) → { core, dispose() }
//
//   session   tmux session name to attach to.
//   node      remote node name (#176) — every PTY/tmux call carries
//             ?node=<name> so the hub proxies it over SSH. "" ⇒ local.
//   host      element containing the terminal scaffold (#terminal, #reader,
//             #touchOverlay, #loadquote, #cmdPickList, #inputBar, …). The
//             engine binds all its DOM inside this subtree.
//   renderer  'xterm' (default) | 'sterk'; the matching vendor bundle must
//             already be loaded (window.Terminal / window.Sterk).
//
// The engine used to be a self-booting module: it read window.MOBUX_* at
// eval time, so a second (node, session) in the same document silently kept
// the FIRST target — the "session not found"/wrong-tmux bug class (#185,
// #188). Config now arrives as arguments and every side effect the engine
// attaches (WebSocket, renderer instance, window/document/visualViewport
// listeners, timers, observers) is registered for teardown, so dispose() +
// createTerminal() is a real remount.
export function createTerminal({ node = "", session, host, renderer } = {}) {
  const $ = (id) => host.querySelector(`#${id}`);

  const nodeQuery = () => (node ? `?node=${encodeURIComponent(node)}` : "");

  const termEl = $("terminal");
  const readerEl = $("reader");
  const overlay = $("touchOverlay");
  const loadquote = $("loadquote");
  const paneIndicator = $("paneIndicator");
  const cmdPickList = $("cmdPickList");
  const cmdOverlayBg = $("cmdOverlayBg");
  const cmdCloseBtn = $("cmdCloseBtn");

  // Every teardown is registered here; dispose() drains it. `on`/`later`/
  // `every` are the tracked variants of addEventListener/setTimeout/
  // setInterval.
  let disposed = false;
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  // Both no-op after dispose: a straggler event (an in-flight WS message, a
  // resolving fetch) must not create new timers — `cleanups` has already
  // been drained, so anything registered now would never be torn down.
  const later = (fn, ms) => {
    if (disposed) return;
    const t = setTimeout(() => {
      if (!disposed) fn();
    }, ms);
    cleanups.push(() => clearTimeout(t));
  };
  const every = (fn, ms) => {
    if (disposed) return;
    const t = setInterval(fn, ms);
    cleanups.push(() => clearInterval(t));
  };

  {
    const [text, author] = quotes[Math.floor(Math.random() * quotes.length)];
    const quoteEl = $("quote");
    const qauthorEl = $("qauthor");
    if (quoteEl) quoteEl.textContent = text;
    if (qauthorEl) qauthorEl.textContent = "— " + author;
  }

  // ── External links ──────────────────────────────────────────────────
  // navigateToUrl/openExternal live in external-link.js (shared with
  // mic-overlay.js's fault "Report issue" link) — see that file for the TWA
  // intent:// rationale. Expose for tests (mirrors `window.__mobuxView` etc.).
  window.__mobuxNavigateToUrl = navigateToUrl;
  window.__mobuxOpenExternal = openExternal;

  // ── Core ────────────────────────────────────────────────────────────
  // `coarse` pointer = touch primary (phones + tablets). Width fallback
  // catches devices that misreport pointer capability. Desktops with a
  // mouse stay `false` and skip the on-screen input bar.
  const isMobile =
    window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 620;
  const core = new TerminalCore({ session, node, host: termEl, renderer });

  // Apply the stored theme to all three layers. terminal-core.js already
  // picked the matching palette + Ace theme at construction; this call
  // pushes the --ansi-* vars onto #reader for tokenized reader output.
  // Only the sterk backend has an Ace editor under the hood; xterm has none.
  const getEditor = () => core.term?._sterk?.renderer?.getEditor?.();
  applyTheme(getStoredThemeId(), { editor: getEditor() });

  // Live swap when the settings picker changes the theme in this document.
  // The picker dispatches `mobux:theme`; prefs.js dispatches `mobux:prefschange`
  // for every preference write, so honour a theme change from either.
  function onThemeChange() {
    applyTheme(getStoredThemeId(), { editor: getEditor() });
  }
  on(window, "mobux:theme", onThemeChange);
  on(window, "mobux:prefschange", (e) => {
    if (e.detail?.key === "theme") onThemeChange();
  });

  // Enable overlay for touch devices
  if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
    overlay.style.pointerEvents = "auto";
  }

  // ── Pane indicator ──────────────────────────────────────────────────
  function updatePaneUI() {
    const { panes, activeIndex } = core;
    if (panes.length <= 1) {
      paneIndicator.textContent = panes.length === 1 ? panes[0].title : "";
    } else {
      const current = panes[activeIndex];
      paneIndicator.textContent = `${current ? current.title : "?"} (${activeIndex + 1}/${panes.length})`;
    }
  }
  on(core, "panes", () => {
    if (disposed) return;
    updatePaneUI();
    pruneViewPrefs();
    applyStoredViewForActiveWindow();
  });

  // ── Command pick list ───────────────────────────────────────────────
  function showCmdList() {
    cmdPickList.classList.add("visible");
    cmdOverlayBg.classList.add("visible");
    overlay.style.pointerEvents = "none";
  }

  function hideCmdList() {
    cmdPickList.classList.remove("visible");
    cmdOverlayBg.classList.remove("visible");
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
      overlay.style.pointerEvents = "auto";
    }
  }

  on(cmdPickList, "click", (e) => {
    const cmdItem = e.target.closest("[data-cmd]");
    if (cmdItem) {
      core.runTmuxCmd(cmdItem.dataset.cmd);
      hideCmdList();
      return;
    }
  });
  on(cmdCloseBtn, "click", hideCmdList);
  on(cmdOverlayBg, "click", hideCmdList);

  // ── Touch gestures ──────────────────────────────────────────────────
  function scrollByPixels(dy) {
    const lines = Math.round(dy / core.cellSize().height);
    if (lines !== 0) core.scrollLines(lines);
  }

  const gestures = createGestureRecognizer(overlay, {
    onScroll: scrollByPixels,
    onReconnect: () => core.reconnect(),
    getFontSize: () => core.getFontSize(),

    onPinch(scale, startSize) {
      const newSize = Math.round(Math.max(8, Math.min(32, startSize * scale)));
      core.setFontSize(newSize);
    },

    onTwoPullMove(pull, vh) {
      if (pull > vh * 0.08) paneIndicator.textContent = "↻ Release to reload";
      else if (pull > vh * 0.03)
        paneIndicator.textContent = "↓ Pull to reload...";
    },

    onTwoPullEnd(pull, vh) {
      if (pull > vh * 0.08) location.reload(true);
      else updatePaneUI();
    },

    onTap(x, y) {
      // Detect URLs in terminal text at tap position and open them.
      // WebLinksAddon uses hover-based links which don't work on mobile,
      // so we read the buffer text directly.
      const cell = core.cellSize();
      const rect = termEl.getBoundingClientRect();
      const col = Math.floor((x - rect.left) / cell.width);
      const row = Math.floor((y - rect.top) / cell.height);
      const buffer = core.getActiveBuffer();
      const bufferRow = buffer.viewportY + row;
      const line = buffer.getLine(bufferRow);
      if (!line) return;
      const text = line.translateToString(true);
      const urlRe = /https?:\/\/[^\s)"'>]+/g;
      let match;
      while ((match = urlRe.exec(text)) !== null) {
        if (col >= match.index && col < match.index + match[0].length) {
          openExternal(match[0]);
          return;
        }
      }
    },

    onDoubleTap() {
      // This handler is wired on the touch overlay, so a double-tap here always
      // comes from a touch device — exactly the case that wants the on-screen
      // input bar. Lazily create it on first activation so a device that loaded
      // as non-mobile (or just rotated into touch mode) still gets the bar
      // instead of being stuck with no keyboard affordance.
      ensureInputBar().show();
    },

    onHSwipe: (dir) => core.switchWindow(dir),

    onLongPress: showCmdList,
    onSwipeUp: showCmdList,
  });

  // ReaderView uses fully synthetic scroll: native overflow scrolling
  // on mobile WebViews has been unreliable (engaged-only-after-fresh-touch
  // on iOS, locked-state on Android with large scrollbacks). We feed the
  // gesture recogniser's onScroll/fling output straight into reader's
  // translateY transform.
  let readerGestures = null;
  function mountReaderGestures() {
    if (readerGestures) return;
    readerGestures = createGestureRecognizer(
      readerEl,
      {
        onReconnect: () => core.reconnect(),
        onLongPress: showCmdList,
        onSwipeUp: showCmdList,
        onHSwipe: (dir) => core.switchWindow(dir),
        onTap: () => {},
        // Double-tap in reader mode is for typing, but the reader has no
        // cursor / no live editing affordance — opening the keyboard
        // there is confusing. Drop back to xterm first, then show the
        // input bar so the keystrokes have somewhere to land.
        onDoubleTap: () => {
          swapView("xterm");
          ensureInputBar().show();
        },
        onScroll: (dy) => reader.scrollBy(dy),
        onTwoPullMove(pull, vh) {
          if (pull > vh * 0.08)
            paneIndicator.textContent = "↻ Release to reload";
          else if (pull > vh * 0.03)
            paneIndicator.textContent = "↓ Pull to reload...";
        },
        onTwoPullEnd(pull, vh) {
          if (pull > vh * 0.08) location.reload(true);
          else updatePaneUI();
        },
      },
      { passiveScroll: false },
    );
  }
  function unmountReaderGestures() {
    if (!readerGestures) return;
    readerGestures.destroy();
    readerGestures = null;
  }

  // ── Reveal on first output ──────────────────────────────────────────
  // Fire on the first `data` event, not on settle. The previous
  // implementation reset an 800 ms timer per event, which never
  // settled when the attached session pumped continuous output (e.g.
  // a TUI like Claude Code), leaving the loading splash up forever.
  //
  // The mobile input bar (ribbon) does NOT share this trigger (#201). #198
  // made splash dismissal reveal the ribbon too, but that left it popping up
  // the instant an attached session produced any output and then sitting
  // pinned at the bottom of an already-familiar session for the rest of the
  // read — the same "showed once, now permanently in the way" problem #198
  // was trying to avoid, just moved earlier. Splash dismissal is not an
  // input event; the ribbon stays hidden through it and only reveals on
  // actual engagement (tap-to-focus — see the `onDoubleTap` handlers below
  // and in reader-view's gesture wiring), same as it already hides on
  // keyboard dismissal (input-bar.js's visualViewport handler).
  let revealScheduled = false;
  function scheduleReveal() {
    if (disposed || revealScheduled) return;
    if (!loadquote || !loadquote.parentNode) return;
    revealScheduled = true;
    later(() => {
      core.scrollToBottom();
      loadquote.style.opacity = "0";
      later(() => {
        if (loadquote.parentNode) loadquote.remove();
      }, 300);
    }, 200);
  }
  on(core, "data", scheduleReveal);

  // A quiet session (already sitting at its prompt) never fires `data`, so
  // the splash would otherwise stick forever. Back it up with a timeout that
  // starts once a connection actually opens — a chatty session still reveals
  // on its first `data` event well before this fires; this only catches the
  // silent case. `scheduleReveal` is idempotent, so racing with the data path
  // is harmless.
  const REVEAL_FALLBACK_MS = 1500;
  on(core, "open", () => {
    later(scheduleReveal, REVEAL_FALLBACK_MS);
  });

  // ── Mobile input bar ────────────────────────────────────────────────
  // `isMobile` is a one-shot guess at mount time. It can be wrong: a device
  // may mount as non-mobile and later become touch-primary (rotation, an
  // attached/detached input device, a misreported initial pointer query). So
  // we don't gate creation on it — we create the bar lazily on first use
  // (double-tap / activate), and also (re)evaluate when the pointer modality
  // changes. Either path funnels through `ensureInputBar()`, which is
  // idempotent.
  let inputBar = null;
  function ensureInputBar() {
    if (!inputBar) {
      inputBar = createInputBar(core.term, (d) => core.send(d));
    }
    return inputBar;
  }

  // If we already look like a touch device, mount eagerly so the mic button
  // (and the full control-key ribbon) exist and are wired from the start —
  // but stay hidden. The bar only reveals on engagement: the `onDoubleTap`
  // handlers below (xterm overlay, reader-view) call `ensureInputBar().show()`,
  // which is the only path that unhides it (#201). Mounting without revealing
  // keeps `ensureInputBar()` idempotent and the mic button wired the moment a
  // tap asks for it, without popping the bar — or the soft keyboard — on load.
  if (isMobile) {
    ensureInputBar();
  }

  // Re-evaluate when the primary pointer flips to coarse (e.g. a 2-in-1
  // switching to tablet mode). matchMedia change fires on modality changes;
  // once coarse, make sure the bar exists.
  try {
    const coarse = window.matchMedia("(pointer: coarse)");
    const onPointerChange = (e) => {
      if (e.matches) ensureInputBar();
    };
    if (coarse.addEventListener) {
      on(coarse, "change", onPointerChange);
    } else if (coarse.addListener) {
      coarse.addListener(onPointerChange);
      cleanups.push(() => coarse.removeListener(onPointerChange));
    }
  } catch (_) {
    /* matchMedia unsupported: lazy creation on tap still covers us */
  }

  // ── View swap (xterm <-> reader) ────────────────────────────────────
  const reader = new ReaderView({ host: readerEl, core, overlay });
  let currentView = "xterm";

  // The default view is a server-held preference (prefs.js `default_view`).
  // The per-window override — which view a specific tmux window was last left
  // in — stays device-transient in localStorage: it's keyed on the volatile
  // tmux window id, pruned when the window dies, and is mid-session tab state,
  // not a durable preference.
  const viewPrefKey = (windowId) => `mobux.view.${session}.${windowId}`;

  function activeWindowId() {
    const p = core.panes[core.activeIndex];
    return p?.id || null;
  }

  function storedDefaultView() {
    return prefs.get("default_view") === "reader" ? "reader" : "xterm";
  }

  function storedViewFor(windowId) {
    if (!windowId) return null;
    try {
      return localStorage.getItem(viewPrefKey(windowId));
    } catch (_) {
      return null;
    }
  }

  function updateToggleLabel() {
    const btn = $("viewToggleBtn");
    if (!btn) return;
    if (currentView === "reader") {
      btn.textContent = "▣";
      btn.title = "Switch to terminal view";
    } else {
      btn.textContent = "📖";
      btn.title = "Switch to reader view";
    }
  }

  function applyView(mode, { persist = true } = {}) {
    if (mode !== "xterm" && mode !== "reader") return;
    if (mode === currentView) {
      updateToggleLabel();
      return;
    }
    if (mode === "reader") {
      termEl.classList.add("hidden");
      // Reader has its own gesture recogniser on #reader. Disable the
      // xterm overlay so it doesn't sit on top and eat every touch.
      overlay.style.pointerEvents = "none";
      reader.mount();
      mountReaderGestures();
    } else {
      unmountReaderGestures();
      reader.unmount();
      termEl.classList.remove("hidden");
      if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
        overlay.style.pointerEvents = "auto";
      }
      later(() => core.resize(), 0);
    }
    currentView = mode;
    if (persist) {
      prefs.set("default_view", mode);
      try {
        const wid = activeWindowId();
        if (wid) localStorage.setItem(viewPrefKey(wid), mode);
      } catch (_) {}
    }
    updateToggleLabel();
    window.dispatchEvent(new CustomEvent("mobux:viewchange", { detail: mode }));
  }

  function swapView(mode) {
    applyView(mode, { persist: true });
  }

  // Ribbon view-toggle button (mobile input bar).
  const viewToggleBtn = $("viewToggleBtn");
  if (viewToggleBtn) {
    on(viewToggleBtn, "mousedown", (e) => e.preventDefault());
    on(viewToggleBtn, "click", (e) => {
      e.preventDefault();
      swapView(currentView === "xterm" ? "reader" : "xterm");
    });
  }

  // ── Desktop top bar ─────────────────────────────────────────────────
  // On a non-touch browser xterm.js owns the keyboard, so attach / dictate /
  // reader-toggle have no shortcut. Mount a slim top bar with those three as
  // the desktop counterpart to the mobile input bar. Mirror the isMobile gate
  // so the two surfaces are mutually exclusive, and (re)evaluate cheaply when
  // the pointer modality flips to coarse (a 2-in-1 going tablet → drop it).
  let topBar = null;
  function ensureTopBar() {
    if (topBar || isMobile) return;
    topBar = createTopBar({
      send: (d) => core.send(d),
      toggleReader: () =>
        swapView(currentView === "xterm" ? "reader" : "xterm"),
      isReader: () => currentView === "reader",
    });
  }
  if (!isMobile) ensureTopBar();
  try {
    const coarse = window.matchMedia("(pointer: coarse)");
    const onCoarse = (e) => {
      if (e.matches && topBar) {
        topBar.destroy();
        topBar = null;
      }
    };
    if (coarse.addEventListener) {
      on(coarse, "change", onCoarse);
    } else if (coarse.addListener) {
      coarse.addListener(onCoarse);
      cleanups.push(() => coarse.removeListener(onCoarse));
    }
  } catch (_) {
    /* matchMedia unsupported: static gate still covers us */
  }

  function applyStoredViewForActiveWindow() {
    const wid = activeWindowId();
    const stored = storedViewFor(wid);
    const mode = stored || storedDefaultView();
    applyView(mode, { persist: false });
  }

  function pruneViewPrefs() {
    const live = new Set(core.panes.map((p) => p.id).filter(Boolean));
    const prefix = `mobux.view.${session}.`;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix) && !live.has(k.slice(prefix.length))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}
  }

  const viewApi = {
    swap: swapView,
    get current() {
      return currentView;
    },
    send: (d) => core.send(d),
    test: {
      // Test injections close the WS first so tmux can't race/clobber
      // the injected content (e.g. by re-asserting alt-screen mode).
      inject: (str) => {
        // Mark the close intentional so auto-reconnect doesn't reopen the
        // WS and let tmux clobber the injected content.
        core.intentionalClose = true;
        try {
          core.ws?.close();
        } catch (_) {}
        return new Promise((resolve) =>
          core.term.write("\x1b[?1049l" + str.replace(/\n/g, "\r\n"), resolve),
        );
      },
      injectLines: (n, prefix = "inject") => {
        core.intentionalClose = true;
        try {
          core.ws?.close();
        } catch (_) {}
        let s = "\x1b[?1049l";
        for (let i = 0; i < n; i++) s += `${prefix} ${i}\r\n`;
        return new Promise((resolve) => core.term.write(s, resolve));
      },
      // Like injectLines but WITHOUT the \x1b[?1049l (alt-screen exit)
      // prefix. Use this in tests that care about sticky-to-bottom
      // behaviour after incremental content growth: the alt-screen exit
      // sequence causes sterk to reset the buffer, which races with the
      // test's scroll-geometry probe.
      injectLinesPlain: (n, prefix = "inject") => {
        try {
          core.ws?.close();
        } catch (_) {}
        let s = "";
        for (let i = 0; i < n; i++) s += `${prefix} ${i}\r\n`;
        return new Promise((resolve) => core.term.write(s, resolve));
      },
      // Returns a Promise that resolves after the reader's next _render()
      // call has committed updated scroll geometry (maxScroll, scrollY).
      // Safe to call from page.evaluate() — Playwright serialises the
      // resolved value via structured-clone, so callers should not await
      // a non-serialisable payload.
      readerAwaitRender: () => reader.awaitNextRender(),
      bufferLength: () => core.getActiveBuffer().length,
      isAlternate: () => {
        // sterk: compare alternate vs active buffer references
        if (core.term?._sterk?.buffer) {
          return (
            core.term._sterk.buffer.alternate === core.term._sterk.buffer.active
          );
        }
        // xterm: the BufferNamespace exposes `active.type` ('normal' | 'alternate')
        const t = core.term?.buffer?.active?.type;
        return t === "alternate";
      },
      readerAtBottom: () => reader._atBottom,
      readerForceScrollTop: () => {
        reader._atBottom = false;
        reader._scrollY = 0;
        reader._applyTransform?.();
      },
      terminalRows: () => core.term.rows,
      cols: () => core.term.cols,
      rows: () => core.term.rows,
      viewportY: () => core.getActiveBuffer().viewportY,
      scrollToBottom: () => core.scrollToBottom(),
      wsReady: () => core.ws?.readyState === WebSocket.OPEN,
      // Simulate an *unexpected* server-side drop: close the socket
      // WITHOUT marking the close intentional, so the core's onclose
      // backoff fires exactly as it would for a real network/server blip.
      // Used by the auto-reconnect test.
      forceDrop: () => {
        core.intentionalClose = false;
        try {
          core.ws?.close();
        } catch (_) {}
      },
      oscDetected: () => !!core.oscDetected,
      readerScrollY: () => reader.scrollY,
      readerMaxScroll: () => reader.maxScroll,
      readerInnerHeight: () => reader.innerHeight,
      readerScrollBy: (dy) => reader.scrollBy(dy),
      readerStickToBottom: () => reader.stickToBottom(),
      // Force a synchronous re-render. Used by tests that need to assert
      // post-render invariants (e.g. that rb-speaking re-applies after
      // _inner.replaceChildren wipes the icon DOM) without racing the
      // 50ms render throttle.
      readerForceRender: () => reader._render(),
      switchWindow: (dir) => core.switchWindow(dir),
      statusBarOffsetHeight: () =>
        document.querySelector(".reader-statusbar")?.offsetHeight ?? 0,
      statusBarFilled: () =>
        document
          .querySelector(".reader-statusbar")
          ?.classList.contains("reader-statusbar--filled") ?? false,
    },
  };
  window.__mobuxView = viewApi;

  // Apply stored default at boot so the user lands in their preferred
  // view even before the first /panes refresh resolves. Per-window
  // override (if any) is applied later in the panes listener.
  const bootDefault = storedDefaultView();
  if (bootDefault === "reader") {
    later(() => applyView("reader", { persist: false }), 0);
  }

  updateToggleLabel();

  // ── Notification deep-link ─────────────────────────────────────────
  // A push notification's URL embeds ?w={window_index} for the tmux
  // window that fired the alert-bell hook. On boot we honor that, and
  // on a click into an already-open tab the SW posts `mobux-navigate`
  // so we can switch without a reload.
  function selectWindow(windowIndex) {
    if (windowIndex == null || windowIndex === "") return;
    fetch(
      `/api/sessions/${encodeURIComponent(session)}/panes/${encodeURIComponent(windowIndex)}/select${nodeQuery()}`,
      { method: "POST" },
    )
      .then(() => {
        core.clear();
        core.scrollToBottom();
        later(() => {
          core.refreshPanes();
          core.reloadHistory();
        }, 300);
      })
      .catch(() => {});
  }

  function windowFromUrl(href) {
    try {
      return new URL(href, location.origin).searchParams.get("w");
    } catch (_) {
      return null;
    }
  }

  if ("serviceWorker" in navigator) {
    on(navigator.serviceWorker, "message", (ev) => {
      if (ev.data?.type === "mobux-navigate") {
        selectWindow(windowFromUrl(ev.data.url));
      }
    });
  }

  // ── Boot ────────────────────────────────────────────────────────────
  // `booted` gates the page-level auto-reconnect listeners below: until
  // boot's own connect() has run there's nothing to reconnect, and firing
  // reconnect() while `core.ws` is still null would open a competing
  // socket that boot then immediately replaces.
  let booted = false;
  (async () => {
    await core.reloadHistory();
    if (disposed) return;
    core.connect();
    booted = true;
    const w = windowFromUrl(location.href);
    if (w != null) {
      // Brief wait so the WS attach completes before we ask tmux to
      // switch windows; refreshPanes after the switch then sees the new
      // active window.
      later(() => selectWindow(w), 500);
    }
  })();

  on(window, "resize", () => core.resize());
  later(() => core.resize(), 100);
  every(() => core.refreshPanes(), 5000);

  // ── Auto-reconnect ──────────────────────────────────────────────────
  // Renderer-agnostic. The tmux session persists server-side, so
  // re-establishing the WS resumes cleanly. `core.reconnect()` is
  // idempotent (no-ops if the socket is already OPEN), so wiring several
  // triggers is safe — whichever fires first reconnects, the rest no-op.
  //
  // The core's own `ws.onclose` handler does capped exponential backoff
  // for the "server bounced / network blip" case; these page-level
  // listeners are the "user came back to the app" fast paths that
  // reconnect immediately instead of waiting out the backoff window. The
  // existing touch-based reconnect (touch.js onTouchStart → onReconnect)
  // stays as a manual fallback.

  function autoReconnect() {
    if (!booted || disposed) return;
    core.reconnect();
  }

  // Primary path: screen/tab is visible again → reconnect now.
  on(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") autoReconnect();
  });
  // Network came back.
  on(window, "online", autoReconnect);
  // Android bfcache restore (app swapped back into the foreground).
  on(window, "pageshow", autoReconnect);

  // A real navigation away / unload is an intentional teardown — mark it
  // so the socket's onclose doesn't arm a (pointless) backoff retry on a
  // page that's going away.
  on(window, "pagehide", () => {
    core.intentionalClose = true;
  });

  // ── Soft keyboard (visualViewport) handler ──────────────────────────
  // Renderer-agnostic. On Android Chrome (the TWA target) the soft
  // keyboard does NOT shrink the layout viewport — `window.innerHeight`
  // and the `100vh`/`100dvh` units used by `.term-body` stay at full
  // screen — but `window.visualViewport.height` does shrink. Without
  // this handler the bottom rows of the terminal (typically the tmux
  // status line + active prompt) end up rendered behind the keyboard.
  //
  // We shrink the body to the visual viewport height so the flex
  // children (#terminal, #reader, #inputBar) reflow into the visible
  // area. Then we dispatch a `resize` so both backends recompute their
  // (cols, rows) from the new host clientHeight. input-bar.js still
  // owns its show/hide auto-restore on viewport grow-back — this handler
  // only handles the body height tracking, which must work whether the
  // input bar is mounted or not (the bug also reproduces when the
  // renderer's native textarea gets focus directly).
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let lastH = vv.height;
    const trackKeyboard = () => {
      const shrunk = vv.height < window.innerHeight - 1;
      document.body.style.height = shrunk ? `${vv.height}px` : "";
      if (Math.abs(vv.height - lastH) > 0.5) {
        lastH = vv.height;
        // Synchronous resize so both backends recompute cols/rows from
        // the freshly-laid-out host height in the same task — no visible
        // jump on the next frame.
        window.dispatchEvent(new Event("resize"));
      }
    };
    on(vv, "resize", trackKeyboard);
    on(vv, "scroll", trackKeyboard);
  }

  // ── Tap-to-snap-to-bottom ───────────────────────────────────────────
  // Renderer-agnostic. When the user is parked mid-scrollback and TAPS
  // the terminal to type, the soft keyboard comes up but the viewport
  // stays parked in scrollback — so what they type lands somewhere they
  // can't see (issue #99). Snap to the live screen on a genuine tap so
  // keystrokes always land in view.
  //
  // We discriminate a TAP from a SWIPE using pointer events, NOT focus.
  // PR #100 hooked `focusin` and snapped on every touch — but focusin
  // fires on tap-to-scroll too, so swiping up to read scrollback
  // immediately snapped back to bottom and broke incremental scrolling.
  // That PR was reverted in #102. Here we only snap when the pointer
  // barely moved (< TAP_MOVE_PX) and was down only briefly
  // (< TAP_MAX_MS): a real tap, not a swipe or a long-press-drag.
  //
  // Both backends mount under `#terminal` (xterm: `.xterm-helper-textarea`,
  // sterk: `.ace_text-input`), so listening on the host element keeps
  // this renderer-agnostic. This coexists with the visualViewport
  // handler above (PR #98) — that one tracks keyboard height, this one
  // tracks the viewport scroll position. Both stay.
  {
    const TAP_MOVE_PX = 10; // max pointer travel for a tap (vs. swipe)
    const TAP_MAX_MS = 250; // max press duration for a tap (vs. drag)
    let downX = 0;
    let downY = 0;
    let downT = 0;
    let tracking = false;

    on(termEl, "pointerdown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
      downT = e.timeStamp;
      tracking = true;
    });

    on(termEl, "pointerup", (e) => {
      if (!tracking) return;
      tracking = false;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      const elapsed = e.timeStamp - downT;
      if (moved < TAP_MOVE_PX && elapsed < TAP_MAX_MS) {
        core.scrollToBottom();
      }
    });

    // A canceled pointer (e.g. the gesture recogniser claims it for a
    // scroll/pinch) is never a tap — drop tracking so the next pointerup
    // can't be misread.
    on(termEl, "pointercancel", () => {
      tracking = false;
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    // No backoff reconnect out of the teardown's own ws.close().
    core.intentionalClose = true;
    unmountReaderGestures();
    reader.unmount();
    gestures.destroy();
    if (topBar) {
      topBar.destroy();
      topBar = null;
    }
    if (inputBar) {
      inputBar.destroy();
      inputBar = null;
    }
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch (_) {}
    }
    core.dispose();
    // The keyboard tracker may have pinned an inline body height.
    document.body.style.height = "";
    if (window.__mobuxView === viewApi) delete window.__mobuxView;
  }

  return { core, dispose };
}
