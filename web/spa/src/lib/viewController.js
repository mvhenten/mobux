// View controller — the SPA owns read-mode view state (issue #206, D3).
//
// The engine publishes a read-only document contract and knows nothing about a
// reader. TerminalIsland mounts the reader next to the terminal and this
// controller owns everything view-related: which view is showing, mount /
// unmount, the toggle affordances, per-window persistence, and the boot
// default. `mobux:viewchange` and the engine-owned `window.__mobuxView` are
// gone; tests drive the factory handles, assembled here for the page.
//
// There are three views: the terminal, the reader, and read mode (#235).
//
//   createViewController({ root, session, terminal, createReader,
//                          createReadMode }) → {
//     swap(mode), get current, dispose()
//   }
//     root        the island root element (holds #terminal, #reader,
//                 #readmode, #touchOverlay, #viewToggleBtn, #readModeBtn).
//     session     the tmux session name, handed to read mode (its record is
//                 keyed on the session alone).
//     terminal    the createTerminal() handle: { core, document,
//                 openCommandMenu, refreshViewToggle, showInputBar,
//                 twoPullMove, twoPullEnd, test }.
//     createReader the reader factory (from /static/reader.js).
//     createReadMode the read-mode factory (from /static/read-mode.js).

import { getPref, setPref } from "./prefs.js";

const VIEWS = ["xterm", "reader", "read"];

export function createViewController({
  root,
  session = "",
  terminal,
  createReader,
  createReadMode,
}) {
  const { core } = terminal;
  const termEl = root.querySelector("#terminal");
  const readerEl = root.querySelector("#reader");
  const readModeEl = root.querySelector("#readmode");
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
    const stored = getPref("default_view");
    return VIEWS.includes(stored) ? stored : "xterm";
  }

  const reader = createReader({
    host: readerEl,
    document: terminal.document,
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

  const readMode = createReadMode({
    host: readModeEl,
    session,
    handlers: {
      onExit: () => {
        swap("xterm");
        terminal.showInputBar?.();
      },
    },
  });

  function applyView(mode, { persist = true } = {}) {
    if (!VIEWS.includes(mode)) return;
    if (mode === current) {
      terminal.refreshViewToggle?.();
      return;
    }
    if (current === "reader") reader.unmount();
    if (current === "read") readMode.unmount();
    if (mode === "xterm") {
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
    } else {
      termEl.classList.add("hidden");
      // The reader and read mode each have their own gesture recogniser on
      // their host. Disable the terminal overlay so it doesn't sit on top and
      // eat every touch.
      if (overlay) overlay.style.pointerEvents = "none";
      if (mode === "reader") reader.mount();
      else readMode.mount();
    }
    current = mode;
    if (persist) {
      setPref("default_view", mode);
      // Read mode is session-scoped and the per-window map is window-scoped,
      // so read mode never enters it — see applyStoredViewForActiveWindow.
      if (mode !== "read") {
        const wid = activeWindowId();
        if (wid) windowViews.set(wid, mode);
      }
    }
    terminal.refreshViewToggle?.();
  }

  function swap(mode) {
    applyView(mode, { persist: true });
  }

  function applyStoredViewForActiveWindow() {
    // The conversation record is per session, so a window change means nothing
    // to read mode; re-applying a window's stored view here would swap the
    // user out of it and back on every `panes` event.
    if (current === "read") return;
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
  const bootView = storedDefaultView();
  if (bootView !== "xterm") {
    setTimeout(() => {
      if (!disposed) applyView(bootView, { persist: false });
    }, 0);
  }
  terminal.refreshViewToggle?.();

  function dispose() {
    if (disposed) return;
    disposed = true;
    core.removeEventListener("panes", onPanes);
    reader.dispose();
    readMode.dispose();
  }

  return {
    swap,
    get current() {
      return current;
    },
    reader,
    readMode,
    dispose,
  };
}
