// Ring buffer for window.onerror/unhandledrejection (#190, #191) — imported
// first, before anything else, so nothing that boots after it goes
// uncaptured. See lib/errorLog.js.
import "./lib/errorLog.js";

import { render } from "preact";
import { App } from "./app.jsx";
import { watchBuildHash } from "./lib/reload.js";
import "./app.css";

// Auto-reload on server update (#189) — remembers the server's build_hash
// and hard-reloads the tab when it changes. Started once for the whole app
// lifetime, independent of route.
watchBuildHash();

// Built-in client telemetry channel, same backend ES module the old
// server-rendered pages loaded as <script type="module" src="/static/telemetry.js">.
// Load it by absolute URL (mirrors themes.js in Theme.jsx) so it resolves to
// the running host in both dev (Vite proxy) and prod, and the bundler treats
// it as a genuine dynamic import rather than trying to inline it. Always on —
// no dev-mode gate.
import(
  /* @vite-ignore */ new URL("/static/telemetry.js", location.origin).href
).catch((e) => console.warn("telemetry.js load failed", e));

// External-link escape (#…): route any anchor to a non-mobux origin out of
// the app shell (system browser in the TWA) instead of navigating inside it.
// Loads the same backend module the classic terminal engine uses — one
// shared open-path, one delegated click handler for the whole SPA.
import(
  /* @vite-ignore */ new URL("/static/external-link.js", location.origin).href
)
  .then((m) => m.installExternalLinkHandler())
  .catch((e) => console.warn("external-link.js load failed", e));

// Server-held UI preferences (#211). Load the shared engine module and
// fetch the whole blob before first render, so the terminal island reads the
// renderer/theme/etc. the server holds — not per-device localStorage, which is
// gone. hydrate() never rejects (it falls back to defaults if the server is
// unreachable), so a brief blocking fetch here can't wedge boot.
async function boot() {
  try {
    const prefs = await import(
      /* @vite-ignore */ new URL("/static/prefs.js", location.origin).href
    );
    await prefs.hydrate();
  } catch (e) {
    console.warn("prefs.js load failed", e);
  }
  render(<App />, document.getElementById("app"));
}

boot();
