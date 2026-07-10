import { useState } from "preact/hooks";
import { Router, Route, Switch, Link, useLocation } from "wouter-preact";
import { useHashLocation } from "wouter-preact/use-hash-location";
import { HomePage } from "./pages/Home.jsx";
import { TerminalPage } from "./pages/Terminal.jsx";
import { SettingsPage } from "./pages/Settings.jsx";
import { InstallPage } from "./pages/Install.jsx";
import { ErrorPage } from "./components/ErrorPage.jsx";
import { fatalError } from "./lib/fatalError.js";
import { shouldShowInstallHint, dismiss } from "./lib/installHint.js";

// App shell. Wouter owns client-side routing for the SPA's own routes. The
// terminal page renders no chrome (full-screen island); the others get a slim
// nav so the skeleton is navigable while the migration is in progress.
export function App() {
  // Fail-hard takeover (#190): any server API call that fails without being
  // caught somewhere more specific replaces the whole app with the
  // full-screen error page, checked before routing so it wins on every
  // route — including the terminal island.
  if (fatalError.value) {
    return <ErrorPage error={fatalError.value} />;
  }

  // Hash routing. The SPA is mounted under a sub-path (/static/spa/) parallel
  // to the existing Rust-rendered pages, so hash-based locations avoid needing
  // server-side history fallback and work identically in dev and prod.
  return (
    <Router hook={useHashLocation}>
      <Switch>
        {/* Terminal is a full-bleed island — no shell chrome around it.
            The URL is the whole address: /s/<node>/<name> attaches to that
            node's tmux, /s/<name> to the local host — never to whatever
            node the device last had selected (#185). */}
        <Route path="/s/:node/:name">
          {(params) => <TerminalPage node={params.node} name={params.name} />}
        </Route>
        <Route path="/s/:name">
          {(params) => <TerminalPage name={params.name} />}
        </Route>

        {/* Everything else shares the shell. */}
        <Route>
          <Shell>
            <Switch>
              <Route path="/" component={HomePage} />
              <Route path="/settings" component={SettingsPage} />
              <Route path="/install" component={InstallPage} />
              <Route>
                <div class="settings-group">
                  <h2>Not found</h2>
                  <p>
                    No SPA route here yet. <Link href="/">Home</Link>
                  </p>
                </div>
              </Route>
            </Switch>
          </Shell>
        </Route>
      </Switch>
    </Router>
  );
}

// App-shell chrome. Two headers, both copied verbatim from the old Rust-rendered
// pages (src/main.rs) so the SPA wears the old UI's chrome with the new engine
// underneath; .app-header / .app-header h1 / .header-icon / .header-back come
// from web/static/style.css, so colors/spacing/typography match exactly.
//
//   • home/install/etc: the old render_index header — a `mobux` wordmark
//     (clicks home) + `⚙` gear. No Home/Install text tabs — Install stays
//     reachable via Settings.
//   • /settings: the old settings_page header — a `‹` back link + "settings".
function HomeHeader() {
  const [, navigate] = useLocation();
  return (
    <header class="app-header">
      <h1
        class="app-wordmark"
        role="link"
        tabindex="0"
        onClick={() => navigate("/")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") navigate("/");
        }}
      >
        mobux
      </h1>
      <ReloadButton />
      <button
        class="header-icon header-icon-btn"
        type="button"
        aria-label="Settings"
        onClick={() => navigate("/settings")}
      >
        ⚙
      </button>
    </header>
  );
}

function SettingsHeader() {
  return (
    <header class="app-header">
      <Link href="/" class="header-back" aria-label="Back">
        ‹
      </Link>
      <h1>settings</h1>
      <ReloadButton />
    </header>
  );
}

// Single-action hard reload (#189), always within reach: it lives in both
// app-shell headers (Home + Settings) and, separately, in the terminal
// ribbon (TerminalIsland.jsx) — between the three, every SPA route has one
// tap to a full `location.reload()`, the only clean boot of the terminal
// engine (see #188).
function ReloadButton() {
  return (
    <button
      class="header-icon header-icon-btn"
      type="button"
      aria-label="Reload"
      title="Reload app"
      onClick={() => location.reload()}
    >
      ⟳
    </button>
  );
}

function Shell({ children }) {
  const [location] = useLocation();
  const onSettings = location === "/settings";
  const onInstall = location === "/install";
  return (
    <div class="spa-shell">
      {onSettings ? <SettingsHeader /> : <HomeHeader />}
      {!onInstall && <InstallHint />}
      <main class="spa-main">{children}</main>
    </div>
  );
}

// Nudges a bare-browser-tab visitor toward the standalone PWA (no address
// bar wasting screen). Skipped on /install itself and once the visitor
// dismisses it (device-level, localStorage — see lib/installHint.js).
function InstallHint() {
  const [, navigate] = useLocation();
  const [visible, setVisible] = useState(shouldShowInstallHint);
  if (!visible) return null;
  return (
    <div class="pwa-install-hint">
      <a
        class="pwa-install-hint-link"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          navigate("/install");
        }}
      >
        Install mobux for fullscreen — no browser bar
      </a>
      <button
        type="button"
        class="pwa-install-hint-x"
        aria-label="Dismiss"
        onClick={() => {
          dismiss();
          setVisible(false);
        }}
      >
        ✕
      </button>
    </div>
  );
}
