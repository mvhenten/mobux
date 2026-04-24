# Mobux — Agent Notes

## What is this
Touch-friendly tmux web UI in Rust (axum). Access tmux sessions from a phone over Tailscale with HTTPS.

## Architecture
- **Server**: Rust/axum with built-in self-signed SSL (rcgen). Serves static files + WebSocket PTY.
- **Terminal**: xterm.js in browser, connected to `tmux attach-session` via PTY over WebSocket.
- **Touch layer**: Transparent `#touchOverlay` div captures all touch events. Mouse passes through (`pointer-events: none`). Touch gestures are translated to synthetic `WheelEvent`s dispatched on xterm.js's `.xterm` element, so xterm.js's own `handleWheel` does the scrolling.

## Critical xterm.js integration details

### Mouse protocol must be locked to NONE
tmux sends `\x1b[?1000h` (mouse enable) which makes xterm.js enter mouse-capture mode. This **disables xterm.js's native touch scrolling** (`handleTouchStart`/`handleTouchMove` are gated on `!coreMouseService.areMouseEventsActive`). We override:
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

### Touch overlay pattern
The `#touchOverlay` div sits on top of xterm at `z-index: 10`. It has `pointer-events: none` for mouse (wheel/click pass through to xterm.js) but `pointer-events: auto` for touch devices. All touch gesture handling happens on this overlay — xterm.js never sees touch events. This is the only reliable way to prevent xterm.js from interfering with touch gestures.

### Scroll physics
Modeled after iOS UIScrollView / BetterScroll:
- Velocity: averaged over last 100ms of position samples
- Decay: 0.998 per ms (iOS UIScrollViewDecelerationRateNormal)
- Deceleration: 0.0015 px/ms² (BetterScroll)
- Max momentum: 2500ms
- Finger amplification: 2.5x

## Gestures
| Gesture | Action |
|---|---|
| Vertical swipe | Scroll (with momentum/flick) |
| Horizontal swipe | Switch tmux window (next/prev) |
| Double tap | Focus keyboard (drops overlay 500ms, dispatches click to xterm) |
| Two-finger pinch | Font size zoom (8-32px, 25% scale threshold) |
| Two-finger pull down | Reload page (60px threshold) |

## Loading screen
- Shows random CS quote while tmux dumps scrollback on attach
- Debounced reveal: waits 800ms of data silence, then `scrollToBottom()` + remove loading div
- No history pre-fill API needed — tmux sends scrollback via PTY on attach

## tmux settings applied on attach
```bash
tmux set-option -g mouse on       # desktop mouse support (stripped by xterm overrides)
tmux set-window-option -g aggressive-resize on  # resize to active client
```

## WebSocket reconnect
- `reconnect()` called on every `touchstart` on the overlay
- Closes stale socket, creates fresh connection
- Silent close/error handlers (no "disconnected" message)

## Build & run
```bash
make start    # build + start on port 5151
make restart  # stop + start
make stop
make status
make test     # smoke test with puppeteer
make logs     # tail server log
```

Environment: `MOBUX_AUTH_USER`, `MOBUX_PIN`, `MOBUX_PORT` (default 5151), `MOBUX_CERT_DIR`.

## Cargo build caching gotcha
When editing HTML in `main.rs` format strings, `cargo build` may not detect the change. Use `cargo clean -p mobux && cargo build` to force recompile.

## Branch structure
- `main` — protected, requires CI pass
- `fix/restore-working-touch` — current working branch (restored from known-good 8804642)
- Commits from another pi session (`527ab47`, `fd9827d`, `62367fe`) added features that conflicted with touch gestures. These were reverted.

## Smoke test
`test/smoke.cjs` — puppeteer headless test. Checks: index loads, API works, xterm renders, loading screen removed, touch overlay present, WebSocket delivers content. Run with `make test`.
