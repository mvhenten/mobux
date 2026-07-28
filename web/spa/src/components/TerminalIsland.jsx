import { useRef, useLayoutEffect } from "preact/hooks";
import { collectDiagnostics } from "../lib/diagnostics.js";
import { buildIssueUrl } from "../lib/githubIssue.js";
import { getPref } from "../lib/prefs.js";
import { readLoadedBundleHash } from "../lib/bundleHash.js";
import { createViewController } from "../lib/viewController.js";

// ── Terminal island ──────────────────────────────────────────────────
//
// Hosts the mobux terminal engine (`/static/terminal.js`) as a real
// component. The engine exports `createTerminal({ node, session, host,
// renderer })` → `{ dispose() }`: config goes in as arguments (no window
// globals), and dispose() tears down everything the engine attached —
// WebSocket, renderer instance, window/document listeners, timers.
//
// The island's job:
//   1. Render the DOM scaffold the engine binds to (#terminal, #reader,
//      #loadquote, the #inputBar ribbon, the #cmdPickList overlay, …).
//   2. Load the renderer's vendor bundle (once per document), then create
//      the engine in an effect and dispose it on unmount. A route-param
//      change is a clean dispose + create — no document reload (#188), and
//      the new engine attaches to exactly the (node, session) in the URL
//      (the #185 regression class).
//
// `CACHE_BUST` mirrors the old Rust page's `?v=` query-param convention on
// <script>/<link> tags, but it's a fixed string — it does no cache-busting
// of its own. What actually guarantees a stale cache never hands back an
// old bundle is `serve_static` in src/main.rs serving every /static/* asset
// `no-store, must-revalidate`; the query param is vestigial and harmless.
const CACHE_BUST = "spa";

// Ribbon bug-report button (#191): grab the current diagnostics bundle and
// open a prefilled GitHub issue in a new tab. Reuses the same bundle/URL
// builder as the fail-hard error page (lib/diagnostics.js, lib/githubIssue.js).
//
// On desktop the tab MUST be opened synchronously inside the click gesture:
// awaiting the diagnostics fetches first loses the user activation, and popup
// blockers (Android Chrome) silently kill the window.open. So open about:blank
// while the gesture is live, then steer it to the issue URL once the bundle
// resolves. `noopener` can't be passed as a window feature here (it makes
// window.open return null, losing the handle), so sever the opener by hand
// while the tab is still same-origin.
//
// In the TWA that placeholder tab would open inside the app shell. There the
// intent:// escape (window.__mobuxOpenExternal, set by the engine) leaves the
// shell and needs no window handle, so skip the popup entirely.
async function openBugReport() {
  const isTWA = document.referrer.startsWith("android-app://");
  const win = isTWA ? null : window.open("about:blank", "_blank");
  if (win) win.opener = null;
  const diagnostics = await collectDiagnostics();
  const url = buildIssueUrl({ title: "Bug report", diagnostics });
  const openExternal = window.__mobuxOpenExternal;
  if (isTWA && typeof openExternal === "function") {
    openExternal(url);
    return;
  }
  if (win) {
    win.location = url;
    return;
  }
  // Popup blocked anyway — fall back to navigating this tab.
  window.location.href = url;
}

// Append a classic <script> and resolve when it loads. Deduped per document:
// the vendor bundles pin window globals (window.Terminal / window.Sterk) and
// chime.js self-boots, so each URL loads exactly once no matter how many
// times the island mounts.
const loadedScripts = new Map();
function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = false; // preserve execution order
        el.onload = () => resolve();
        el.onerror = () => {
          loadedScripts.delete(src); // a later mount may retry
          reject(new Error(`failed to load ${src}`));
        };
        document.body.appendChild(el);
      }),
    );
  }
  return loadedScripts.get(src);
}

