import { useRef, useLayoutEffect } from "preact/hooks";
import { collectDiagnostics } from "../lib/diagnostics.js";
import { buildIssueUrl } from "../lib/githubIssue.js";

// ── Terminal island ──────────────────────────────────────────────────
//
// Wraps the EXISTING mobux terminal engine instead of reimplementing it. The
// engine (`/static/terminal.js`) is a side-effecting ES module that, on load:
//   * reads window.MOBUX_SESSION / MOBUX_DEV,
//   * binds to a fixed set of DOM ids (#terminal, #reader, #loadquote, the
//     #inputBar ribbon, the #cmdPickList overlay, …),
//   * constructs TerminalCore (xterm or sterk), opens the PTY WebSocket, and
//     wires every gesture / input-bar handler.
//
// So the island's job is purely a HOST:
//   1. Render the exact DOM scaffold the engine expects (mirrors the markup in
//      the Rust `render_terminal_page`).
//   2. Set the window globals.
//   3. Load the same script chain, in order, that the Rust page loads:
//        renderer-picker → vendor bundle (xterm|sterk) → terminal.js (module).
//        All served by the backend through the Vite proxy, so the REAL engine
//        bundle runs unchanged.
//
// This runs ONCE in a layout effect. Preact never re-renders the inner DOM
// (no children, the ref'd subtree is owned by the engine), so the terminal is
// mounted exactly once for the lifetime of the route — the island contract.
//
// `CACHE_BUST` mirrors the Rust page's `?v=` query so a stale SW cache can't
// hand back an old bundle; in dev it is just a constant.
const CACHE_BUST = "spa";

// Ribbon bug-report button (#191): grab the current diagnostics bundle and
// open a prefilled GitHub issue in a new tab. Reuses the same bundle/URL
// builder as the fail-hard error page (lib/diagnostics.js, lib/githubIssue.js).
async function openBugReport() {
  const diagnostics = await collectDiagnostics();
  const url = buildIssueUrl({ title: "Bug report", diagnostics });
  window.open(url, "_blank", "noopener,noreferrer");
}

// Append a classic <script> and resolve when it loads. Order matters (the
// renderer global must exist before terminal-core constructs the backend), so
// callers await each one.
function loadScript(src, { module = false } = {}) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    if (module) el.type = "module";
    el.async = false; // preserve execution order
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.body.appendChild(el);
  });
}

export function TerminalIsland({ node, session }) {
  const rootRef = useRef(null);
  const bootedRef = useRef(false);
  const resizeObsRef = useRef(null);

  useLayoutEffect(() => {
    if (bootedRef.current) return; // never boot twice
    bootedRef.current = true;

    // 1. Globals the engine reads at module-eval time. MOBUX_NODE routes the
    //    PTY WebSocket and every tmux call through the hub's SSH proxy. It
    //    comes from the route (`#/s/<node>/<name>`), never from the device's
    //    selected-node preference — a stale selection must not re-target a
    //    session URL (#185). No node segment ⇒ local host.
    window.MOBUX_SESSION = session;
    window.MOBUX_NODE = node || "";
    window.MOBUX_DEV = false;

    // 2. Resolve the renderer choice exactly like the Rust page's inline
    //    boot script, then load the matching vendor bundle + css first.
    let renderer = "xterm";
    try {
      const s = localStorage.getItem("mobux:renderer");
      if (s === "sterk" || s === "xterm") renderer = s;
    } catch (_) {}
    window.__mobuxRenderer = renderer;

    const v = `?v=${CACHE_BUST}`;
    const bundle = renderer === "sterk" ? "sterk.bundle.js" : "xterm.bundle.js";

    if (renderer === "xterm") {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `/static/vendor/xterm.css${v}`;
      document.head.appendChild(link);
    }

    // 3. Load the chain in order. Vendor bundle (sets window.Terminal /
    //    window.Sterk) → the engine module. The engine boots itself on load.
    (async () => {
      try {
        await loadScript(`/static/vendor/${bundle}${v}`);
        await loadScript(`/static/terminal.js${v}`, { module: true });
        // chime.js sets up the in-page bell that plays when the SW delivers a
        // push notification. It self-boots via IIFE (attaches to SW messages),
        // so loading it once is enough. Guard against double-mount via the global
        // it exposes (unlikely here since the island boots once, but be safe).
        if (!window.__mobuxChime) {
          await loadScript(`/static/chime.js${v}`);
        }
      } catch (e) {
        // Surface boot failure in the loading splash rather than a blank page.
        const q = rootRef.current?.querySelector("#quote");
        if (q) q.textContent = `Terminal failed to load: ${e.message}`;
        return;
      }

      // Force a resize once the SPA layout has actually painted. terminal.js
      // sizes the PTY (cols/rows) from the host element's clientHeight, and it
      // does its own resize at 0ms/100ms after load — but in the SPA the engine
      // boots while Preact's island subtree is still settling its flex height,
      // so that early measurement can read a too-short host and the backend
      // computes far too few rows (the stranded-status-bar / dead-black bug).
      // The engine already listens on window `resize` → core.resize(), so we
      // reuse that machinery: re-fire a synthetic resize after a double-rAF
      // (one full painted frame later) and again after the host's box settles,
      // via a ResizeObserver, so the initial row count is correct without a
      // rotate/keyboard nudge.
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
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
    };
  }, []);

  // Scaffold mirrors render_terminal_page() in src/main.rs. The engine binds to
  // these ids; we render them once and hand the subtree to the engine.
  return (
    <div ref={rootRef} class="term-body-spa">
      <div id="terminal" />
      <div id="reader" class="hidden" />
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
          <button id="uploadBtn" title="Attach file">
            📎
          </button>
          <button id="micBtn" title="Dictate (speech to text)">
            🎤
          </button>
          <button id="settingsBtn" title="Settings">
            ⚙
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
