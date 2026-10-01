import { Router, Route, Switch, Link, useLocation } from "wouter-preact";
import { useHashLocation } from "wouter-preact/use-hash-location";
import { HomePage } from "./pages/Home.jsx";
import { TerminalPage } from "./pages/Terminal.jsx";
import { SettingsPage, SettingsSubPage, SUB_PAGES } from "./pages/Settings.jsx";
import {
  Button,
  SettingsHeader,
  useSettingsNav,
} from "./components/settings/ui.jsx";
import { InstallPage } from "./pages/Install.jsx";
import { ErrorPage } from "./components/ErrorPage.jsx";
import { fatalError } from "./lib/fatalError.js";
import { dismissUpdate, updateAvailable } from "./lib/reload.js";
import { SignedOutNotice } from "./components/SignedOutNotice.jsx";

// App shell. Wouter owns client-side routing for the SPA's own routes. The
// terminal page renders no chrome (full-screen island); the others get a slim
// nav so the skeleton is navigable while the migration is in progress.
export function App() {
  // Fail-hard takeover (#190): any server API call that fails without being
  // caught somewhere more specific replaces the whole app with the
  // full-screen error page, checked before routing so it wins on every
  // route — including the terminal island.
  if (fatalError.value) {
    return (
      <>
        <SignedOutNotice />
        <ErrorPage error={fatalError.value} />
      </>
    );
  }

  // Hash routing. The SPA is mounted under a sub-path (/static/spa/) parallel
  // to the existing Rust-rendered pages, so hash-based locations avoid needing
  // server-side history fallback and work identically in dev and prod.
  return (
    <>
      <SignedOutNotice />
      <UpdateBar />
      <Routes />
    </>
  );
}

// A new server build while a terminal is open: offered, never forced.
function UpdateBar() {
  if (!updateAvailable.value) return null;
  return (
    <div
      id="updateBar"
      class="update-bar settings-status settings-status--action"
      role="status"
    >
      <span class="settings-status-line">New version available</span>
      <Button
        id="updateBarReload"
        variant="primary"
        class="btn--inline"
        onClick={() => location.reload()}
      >
        Reload
      </Button>
      <Button
        id="updateBarDismiss"
        variant="secondary"
        class="btn--inline"
        aria-label="Dismiss"
        onClick={dismissUpdate}
      >
        ✕
      </Button>
    </div>
  );
}

function Routes() {
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
              <Route path="/settings/:section">
                {(params) => <SettingsSubPage section={params.section} />}
              </Route>
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
//   • /settings and its sub-pages: a sticky back chevron + title
//     (SettingsHeader, components/settings/ui.jsx).
function HomeHeader() {
  const [, navigate] = useLocation();
  const { push } = useSettingsNav();
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
        onClick={() => push("/settings")}
      >
        ⚙
      </button>
    </header>
  );
}

// Single-action hard reload (#189): in the Home header, the terminal ribbon
// (TerminalIsland.jsx) and Settings → Software update — the recovery hatch
// that refetches the bundle and reboots the whole app.
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

function settingsHeaderFor(location) {
  if (location === "/settings")
    return <SettingsHeader title="Settings" fallback="/" />;
  const m = location.match(/^\/settings\/([^/]+)$/);
  if (!m) return null;
  const sub = SUB_PAGES[m[1]];
  return (
    <SettingsHeader title={sub ? sub.title : "Settings"} fallback="/settings" />
  );
}

function Shell({ children }) {
  const [location] = useLocation();
  return (
    <div class="spa-shell">
      {settingsHeaderFor(location) || <HomeHeader />}
      <main class="spa-main">{children}</main>
    </div>
  );
}