function ensureStylesheet(href) {
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

export function TerminalIsland({ node, session }) {
  const rootRef = useRef(null);
  const resizeObsRef = useRef(null);

  useLayoutEffect(() => {
    // The engine attaches to exactly this (node, session) — both come from
    // the route (`#/s/<node>/<name>`), never from the device's selected-node
    // preference, so a stale selection can't re-target a session URL (#185).
    // No node segment ⇒ local host.
    let cancelled = false;
    let engine = null;
    let viewCtl = null;

    // Resolve the renderer choice from the server-held preference (hydrated at
    // boot by main.jsx), then load the matching vendor bundle + css (once per
    // document) before constructing the engine.
    const renderer = getPref("renderer") === "sterk" ? "sterk" : "xterm";

    const v = `?v=${CACHE_BUST}`;
    const bundle = renderer === "sterk" ? "sterk.bundle.js" : "xterm.bundle.js";

    if (renderer === "xterm") {
      ensureStylesheet(`/static/vendor/xterm.css${v}`);
    }

    (async () => {
      let createTerminal;
      let createReader;
      let createReadMode;
      try {
        await loadScript(`/static/vendor/${bundle}${v}`);
        // The engine and reader modules are pure factory exports (no side
        // effects), so the browser's module-map caching is exactly right:
        // first mount fetches them, every later mount reuses them.
        ({ createTerminal } = await import(
          /* @vite-ignore */ `/static/terminal.js${v}`
        ));
        ({ createReader } = await import(
          /* @vite-ignore */ `/static/reader.js${v}`
        ));
        ({ createReadMode } = await import(
          /* @vite-ignore */ `/static/read-mode.js${v}`
        ));
        // chime.js sets up the in-page bell that plays when the SW delivers a
        // push notification. It self-boots via IIFE (attaches to SW messages),
        // so loading it once is enough; it also guards itself via the global
        // it exposes.
        if (!window.__mobuxChime) {
          await loadScript(`/static/chime.js${v}`);
        }
      } catch (e) {
        // Surface boot failure in the loading splash rather than a blank page.
        const q = rootRef.current?.querySelector("#quote");
        if (q) q.textContent = `Terminal failed to load: ${e.message}`;
        return;
      }
      if (cancelled || !rootRef.current) return;

      // The engine renders the view toggle affordances but owns no view
      // state (#206 D3); it calls back into these opaque hooks, which the
      // controller (created just below) fulfils.
      //
      // 📖 is the terminal↔reader toggle: from read mode it goes to the
      // reader, which is what its icon says. 💬 is read mode's own button,
      // so read mode is one tap away from either other view (#235).
      const viewToggle = {
        toggle: () =>
          viewCtl?.swap(viewCtl.current === "reader" ? "xterm" : "reader"),
        isReader: () => viewCtl?.current === "reader",
      };
      const readToggle = {
        toggle: () =>
          viewCtl?.swap(viewCtl.current === "read" ? "xterm" : "read"),
        isRead: () => viewCtl?.current === "read",
      };

      engine = createTerminal({
        node: node || "",
        session,
        host: rootRef.current,
        renderer,
        // Diagnostic only: rides to the WS URL as &build=<hash> so a stale tab
        // identifies itself in the server's attach log (never affects routing).
        build: readLoadedBundleHash() || "",
        viewToggle,
        readToggle,
      });

      // The reader and read mode are sibling components mounted next to the
      // terminal; the controller owns swap / mount / persistence / per-window
      // state.
      viewCtl = createViewController({
        root: rootRef.current,
        session,
        terminal: engine,
        createReader,
        createReadMode,
      });

      // Assemble the page's test surface from the factory handles. The engine
      // no longer self-wires a global (#206 D3); tests drive the handles.
      const { reader, readMode } = viewCtl;
      window.__mobuxView = {
        swap: (mode) => viewCtl.swap(mode),
        get current() {
          return viewCtl.current;
        },
        send: (d) => engine.core.send(d),
        test: {
          ...engine.test,
          readerAwaitRender: () => reader.awaitNextRender(),
          readerForceRender: () => reader.forceRender(),
          readerAtBottom: () => reader.atBottom,
          readerForceScrollTop: () => reader.forceScrollTop(),
          readerScrollY: () => reader.scrollY,
          readerMaxScroll: () => reader.maxScroll,
          readerInnerHeight: () => reader.innerHeight,
          readerScrollBy: (dy) => reader.scrollBy(dy),
          readerStickToBottom: () => reader.stickToBottom(),
          statusBarOffsetHeight: () => reader.statusBarOffsetHeight(),
          statusBarFilled: () => reader.statusBarFilled(),
          readModeMounted: () => readMode.mounted,
          readModeRefreshNow: () => readMode.refreshNow(),
          // The tmux window the controller keys per-window view state on. The
          // panes API is the server's answer; this is the client's, and only
          // this one has taken the `panes` event.
          activeWindowId: () =>
            engine.core.panes[engine.core.activeIndex]?.id || null,
        },
      };

      // Force a resize once the SPA layout has actually painted. The engine
      // sizes the PTY (cols/rows) from the host element's clientHeight, and it
      // does its own resize at 0ms/100ms after boot — but in the SPA the
      // engine boots while Preact's island subtree is still settling its flex
      // height, so that early measurement can read a too-short host and the
      // backend computes far too few rows (the stranded-status-bar /
      // dead-black bug). The engine already listens on window `resize` →
      // core.resize(), so we reuse that machinery: re-fire a synthetic resize
      // after a double-rAF (one full painted frame later) and again after the
      // host's box settles, via a ResizeObserver, so the initial row count is
      // correct without a rotate/keyboard nudge.
      const kick = () => window.dispatchEvent(new Event("resize"));
      requestAnimationFrame(() => requestAnimationFrame(kick));

      const host = rootRef.current?.querySelector("#terminal");
      if (host && "ResizeObserver" in window) {
        let last = 0;
        const ro = new ResizeObserver(() => {
          const h = host.clientHeight;
          if (h && h !== last) {
            last = h;
            kick();
          }
        });
        ro.observe(host);
        resizeObsRef.current = ro;
      }
    })();

    return () => {
      cancelled = true;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      if (window.__mobuxView) delete window.__mobuxView;
      viewCtl?.dispose();
      viewCtl = null;
      engine?.dispose();
      engine = null;
    };
    // A (node, session) change is a full dispose + create. TerminalPage also
    // keys the island on the pair, so in practice Preact remounts the whole
    // scaffold (fresh splash, fresh #terminal); these deps are the backstop.
  }, [node, session]);

  // The engine binds to these ids (scoped to this subtree via the `host`
  // factory argument); we render them once per mount and hand the subtree
  // to the engine.
  return (
    <div ref={rootRef} class="term-body-spa">
      <div id="terminal" />
      <div id="reader" class="hidden" />
      <div id="readmode" class="hidden" />
      <div id="loadquote">
        <q id="quote" />
        <br />
        <cite id="qauthor" />
      </div>
      <div id="touchOverlay" />
      <div id="paneIndicator" />
      <div id="cmdOverlayBg" />
      <div id="cmdPickList">
        <div class="cmd-header">
          <h3>tmux</h3>
          <button class="cmd-close" id="cmdCloseBtn" aria-label="Close">
            Close
          </button>
        </div>
        <button class="cmd-item" data-cmd="new-window">
          New window
        </button>
        <button class="cmd-item" data-cmd="kill-window">
          Close window
        </button>
        <div class="cmd-separator" />
        <button class="cmd-item" data-cmd="split-h">
          Split horizontal
        </button>
        <button class="cmd-item" data-cmd="split-v">
          Split vertical
        </button>
        <button class="cmd-item" data-cmd="kill-pane">
          Close pane
        </button>
        <div class="cmd-separator" />
        <button class="cmd-item" data-cmd="next-window">
          Next window
        </button>
        <button class="cmd-item" data-cmd="prev-window">
          Previous window
        </button>
        <button class="cmd-item" data-cmd="next-pane">
          Next pane
        </button>
        <button class="cmd-item" data-cmd="prev-pane">
          Previous pane
        </button>
        <div class="cmd-separator" />
        <button class="cmd-item" data-cmd="zoom-pane">
          Zoom pane
        </button>
      </div>

      <div id="inputBar" class="input-bar hidden">
        <div id="inputRibbon" class="input-ribbon">
          <button id="viewToggleBtn" title="Toggle reader/terminal view">
            📖
          </button>
          <button id="readModeBtn" title="Switch to read mode">
            💬
          </button>
          <button id="uploadBtn" title="Attach file">
            📎
          </button>
          <button id="micBtn" title="Dictate (speech to text)">
            🎤
          </button>
          <button id="settingsBtn" title="Settings">
            ⚙
          </button>
          {/* Single-action hard reload (#189) — no data-key, so it's ignored
              by the engine's ribbon delegation (input-bar.js only intercepts
              `button[data-key]`); the click is handled directly by Preact. */}
          <button
            id="reloadBtn"
            type="button"
            title="Reload app"
            onClick={() => location.reload()}
          >
            🔄
          </button>
          <button
            id="reportBugBtn"
            title="Report a bug"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openBugReport}
          >
            🐛
          </button>
          <button data-key="\x7f">⌫</button>
          <button data-key="\r">⏎</button>
          <button data-key="\x1b[D">←</button>
          <button data-key="\x1b[C">→</button>
          <button data-key="\x1b[A">↑</button>
          <button data-key="\x1b[B">↓</button>
          <button data-key="\x03">^C</button>
          <button data-key="\x04">^D</button>
          <button data-key="\x1b">Esc</button>
          <button data-key="\t">Tab</button>
          <button data-key="\x1a">^Z</button>
          <button data-key="\x1b[3~">Del</button>
          <button data-key="\x1b[H">Home</button>
          <button data-key="\x1b[F">End</button>
          <button data-key="\x15">^U</button>
          <button data-key="\x0c">^L</button>
          <button data-key="/clear\r">/clear</button>
          <button data-key="/quit\r">/quit</button>
        </div>
        <div
          id="inputToast"
          class="input-toast hidden"
          role="status"
          aria-live="polite"
        />
        <div class="input-row">
          <input
            id="inputText"
            type="text"
            enterkeyhint="send"
            placeholder="Type here…"
            autocomplete="off"
            autocorrect="on"
            autocapitalize="off"
            spellcheck={false}
          />
          <button id="inputSend" class="input-send" title="Send without Enter">
            ▶
          </button>
        </div>
      </div>
    </div>
  );
}
