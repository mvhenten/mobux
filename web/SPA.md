# mobux SPA migration

Porting the mobux UX to a modern client SPA, decoupled from the Rust backend.
The backend stays the API / PTY / WebSocket server; all UI state lives in the
browser. The existing Rust-rendered HTML pages keep working in parallel during
the migration — nothing here removes or changes them.

**Stack:** Vite + Preact + Wouter (`wouter-preact`) + `@preact/signals`, JSX via
`@preact/preset-vite`.

## Status (phase 5 — peer relay removed)

Phase 1 of [#176](https://github.com/mvhenten/mobux/issues/176): mobux is
moving to a hub model, so the cross-host peer-relay feature (mesh enumeration,
`/r/<peer>/...` proxying, the app-shell host picker) was ripped out entirely.
Single-host behavior is unchanged; `api.js` is a plain fetch wrapper again, and
the terminal island's script chain no longer loads `mesh-client.js` or
`host-picker.js`. A hub-based multi-host UI is tracked separately.

## Status (phase 4)

Phase 4 added the app-shell host picker (`components/HostPicker.jsx`), later
removed in phase 5 above along with the rest of the peer-relay feature.

## Status (phase 3)

Phase 3 completes Settings parity (Listen + Build-info cards) and adds
client-side QR codes to the Install page.

Phase 3 done:

- **Listen card** (`components/settings/Listen.jsx`) — Voice/Rate/Pitch
  controls, Test button, Web Speech API capability gate. Reads/writes the
  server-held `listen_*` preferences (see "Preferences" below).
- **Build-info card** (`components/settings/BuildInfo.jsx`) — Backend version +
  server bundle hash from a new `/api/build-info` endpoint; loaded bundle hash
  from `/static/build-info.json`; stale-UI warning when they diverge.
- **Install QR codes** — `uqr` renders inline SVG QR codes for the CA-cert and
  APK download URLs (derived from `window.location.origin`) directly in the SPA
  Install page. The server `/install` page and its Rust-side QR renderer are
  untouched.
- Headless Playwright verification (7 tests, all green): all phase-2 checks
  plus Listen card persistence, Build-info version/hash display,
  and Install page QR SVG rendering.

## Status (phase 2)

Phase 2 made the SPA loadable on a real phone from the Rust binary (no Vite),
folded the SPA build into the normal build, and brought the remaining pages to
parity. Phase 1 (below) built the foundation.

Phase 2 done:

- **Served from Rust at `/app`** (and `/app/*`, SPA history fallback) behind the
  existing auth + `Cache-Control: no-store`. The old Rust-rendered pages (`/`,
  `/s/:name`, `/settings`, `/install`) are untouched — both UIs coexist; the SPA
  is shadow-mounted. See "Prod serving in Rust" below.
- **Build folded in** — `node web/build.js` (and thus `make build`, plus the
  root `npm` postinstall used in CI/release) builds the SPA into
  `web/static/spa/`, embedded by RustEmbed.
- **Pages at parity**: Home (session list + create/kill/rename + FAB),
  Install (CA + APK + instructions), and the Settings cards — software update,
  notifications, terminal renderer, theme, shell integration — on top of the
  STT card from phase 1.
- Headless Playwright verification against the **prod-served** SPA (binary on a
  throwaway port, no Vite): Home, all Settings cards + their endpoints, STT
  auto-save persistence, and the terminal island + PTY WebSocket — all green.

## Status (phase 1)

Done:

- Vite/Preact/Wouter scaffold with a dev proxy to the Rust backend.
- Routing skeleton for `/`, `/s/:name` (+ `/s/:host/:name`), `/settings`,
  `/install`. Home and Install are stubs; Settings and Terminal are real.
- **Terminal island** — wraps the existing engine, proven at `/s/:name`
  (mounts, PTY WebSocket connects, engine renders).
- **Settings → Speech provider** section fully ported to Preact.
- Headless Playwright verification, both assertions green.

## Directory layout

```
web/spa/
  index.html              entry; loads /static/style.css (backend) + main.jsx
  vite.config.js          @preact/preset-vite, port 5173, proxy, build outDir
  jsconfig.json           editor JSX/preact hints
  playwright.verify.cjs   standalone config for the phase-1 verification run
  verify.spec.mjs         the two phase-1 assertions
  src/
    main.jsx              render(<App/>)
    app.jsx               Wouter router (hash location) + shell chrome
    app.css               shell-only styling (pages reuse backend style.css)
    components/
      TerminalIsland.jsx  the island — hosts the existing engine
      settings/           one component per Settings card
        Update.jsx          software self-update (host-pinned)
        Notifications.jsx   push-trigger prefs (4 checkboxes)
        Renderer.jsx        xterm/sterk picker (server pref)
        Theme.jsx           theme picker (imports /static/themes.js)
        ShellIntegration.jsx OSC-133 installer per shell
        Stt.jsx             speech provider (phase 1, moved here)
        Listen.jsx          Web Speech voice/rate/pitch + test (phase 3)
        BuildInfo.jsx       version + bundle-hash display (phase 3)
    pages/
      Home.jsx            session list: create/kill/rename + FAB
      Terminal.jsx        full-bleed route → TerminalIsland
      Settings.jsx        composes the settings/ cards in page order
      Install.jsx         CA + APK + Android instructions
    lib/
      api.js              same-origin fetch helpers
      stt.js              STT helpers ported 1:1 from the Rust inline IIFE
```

`api.js` exposes two families: plain session-list helpers (`apiGet`/
`apiPutJSON`/`apiPost`/`apiSend`) and host-pinned helpers (`localGet`/
`localFetch`) for update / shell-integration / STT-install. Both are same-origin
fetch today; the split exists for the multi-host work coming after #176.

Build output goes to `web/static/spa/` (git-ignored, regenerated by the build).
Asset base is `/static/spa/`, so the built `index.html` references its JS/CSS at
`/static/spa/assets/…`, which the existing Rust `/static` handler serves. The
binary serves the entry document at `/app` (see "Prod serving in Rust").

## Dev + build commands

From `web/spa/`:

```sh
npm install
# dev server on :5173, proxying to the backend with injected Basic auth:
MOBUX_BACKEND=https://localhost:5152 MOBUX_DEV_AUTH=mvhenten:30879 npm run dev
# open http://localhost:5173/static/spa/
npm run build      # → web/static/spa/
```

The SPA build is also folded into the normal build: `node web/build.js` (run by
`make build`, and by the repo-root `npm` postinstall that CI/release already
invoke) installs the SPA's deps if missing and runs its `npm run build`, so the
assets exist for RustEmbed to pick up at compile time. CI's `check` job runs
`cargo check`/`clippy` without that step, so the SPA asset may be absent there —
that's fine: it compiles, and `serve_spa_index` returns a clear 404 hint if the
asset is missing. The e2e/release jobs run `npm ci` (→ postinstall → SPA build)
before `cargo build`, so the shipped binary embeds the SPA.

## Prod serving in Rust

The binary serves the SPA at **`/app`** (and `/app/*` for an SPA history
fallback — every sub-path returns the SPA's `index.html`). `serve_spa_index`
reads the embedded `spa/index.html`, sets `text/html` + `Cache-Control:
no-store`, and sits behind the global auth layer like every other page. The
SPA's JS/CSS at `/static/spa/assets/…` ride the existing `serve_static` handler.

Routing is hash-based (`/app#/settings`, `/app#/s/<name>`), so deep links and
reloads work without any extra server config; the `/app/*` fallback is belt-and-
suspenders for a future switch to history routing.

The old Rust-rendered pages — `/`, `/s/:name`, `/settings`, `/install` — are
**unchanged**. Both UIs coexist; the SPA is shadow-mounted at `/app`. Cutting
`/` over to the SPA (and deleting the inline pages) is the operator's call
after review — see "Remaining work".

Verify the prod-served SPA without Vite (binary on a throwaway port, never
5151/5152):

```sh
make build
env MOBUX_AUTH_USER=mvhenten MOBUX_PIN=30879 MOBUX_DEV=1 PORT=5183 \
  ./target/debug/mobux &
cd web/spa && npx playwright test --config=playwright.prod.cjs
kill $(lsof -ti :5183)
```

Headless verification (dev server must already be up on :5173):

```sh
npx playwright test --config=playwright.verify.cjs
```

`MOBUX_BACKEND` / `MOBUX_DEV_AUTH` are dev-only env vars read by `vite.config.js`.
Never run anything on :5151 (the live phone server) or :5152's process (the
`make dev-watch` backend) — the SPA only *proxies* to :5152.

## Proxy setup

The browser at :5173 has no backend credentials; the Vite proxy attaches HTTP
Basic auth server-side (`MOBUX_DEV_AUTH`), keeping the SPA a pure client. The
backend is HTTPS with a self-signed cert, so the proxy uses `secure:false` and
`changeOrigin:true`.

Proxied routes → `https://localhost:5152`:

- `/ws` — PTY WebSocket (`ws:true`)
- `/api`, `/v1`, `/transcribe`, `/upload` — REST + transcription
- `/sw.js`, `/static` — service worker + existing assets (vendor bundles,
  `terminal.js`, `style.css`, …)

`/static/spa/` is the SPA's own base; the `/static` proxy rule has a `bypass`
that lets Vite serve everything under `/static/spa/` while still forwarding the
rest of `/static/` to the backend.

## The terminal-island pattern

The existing engine (`/static/terminal.js`) is a side-effecting ES module: on
load it reads `window.MOBUX_SESSION` / `MOBUX_DEV`, binds to a fixed set of DOM
ids (`#terminal`, `#reader`, `#loadquote`, the `#inputBar` ribbon, the
`#cmdPickList` overlay, …), constructs `TerminalCore` (xterm or sterk), and
opens the PTY WebSocket same-origin.

`TerminalIsland.jsx` is purely a host — it does **not** reimplement the engine:

1. Renders the exact DOM scaffold the engine expects (mirrors
   `render_terminal_page` in `src/main.rs`).
2. Sets the window globals.
3. In a **one-time** `useLayoutEffect`, loads the same script chain the Rust
   page loads, in order: renderer-picker → vendor bundle (`xterm.bundle.js` /
   `sterk.bundle.js`) → `terminal.js` (module). All come from the backend
   through the proxy, so the *real* engine bundle runs unchanged.

The effect is guarded so it boots exactly once; Preact never re-renders the
inner subtree (no children, the engine owns it). That is the island contract:
mount once, never re-render the engine.

Reused as-is (the whole point of the island): `terminal-core*.js`, the vendor
bundles, `style.css`, and all the gesture/input-bar/reader plumbing those pull
in.

## Settings: the STT speech provider

Ported 1:1 to a component model. Instead of the old `[hidden]`-toggling on a
fixed DOM, **only the fields that apply to the selected provider are rendered**:

- **Local** — Install + a single run toggle (Start/Stop). Nothing else; host,
  port, model and key are baked in server-side.
- **Network** — Host + Port + discovered Model.
- **OpenAI** — API key + Model.

Behaviour preserved from the Rust inline IIFE: auto-save on every change (no
manual Save), debounced host/port → model re-discovery → save, bare-hostname
normalization (`lab` → `http://lab`), pasted-URL splitting into host/port,
model discovery via `/api/stt/models`, a "custom…" free-text model option, and
the local install-poll + run toggle driven by `/api/stt/status`.

Consumes the STT API on `feat/stt-transcribe`: `GET|PUT /api/settings/stt`,
`GET /api/stt/models`, `GET /api/stt/status`, `POST /api/stt/install|start|stop`.

## Other Settings cards

Ported in phase 2 (one component per card, in `components/settings/`):

- **Software update** (`Update.jsx`) — `/api/update/status|check|run` + the
  `/api/identify` version-watch poll. Host-pinned: always the page's own binary.
- **Notifications** (`Notifications.jsx`) — `GET|PUT /api/settings/notifications`
  (snake_case `bell` / `bell_emoji` / `program_exit` / `program_exit_nonzero`),
  auto-save on every checkbox change.
- **Terminal renderer** (`Renderer.jsx`) — server-held `renderer` preference.
- **Theme** (`Theme.jsx`) — dynamically imports the backend `/static/themes.js`
  module (single source of truth), persists the server-held `theme` preference,
  applies + broadcasts `mobux:theme`.
- **Shell integration** (`ShellIntegration.jsx`) —
  `GET /api/shell-integration/status`, `POST .../install|uninstall` with a
  `{shell}` body; OSC-133 snippets shown verbatim.

## Preferences (server-synced, #211)

UI preferences are global server state, not per-device storage. mobux is
single-user (one basic-auth user, one sqlite row), so there is no per-user or
per-device modelling. `GET|PUT /api/settings/preferences` returns/replaces the
whole blob: `renderer`, `theme`, `default_view`, `osc133_hint_dismissed`,
`listen_voice`, `listen_rate`, `listen_pitch`, `selected_node`.

`/static/prefs.js` is the one client module both the SPA and the terminal engine
share. `main.jsx` loads it and `await`s `hydrate()` (the whole blob, once)
before first render, so the terminal island reads `renderer`/`theme`/etc.
synchronously at boot. Every change PUTs the whole blob. No local caching: a
server that's unreachable at boot falls back to defaults for that load.

mobux keeps no client-side persistent storage — no `localStorage`, no
`sessionStorage`. Durable state is server-synced (the preferences blob above);
everything else is plain in-memory module state for the tab's lifetime and is
expected to reset on reload: the per-window reader/xterm override (keyed on the
volatile tmux window id), the telemetry overlay toggle, and the reload
baseline the server-update watcher compares against. A source-scan test
(`no_client_storage_in_web_sources` in `src/main.rs`) fails the build on any
`localStorage`/`sessionStorage` occurrence in the web sources.

## Remaining work

1. **Old-UI teardown (operator's call).** Nothing here removes the inline pages.
   Once `/app` is reviewed and trusted, cut `/` (and friends) over to the SPA and
   delete the Rust-rendered `index`/`settings`/`install`/terminal templates and
   the now-dead `*.js` (`index.js`, `settings.js`, `update.js`,
   `settings-theme.js`, `settings-renderer.js`, `shell-integration.js`, the
   terminal inline boot script). The terminal page's inline boot collapses into
   the island once the SPA owns that route.
```
