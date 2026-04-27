# Mobux — Agent Notes

## What is this
Touch-friendly tmux web UI in Rust (axum). Access tmux sessions from a phone over Tailscale with HTTPS.

## Architecture
- **Server**: Rust/axum with built-in self-signed SSL (rcgen) or external certs. Serves static files + WebSocket PTY.
- **Terminal**: xterm.js in browser, connected to `tmux attach-session` via PTY over WebSocket.
- **Touch layer**: `#touchOverlay` div captures all touch events via a state machine gesture recognizer. Mouse passes through (`pointer-events: none`).
- **Frontend modules**:
  - `terminal.js` — orchestration (xterm setup, WebSocket, callbacks)
  - `touch.js` — gesture state machine (`IDLE→TAP→SCROLL|HSWIPE|LONGPRESS`, `TWO→PINCH|TWOPULL`)
  - `scroll.js` — pure scroll physics (velocity, momentum, decay)
  - `input.js` — mobile input adapter for autocomplete/voice dictation
- **PWA**: manifest.json + service worker for standalone app install on mobile

## Critical xterm.js integration details

### Mouse protocol must be locked to NONE
tmux sends `\x1b[?1000h` (mouse enable) which makes xterm.js enter mouse-capture mode. This **disables xterm.js's native touch scrolling**. We override:
```js
Object.defineProperty(term._core.coreMouseService, 'activeProtocol', {
  set() {}, get() { return 'NONE'; }, configurable: true,
});
```

### Alternate screen must be blocked
tmux uses alternate screen (`\x1b[?1049h`) which has no scrollback. We block it so all output stays in the main buffer:
```js
const buffers = term._core._bufferService.buffers;
buffers.activateAltBuffer = () => {};
buffers.activateNormalBuffer = () => {};
```

### Scrolling uses term.scrollLines()
Scroll deltas from touch gestures are converted from pixels to lines via `cellHeight` and sent through `term.scrollLines(n)` — xterm.js public API. Previous approach using synthetic `WheelEvent` dispatch was fragile and removed.

### Scrollback after window switch
After switching tmux windows, `term.clear()` wipes scrollback. tmux only sends the visible screen via PTY. We re-fetch history via `/api/sessions/{name}/history` after every window switch to restore scrollback.

### Mobile input adapter (`input.js`)
Intercepts `beforeinput` events on xterm's hidden textarea to handle mobile autocomplete. Only intercepts `insertReplacementText` — all other input flows through xterm.js unmodified. Tracks a shadow buffer of sent characters to compute diffs for autocomplete replacements. Also tracks `insertCompositionText` for voice dictation sync.

### Link detection
xterm-addon-web-links provides hover highlighting on desktop. On mobile, single tap reads the terminal buffer text at the tapped row/col via `term.buffer.active.getLine()`, regex-matches URLs, and opens in a new tab.

## Gestures
| Gesture | Action |
|---|---|
| Single tap on URL | Open link in new tab |
| Vertical swipe | Scroll (with momentum/flick) |
| Horizontal swipe | Switch tmux window (next/prev) |
| Double tap | Focus keyboard (drops overlay 500ms, dispatches click to xterm) |
| Long press (~600ms) | Open tmux command menu |
| Two-finger pinch | Font size zoom (8-32px) |
| Two-finger pull down | Reload page |

## Touch overlay pattern
The `#touchOverlay` div sits on top of xterm at `z-index: 10`. It has `pointer-events: none` for mouse but `pointer-events: auto` for touch devices. The gesture recognizer (`touch.js`) is a single state machine with explicit states — no competing listeners.

## Loading screen
- Quote div at `z-index: 5` — **below** touch overlay (`z-index: 10`). Never put it above.
- Debounced reveal: 800ms of data silence → `scrollToBottom()` → show terminal → fade out quote.

## Build & run
```bash
make start    # build + start on port 5151
make restart  # stop + start
make stop
make status
make test     # playwright e2e tests
make logs     # tail server log
```

Use `.envrc` for local credentials (not committed):
```bash
export MOBUX_USER=yourname
export MOBUX_PIN=yourpin
export MOBUX_PASS=yourpin
```

## Environment variables
| Variable | Description | Default |
|---|---|---|
| `MOBUX_AUTH_USER` | Auth username | (disabled) |
| `MOBUX_AUTH_PASS` | Auth password | (disabled) |
| `MOBUX_PIN` | PIN-only auth (username defaults to 'mobux') | (disabled) |
| `PORT` | Listen port | 8080 |
| `MOBUX_TLS` | Enable HTTPS (`0` to disable) | true |
| `MOBUX_TLS_HOSTS` | Extra SANs (comma-separated) | |
| `MOBUX_CERT_FILE` | External cert PEM path | (auto-generated) |
| `MOBUX_KEY_FILE` | External key PEM path | (auto-generated) |
| `MOBUX_CERT_DIR` | Cert cache directory | `~/.local/share/mobux/ssl/` |

## Cargo build caching gotcha
When editing HTML in `main.rs` format strings, `cargo build` may not detect the change. Use `cargo clean -p mobux && cargo build` to force recompile.

## Tests
`test/smoke.spec.cjs` — Playwright e2e tests (8 tests). Covers: page load, API, terminal rendering, touch scroll, window switching (swipe + API), gesture-to-scroll, and URL link detection. Run with `make test`. CI runs on every push and PR via GitHub Actions.

## CI
GitHub Actions (`.github/workflows/ci.yml`):
- `check`: cargo check + clippy
- `e2e`: build, start tmux + server, run Playwright tests
- Both required before release-plz creates release PRs
