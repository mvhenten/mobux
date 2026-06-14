# mobux SPA migration

Porting the mobux UX to a modern client SPA, decoupled from the Rust backend.
The backend stays the API / PTY / WebSocket server; all UI state lives in the
browser. The existing Rust-rendered HTML pages keep working in parallel during
the migration — nothing here removes or changes them.

**Stack:** Vite + Preact + Wouter (`wouter-preact`) + `@preact/signals`, JSX via
`@preact/preset-vite`.

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
    pages/
      Home.jsx            stub: session list (links into the terminal)
      Terminal.jsx        full-bleed route → TerminalIsland
      Settings.jsx        ported STT speech-provider section
      Install.jsx         stub: points at the existing /install page
    lib/
      api.js              same-origin fetch helpers (proxy adds auth in dev)
      stt.js              STT helpers ported 1:1 from the Rust inline IIFE
```

Build output goes to `web/static/spa/` (git-ignored). Asset base is
`/static/spa/` so the Rust `/static` handler can serve the build verbatim in a
later phase — **not wired into Rust yet.**

## Dev + build commands

From `web/spa/`:

```sh
npm install
# dev server on :5173, proxying to the backend with injected Basic auth:
MOBUX_BACKEND=https://localhost:5152 MOBUX_DEV_AUTH=mvhenten:30879 npm run dev
# open http://localhost:5173/static/spa/
npm run build      # → web/static/spa/
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

- `/ws`, `/r` — PTY + mesh-relay WebSockets (`ws:true`)
- `/api`, `/v1`, `/transcribe`, `/upload` — REST + transcription
- `/sw.js`, `/static` — service worker + existing assets (vendor bundles,
  `terminal.js`, `mesh-client.js`, `style.css`, …)

`/static/spa/` is the SPA's own base; the `/static` proxy rule has a `bypass`
that lets Vite serve everything under `/static/spa/` while still forwarding the
rest of `/static/` to the backend.

## The terminal-island pattern

The existing engine (`/static/terminal.js`) is a side-effecting ES module: on
load it reads `window.MOBUX_SESSION` / `MOBUX_PEER` / `MOBUX_DEV`, binds to a
fixed set of DOM ids (`#terminal`, `#reader`, `#loadquote`, the `#inputBar`
ribbon, the `#cmdPickList` overlay, …), constructs `TerminalCore` (xterm or
sterk), and opens the PTY WebSocket via `window.MobuxMesh.wsUrl()`.

`TerminalIsland.jsx` is purely a host — it does **not** reimplement the engine:

1. Renders the exact DOM scaffold the engine expects (mirrors
   `render_terminal_page` in `src/main.rs`).
2. Sets the window globals.
3. In a **one-time** `useLayoutEffect`, loads the same script chain the Rust
   page loads, in order: renderer-picker → vendor bundle (`xterm.bundle.js` /
   `sterk.bundle.js`) → `mesh-client.js` → `host-picker.js` → `terminal.js`
   (module). All come from the backend through the proxy, so the *real* engine
   bundle runs unchanged.

The effect is guarded so it boots exactly once; Preact never re-renders the
inner subtree (no children, the engine owns it). That is the island contract:
mount once, never re-render the engine.

Reused as-is (the whole point of the island): `terminal-core*.js`, the vendor
bundles, `mesh-client.js`, `host-picker.js`, `style.css`, and all the
gesture/input-bar/reader plumbing those pull in.

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

## Remaining migration phases

1. **Port the other pages** — Home (session list / redesign), Install, and the
   rest of the Settings cards (themes, renderer, notifications, shell
   integration, self-update). Reuse the island for the terminal everywhere.
2. **Mesh / multi-host** — the SPA currently talks to the page's own host only.
   Bring in `MobuxMesh` peer routing (apiFetch rewrite to `/r/<peer>/…`, WS
   `upstream_auth`) so host-pinned sessions and the host picker work in the SPA.
3. **Prod serving in Rust** — serve `web/static/spa/` from the backend (a route
   that returns `index.html` for SPA paths, assets from `/static/spa/`), behind
   the same auth/cache-control as the rest. Decide the mount point and whether
   the SPA replaces or shadows the inline pages per route.
4. **Remove inline HTML** — once a page is fully ported and serving in prod,
   delete its Rust-rendered counterpart and the now-dead inline `<script>` /
   `*.js` it used. The terminal page's inline boot script collapses into the
   island once the SPA owns that route.
5. **Build wiring** — fold `npm run build` (web/spa) into `web/build.js` /
   `make build` so the SPA ships in the binary alongside the vendor bundles.
```
