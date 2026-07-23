// View controller — the SPA owns read-mode view state (issue #206, D3).
//
// The engine publishes a read-only document contract and knows nothing about a
// reader. TerminalIsland mounts the reader next to the terminal and this
// controller owns everything view-related: which view is showing, mount /
// unmount, the toggle affordances, per-window persistence, and the boot
// default. `mobux:viewchange` and the engine-owned `window.__mobuxView` are
// gone; tests drive the factory handles, assembled here for the page.
//
//   createViewController({ root, terminal, createReader }) → {
//     swap(mode), get current, dispose()
//   }
//     root        the island root element (holds #terminal, #reader,
//                 #touchOverlay, #viewToggleBtn).
//     terminal    the createTerminal() handle: { core, document,
//                 openCommandMenu, refreshViewToggle, showInputBar,
//                 twoPullMove, twoPullEnd, test }.
//     createReader the reader factory (from /static/reader.js).

import { getPref, setPref } from "./prefs.js";

export function createViewController({ root, terminal, createReader }) {
  const { core } = terminal;
  const termEl = root.querySelector("#terminal");
  const readerEl = root.querySelector("#reader");
  const overlay = root.querySelector("#touchOverlay");

  let current = "xterm";
  let disposed = false;

  // The per-window override — which view a specific tmux window was last left
  // in — is mid-session tab state, not a durable preference: an in-memory map
  // keyed on the volatile tmux window id, scoped to this mount, pruned when the
  // window dies. Losing it on reload is fine. The default view is the
  // server-held `default_view` preference.
  const windowViews = new Map();

  function activeWindowId() {
    const p = core.panes[core.activeIndex];
    return p?.id || null;
  }

  function storedDefaultView() {
    return getPref("default_view") === "reader" ? "reader" : "xterm";
  }

  const reader = createReader({
    host: readerEl,
    document: terminal.document,
    // Server-side conversation history (issue #220) is keyed by session
    // name — the reader fetches its chat-view past turns from
    // `/api/sessions/{session}/conversation` (issue #221).
    session: core.session,
    handlers: {
      onCommandMenu: () => terminal.openCommandMenu(),
      onSwitchWindow: (dir) => core.switchWindow(dir),
      onReconnect: () => core.reconnect(),
      // The reader has no cursor — a double-tap to type drops back to the
      // terminal first, then reveals the keyboard so keystrokes land in view.
      onExit: () => {
        swap("xterm");
        terminal.showInputBar?.();
      },
      onTwoPullMove: (pull, vh) => terminal.twoPullMove(pull, vh),
      onTwoPullEnd: (pull, vh) => terminal.twoPullEnd(pull, vh),
    },
  });

  function applyView(mode, { persist = true } = {}) {
    if (mode !== "xterm" && mode !== "reader") return;
    if (mode === current) {
      terminal.refreshViewToggle?.();
      return;
    }
    if (mode === "reader") {
      termEl.classList.add("hidden");
      // The reader has its own gesture recogniser on #reader. Disable the
      // terminal overlay so it doesn't sit on top and eat every touch.
      if (overlay) overlay.style.pointerEvents = "none";
      reader.mount();
    } else {
      reader.unmount();
      termEl.classList.remove("hidden");
      if (
        overlay &&
        ("ontouchstart" in window || navigator.maxTouchPoints > 0)
      ) {
        overlay.style.pointerEvents = "auto";
      }
      // Let the flex layout settle before the backend recomputes cols/rows.
      setTimeout(() => {
        if (!disposed) core.resize();
      }, 0);
    }
    current = mode;
    if (persist) {
      setPref("default_view", mode);
      const wid = activeWindowId();
      if (wid) windowViews.set(wid, mode);
    }
    terminal.refreshViewToggle?.();
  }

  function swap(mode) {
    applyView(mode, { persist: true });
  }

  function applyStoredViewForActiveWindow() {
    const wid = activeWindowId();
    const stored = (wid && windowViews.get(wid)) || null;
    applyView(stored || storedDefaultView(), { persist: false });
  }

  function pruneViewPrefs() {
    const live = new Set(core.panes.map((p) => p.id).filter(Boolean));
    for (const wid of windowViews.keys()) {
      if (!live.has(wid)) windowViews.delete(wid);
    }
  }

  // A window may reopen in the view it was last left in; the default applies
  // otherwise. Re-evaluated whenever the pane set changes.
  const onPanes = () => {
    if (disposed) return;
    pruneViewPrefs();
    applyStoredViewForActiveWindow();
  };
  core.addEventListener("panes", onPanes);

  // Land in the preferred view at boot, before the first /panes refresh
  // resolves. The per-window override (if any) is applied by onPanes later.
  if (storedDefaultView() === "reader") {
    setTimeout(() => {
      if (!disposed) applyView("reader", { persist: false });
    }, 0);
  }
  terminal.refreshViewToggle?.();

  function dispose() {
    if (disposed) return;
    disposed = true;
    core.removeEventListener("panes", onPanes);
    reader.dispose();
  }

  return {
    swap,
    get current() {
      return current;
    },
    reader,
    dispose,
  };
}
