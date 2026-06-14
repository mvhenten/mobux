import { Router, Route, Switch, Link } from 'wouter-preact';
import { useHashLocation } from 'wouter-preact/use-hash-location';
import { HomePage } from './pages/Home.jsx';
import { TerminalPage } from './pages/Terminal.jsx';
import { SettingsPage } from './pages/Settings.jsx';
import { InstallPage } from './pages/Install.jsx';

// App shell. Wouter owns client-side routing for the SPA's own routes. The
// terminal page renders no chrome (full-screen island); the others get a slim
// nav so the skeleton is navigable while the migration is in progress.
export function App() {
  // Hash routing. The SPA is mounted under a sub-path (/static/spa/) parallel
  // to the existing Rust-rendered pages, so hash-based locations avoid needing
  // server-side history fallback and work identically in dev and prod.
  return (
    <Router hook={useHashLocation}>
      <Switch>
        {/* Terminal is a full-bleed island — no shell chrome around it. */}
        <Route path="/s/:host/:name">
          {(params) => <TerminalPage host={params.host} name={params.name} />}
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
                <div class="settings-card">
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

function Shell({ children }) {
  return (
    <div class="spa-shell">
      <nav class="spa-nav">
        <Link href="/">Home</Link>
        <Link href="/settings">Settings</Link>
        <Link href="/install">Install</Link>
      </nav>
      <main class="spa-main">{children}</main>
    </div>
  );
}
