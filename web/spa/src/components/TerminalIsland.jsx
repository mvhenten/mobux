import { useRef, useLayoutEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { collectDiagnostics } from "../lib/diagnostics.js";
import { buildIssueUrl } from "../lib/githubIssue.js";
import { getPref } from "../lib/prefs.js";
import { readLoadedBundleHash } from "../lib/bundleHash.js";
import { createViewController } from "../lib/viewController.js";
import { loadScript, staticUrl } from "../lib/staticAssets.js";
import {
  RENDERER_LABELS,
  loadRenderer,
  otherRenderer,
} from "../lib/rendererProbe.js";
import { probeSession } from "../lib/accessSession.js";
import { DrawerFavourites } from "./DrawerFavourites.jsx";

const KEYS = [
  ["\\x7f", "⌫", "Backspace"],
  ["\\r", "⏎", "Enter"],
  ["\\x1b[D", "←", "Left"],
  ["\\x1b[C", "→", "Right"],
  ["\\x1b[A", "↑", "Up"],
  ["\\x1b[B", "↓", "Down"],
  ["\\x03", "^C", "Ctrl-C"],
  ["\\x04", "^D", "Ctrl-D"],
  ["\\x1b", "Esc", "Esc"],
  ["\\t", "Tab", "Tab"],
  ["\\x1a", "^Z", "Ctrl-Z"],
  ["\\x1b[3~", "Del", "Del"],
  ["\\x1b[H", "Home", "Home"],
  ["\\x1b[F", "End", "End"],
  ["\\x15", "^U", "Ctrl-U"],
  ["\\x0c", "^L", "Ctrl-L"],
  ["/clear\\r", "/clear", "/clear"],
  ["/quit\\r", "/quit", "/quit"],
];

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
//   2. Load the vendor bundles (once per document), then create
//      the engine in an effect and dispose it on unmount. A route-param
//      change is a clean dispose + create — no document reload (#188), and
//      the new engine attaches to exactly the (node, session) in the URL
//      (the #185 regression class).
//   3. Fall back to the other renderer, with a notice, when the configured
//      one fails to load or start, so the phone always gets a terminal.

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

function noticeText({ kind, failed }) {
  const [first] = failed;
  if (kind === "fallback") {
    return `The ${RENDERER_LABELS[first.name]} renderer failed to load (${first.reason}), so this terminal fell back to ${RENDERER_LABELS[otherRenderer(first.name)]}. Pick a renderer in Settings → Terminal renderer.`;
  }
  const reasons = failed
    .map((f) => `${RENDERER_LABELS[f.name]}: ${f.reason}`)
    .join("; ");
  return `Both renderers failed to load (${reasons}). Update or reinstall mobux, then reload this page.`;
}

function RendererNotice({ notice, onDismiss }) {
  return (
    <div id="rendererFallbackNotice" class="renderer-fallback" role="alert">
      <p>{noticeText(notice)}</p>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}

export function TerminalIsland({ node, session }) {
  const [, navigate] = useLocation();
  const rootRef = useRef(null);
  const resizeObsRef = useRef(null);
  const engineRef = useRef(null);
  const [rendererNotice, setRendererNotice] = useState(null);

  useLayoutEffect(() => {
    // The engine attaches to exactly this (node, session) — both come from
    // the route (`#/s/<node>/<name>`), never from the device's selected-node
    // preference, so a stale selection can't re-target a session URL (#185).
    // No node segment ⇒ local host.
    let cancelled = false;
    let engine = null;
    let viewCtl = null;

    // Resolve the renderer choice from the server-held preference (hydrated at
    // boot by main.jsx), then load the vendor bundles + css (once per
    // document) before constructing the engine. The headless xterm bundle
    // always loads: it parses the engine's text buffer under either renderer.
    const configured = getPref("renderer") === "sterk" ? "sterk" : "xterm";

    const showBootFailure = (e) => {
      // Surface boot failure in the loading splash rather than a blank page.
      const q = rootRef.current?.querySelector("#quote");
      if (q) q.textContent = `Terminal failed to load: ${e.message}`;
      return null;
    };

    (async () => {
      let createTerminal;
      let createReader;
      let createReadMode;
      try {
        // The engine and reader modules are pure factory exports (no side
        // effects), so the browser's module-map caching is exactly right:
        // first mount fetches them, every later mount reuses them.
        ({ createTerminal } = await import(
          /* @vite-ignore */ staticUrl("terminal.js")
        ));
        ({ createReader } = await import(
          /* @vite-ignore */ staticUrl("reader.js")
        ));
        ({ createReadMode } = await import(
          /* @vite-ignore */ staticUrl("read-mode.js")
        ));
        // chime.js sets up the in-page bell that plays when the SW delivers a
        // push notification. It self-boots via IIFE (attaches to SW messages),
        // so loading it once is enough; it also guards itself via the global
        // it exposes.
        if (!window.__mobuxChime) {
          await loadScript(staticUrl("chime.js"));
        }
      } catch (e) {
        showBootFailure(e);
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

      const start = async (renderer) => {
        const loaded = await loadRenderer(renderer);
        if (!loaded.ok) {
          return {
            ok: false,
            name: renderer,
            reason: `/static/${loaded.asset} did not load`,
          };
        }
        if (cancelled || !rootRef.current) return { ok: true, engine: null };
        try {
          const created = createTerminal({
            node: node || "",
            session,
            host: rootRef.current,
            renderer,
            // Diagnostic only: rides to the WS URL as &build=<hash> so a stale
            // tab identifies itself in the server's attach log (never affects
            // routing).
            build: readLoadedBundleHash() || "",
            viewToggle,
            readToggle,
          });
          return { ok: true, engine: created };
        } catch (e) {
          return { ok: false, name: renderer, reason: e.message };
        }
      };

      let started = await start(configured);
      if (!started.ok) {
        const failed = started;
        console.error(`[terminal] ${configured} renderer failed:`, failed);
        started = await start(otherRenderer(configured));
        setRendererNotice(
          started.ok
            ? { kind: "fallback", failed: [failed] }
            : { kind: "failed", failed: [failed, started] },
        );
      }
      if (!started.ok) {
        showBootFailure(new Error("no terminal renderer could start"));
        return;
      }
      engine = started.engine;
      if (cancelled) {
        engine?.dispose();
        engine = null;
      }
      if (!engine) return;
      engineRef.current = engine;

      // A socket that closes may be a lapsed Cloudflare Access session, which
      // a WebSocket cannot tell apart from a network blip. One probe per close
      // decides (a close the engine asked for needs none); signed out, the reconnect loop stops and the app shows the
      // signed-out notice instead of a dead terminal.
      const core = engine.core;
      core.addEventListener("close", async () => {
        if (core.intentionalClose) return;
        if (await probeSession()) core.suspend();
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
          readModeScrollBy: (dy) => readMode.scrollBy(dy),
          readModeScrollY: () => readMode.scrollY,
          readModeMaxScroll: () => readMode.maxScroll,
          readModeEntryCount: () => readMode.entryCount,
          readModeHasOlder: () => readMode.hasOlder,
          readModeLoadOlder: () => readMode.loadOlderNow(),
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
      engineRef.current = null;
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
      {rendererNotice && (
        <RendererNotice
          notice={rendererNotice}
          onDismiss={() => setRendererNotice(null)}
        />
      )}
      <div id="cmdOverlayBg" />
      <div
        id="cmdPickList"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmdSheetTitle"
      >
        <div class="cmd-handle" aria-hidden="true" />
        <div class="cmd-header">
          <h3 id="cmdSheetTitle">tmux</h3>
          <button type="button" class="cmd-close" id="cmdCloseBtn">
            Close
          </button>
        </div>
        <section class="cmd-group">
          <button
            type="button"
            class="cmd-item"
            id="cmdVoiceBtn"
            onClick={() => {
              engineRef.current?.closeCommandMenu();
              engineRef.current?.startDictation();
            }}
          >
            Start voice mode
          </button>
          <button
            type="button"
            class="cmd-item"
            id="cmdDashboardBtn"
            onClick={() => navigate("/")}
          >
            Dashboard
          </button>
        </section>
        <DrawerFavourites engineRef={engineRef} />
        <details class="cmd-group cmd-section" id="cmdKeysSection">
          <summary class="cmd-section-title">Keys</summary>
          <div class="cmd-keys">
            {KEYS.map(([key, , label]) => (
              <button type="button" class="cmd-key" data-key={key} key={key}>
                {label}
              </button>
            ))}
          </div>
        </details>
        <details class="cmd-group cmd-section" id="cmdWindowsSection">
          <summary class="cmd-section-title">tmux windows</summary>
          <button class="cmd-item" data-cmd="new-window">
            New window
          </button>
          <button class="cmd-item" data-cmd="next-window">
            Next window
          </button>
          <button class="cmd-item" data-cmd="prev-window">
            Previous window
          </button>
          <button class="cmd-item" data-cmd="kill-window">
            Close window
          </button>
        </details>
        <section class="cmd-group">
          <button type="button" class="cmd-item" id="cmdSettingsBtn">
            Settings
          </button>
        </section>
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
          {KEYS.map(([key, glyph]) => (
            <button data-key={key} key={key}>
              {glyph}
            </button>
          ))}
        </div>
        <div id="inputToast" class="mobux-attach-error" />
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
