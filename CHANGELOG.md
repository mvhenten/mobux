# Changelog

All notable changes to this project will be documented in this file.
## [0.1.3] - 2026-06-06

### 🚀 Features

- *(input)* Attach any file + audio record button ([#119](https://github.com/mvhenten/mobux/pull/119))
- Local audio transcription helper (whisper.cpp) ([#121](https://github.com/mvhenten/mobux/pull/121))

### 🐛 Bug Fixes

- Don't 500 the session list when no tmux server is running ([#122](https://github.com/mvhenten/mobux/pull/122))


## [0.1.2] - 2026-06-03

### 🚀 Features

- *(twa)* Parameterize build for a separate Mobux Dev app ([#118](https://github.com/mvhenten/mobux/pull/118))
- *(touch)* Tablet input bar, /clear /quit, swipe-up menu, de-emoji menu ([#115](https://github.com/mvhenten/mobux/pull/115))

### 📚 Documentation

- Deployment + dev runbook in-repo (DEPLOY.md, AGENTS.md) ([#116](https://github.com/mvhenten/mobux/pull/116))


## [0.1.1] - 2026-06-03

### 🚀 Features

- Loading screen with CS quotes, debounced reveal
- Loading screen with CS quotes (z-index below touch overlay)
- Pinch-to-zoom font size (8-32px)
- Pinch-to-zoom font size with three-phase gesture classifier
- Loading screen with CS quotes
- Tmux command pick list with long-press gesture
- PWA support for standalone app install
- Support MOBUX_CERT_FILE and MOBUX_KEY_FILE env vars
- Clickable links in terminal
- Tap-to-open URLs in terminal on mobile
- Mobile input bar with control ribbon + text input
- Two-mode send (execute vs inject) on mobile input bar
- Image upload from mobile to terminal
- Mobile-native home screen with swipe gestures
- Session rename via swipe + API
- *(ribbon)* Add Enter key for interactive TUI apps ([#10](https://github.com/mvhenten/mobux/pull/10))
- *(setup)* Add idempotent bin/setup and bin/setup-twa ([#14](https://github.com/mvhenten/mobux/pull/14))
- *(state)* Add SQLite + VAPID key persistence ([#13](https://github.com/mvhenten/mobux/pull/13))
- *(ssl)* Replace dev cert with root CA + per-host leaf, add ACME mode ([#15](https://github.com/mvhenten/mobux/pull/15))
- *(twa)* Add Bubblewrap manifest template + make twa target ([#16](https://github.com/mvhenten/mobux/pull/16))
- *(push)* Add VAPID + subscription endpoints + client registration UI ([#17](https://github.com/mvhenten/mobux/pull/17))
- *(push)* Deliver Web Push on terminal BEL ([#19](https://github.com/mvhenten/mobux/pull/19))
- *(install)* Add /install page with APK + CA download and QR codes ([#18](https://github.com/mvhenten/mobux/pull/18))
- *(push)* Add POST /api/push/notify for arbitrary callers ([#29](https://github.com/mvhenten/mobux/pull/29))
- *(push)* Vibrate + badge on notification ([#30](https://github.com/mvhenten/mobux/pull/30))
- *(notifications)* Settings page + per-trigger preferences ([#31](https://github.com/mvhenten/mobux/pull/31))
- *(chime)* Play a high-C bell on push notifications ([#32](https://github.com/mvhenten/mobux/pull/32))
- *(web)* Swappable reader view (proportional, native scroll) with long-press toggle ([#33](https://github.com/mvhenten/mobux/pull/33))
- *(reader)* Streaming tokenizer with colour and block detection ([#35](https://github.com/mvhenten/mobux/pull/35))
- *(reader)* Synthetic viewport stack (combines #36 #37 #38) ([#39](https://github.com/mvhenten/mobux/pull/39))
- *(ui)* Move view toggle into input ribbon, drop push toggle ([#41](https://github.com/mvhenten/mobux/pull/41))
- *(reader)* OSC 133 shell-integration for deterministic prompt detection ([#45](https://github.com/mvhenten/mobux/pull/45))
- *(reader)* Replace xterm.js with aceterm (libterm + Ace renderer) ([#50](https://github.com/mvhenten/mobux/pull/50))
- *(theme)* Add theme selector with 4 paired bundles ([#61](https://github.com/mvhenten/mobux/pull/61))
- Remove reader mode, terminal is the only view ([#64](https://github.com/mvhenten/mobux/pull/64))
- *(settings)* One-click OSC 133 shell integration installer ([#54](https://github.com/mvhenten/mobux/pull/54))
- *(shell)* Inject OSC 133 at session creation for OOTB support ([#72](https://github.com/mvhenten/mobux/pull/72))
- Replace vendored aceterm with @kattebak/sterk ([#71](https://github.com/mvhenten/mobux/pull/71))
- Replace vendored aceterm with @kattebak/sterk (retry on top of #75 safety net) ([#77](https://github.com/mvhenten/mobux/pull/77))
- *(listen)* Add speaker icons and speech synthesis to reader-view ([#74](https://github.com/mvhenten/mobux/pull/74))
- *(font)* Wire sterk's vendored TUI fonts via CSS @font-face ([#93](https://github.com/mvhenten/mobux/pull/93))
- *(terminal)* Dual renderer — xterm.js (default) + sterk (experimental) ([#94](https://github.com/mvhenten/mobux/pull/94))
- *(terminal)* Dual renderer with xterm/sterk CI matrix (relands #94, closes #95) ([#97](https://github.com/mvhenten/mobux/pull/97))
- *(terminal)* Snap viewport to bottom on input focus (closes #99) ([#100](https://github.com/mvhenten/mobux/pull/100))
- *(stt)* Local CPU speech-to-text — POST /transcribe + mic dictation button ([#101](https://github.com/mvhenten/mobux/pull/101))
- *(terminal)* Auto-reconnect on visibility/online/pageshow + onclose backoff ([#105](https://github.com/mvhenten/mobux/pull/105))
- *(links)* Open external links in system default browser from TWA ([#73](https://github.com/mvhenten/mobux/pull/73))
- *(themes)* Add Solarized Light, Gruvbox Light, GitHub Light ([#107](https://github.com/mvhenten/mobux/pull/107))
- *(install)* Home-screen install hint + Settings link ([#108](https://github.com/mvhenten/mobux/pull/108))
- Embed web frontend in the binary (cargo install-able) ([#110](https://github.com/mvhenten/mobux/pull/110))

### 🐛 Bug Fixes

- Restore working touch/scroll from 8804642
- Fully revert main.rs and tmux.rs to known-good 8804642
- Remove toolbar space reservation, add reconnect on touch
- Remove visibility:hidden on terminal - broke wheel events
- Disable touch overlay when command sheet is open
- Append colon to tmux session targets in command API
- Swipe left/right sends tmux next/prev directly
- Add fallback route redirecting unknown paths to /
- Clear scrollback on window switch to prevent cross-pane content
- Clear scrollback on window switch (swipe + command sheet)
- Restore original alt buffer and scroll behavior
- Reload scrollback history after window switch
- Serve service worker from root for proper PWA scope
- Simplify input adapter — stop interfering with composition
- Track insertCompositionText in shadow buffer for voice dictation
- Remove hardcoded credentials from tests and Makefile
- Mobile autocomplete/autocorrect input adapter
- Restore missing style.css link on terminal page
- *(setup-twa)* Keep -u relaxed for nvm/sdk; ignore yes| SIGPIPE ([#20](https://github.com/mvhenten/mobux/pull/20))
- *(twa)* Make the build pipeline actually run end-to-end ([#21](https://github.com/mvhenten/mobux/pull/21))
- *(install)* Lead with the CA cert, spell out the Android steps ([#22](https://github.com/mvhenten/mobux/pull/22))
- *(auth)* Persist the session cookie across restarts ([#24](https://github.com/mvhenten/mobux/pull/24))
- *(push)* Public /sw.js + surface errors on bell toggle ([#25](https://github.com/mvhenten/mobux/pull/25))
- *(push)* Deep-link to Android notification settings on denied ([#26](https://github.com/mvhenten/mobux/pull/26))
- *(push)* Correct intent URL for Android settings deep-link ([#27](https://github.com/mvhenten/mobux/pull/27))
- *(push)* Drop intent deep-link, show manual instructions ([#28](https://github.com/mvhenten/mobux/pull/28))
- *(reader)* Restore touch gestures in reader view ([#34](https://github.com/mvhenten/mobux/pull/34))
- *(reader)* Strip trailing whitespace from last run regardless of attrs ([#40](https://github.com/mvhenten/mobux/pull/40))
- *(reader)* Clear load splash on first data event, not on 800ms settle ([#51](https://github.com/mvhenten/mobux/pull/51))
- *(input-bar)* Keep bar above on-screen keyboard via visualViewport ([#52](https://github.com/mvhenten/mobux/pull/52))
- *(terminal)* Readable fg on explicit bg when fg is default ([#55](https://github.com/mvhenten/mobux/pull/55))
- *(input-bar)* Shrink layout to visual viewport when keyboard is up ([#56](https://github.com/mvhenten/mobux/pull/56))
- *(terminal)* Apply muted base16 palette + bump scrollback ([#57](https://github.com/mvhenten/mobux/pull/57))
- *(input-bar)* Re-pin reader to bottom synchronously on keyboard show ([#58](https://github.com/mvhenten/mobux/pull/58))
- *(input-bar)* Make bar a flex item to stop overlap with terminal/reader ([#59](https://github.com/mvhenten/mobux/pull/59))
- *(terminal)* Pick default fg by bg luminance, not always-dark ([#60](https://github.com/mvhenten/mobux/pull/60))
- *(layout)* Use 100dvh for term-body so content clears Android nav bar ([#62](https://github.com/mvhenten/mobux/pull/62))
- *(terminal)* Open tapped URLs via anchor click so TWA hands off to Custom Tabs ([#63](https://github.com/mvhenten/mobux/pull/63))
- *(shell-integration)* Wrap OSC 133 in tmux DCS passthrough ([#66](https://github.com/mvhenten/mobux/pull/66))
- *(terminal)* Remove unnecessary row subtraction that clips tmux status line ([#69](https://github.com/mvhenten/mobux/pull/69))
- *(terminal)* Force Ace re-measure on Android keyboard resize ([#79](https://github.com/mvhenten/mobux/pull/79))
- *(terminal)* Consume local sterk with ResizeObserver fix (temporary) ([#82](https://github.com/mvhenten/mobux/pull/82))
- *(terminal)* Cell-width parity (V8 — no left gutter, no right clipping) ([#83](https://github.com/mvhenten/mobux/pull/83))
- *(terminal)* Bottom rows no longer clipped when input bar appears ([#88](https://github.com/mvhenten/mobux/pull/88))
- *(terminal)* VisualViewport-aware host sizing + keyboard regression test ([#98](https://github.com/mvhenten/mobux/pull/98))
- *(terminal)* Snap viewport to bottom on tap, not focus (closes #99) ([#103](https://github.com/mvhenten/mobux/pull/103))
- *(test)* De-flake sticky-to-bottom smoke test (closes #85) ([#106](https://github.com/mvhenten/mobux/pull/106))
- *(cache)* Serve HTML and sw.js with no-store + per-restart version ([#78](https://github.com/mvhenten/mobux/pull/78))
- *(push)* Bell triggers via tmux alert-bell hook, drop WS-side scan ([#43](https://github.com/mvhenten/mobux/pull/43))

### 🔧 Refactor

- Use term.scrollLines() instead of dispatching WheelEvents
- Split touch/scroll into state machine with separate modules
- Use term.scrollLines() instead of synthetic WheelEvent
- *(sw)* Minimal push-only service worker ([#12](https://github.com/mvhenten/mobux/pull/12))
- *(stt)* Remove local CPU speech-to-text (sherpa-rs) ([#109](https://github.com/mvhenten/mobux/pull/109))

### 📚 Documentation

- Add screenshots to README from assets branch
- Add AGENTS.md with architecture and integration notes
- Note loading screen breaks touch scrolling
- Update AGENTS.md with loading screen solution
- Add context.txt with feature specs for next session
- Rewrite AGENTS.md and README.md
- Rewrite README with screenshots, update for v0.3.0
- TWA + Web Push implementation plan ([#11](https://github.com/mvhenten/mobux/pull/11))
- *(readme)* Document the install flow and the actual TWA build ([#23](https://github.com/mvhenten/mobux/pull/23))

### 🎨 Styling

- *(terminal)* Match xterm font to reader's mono stack ([#46](https://github.com/mvhenten/mobux/pull/46))
- *(reader+xterm)* Match xterm typography to reader, fix double-tap ([#48](https://github.com/mvhenten/mobux/pull/48))

### 🧪 Testing

- Playwright smoke tests with mobile emulation + touch scroll
- Add window switching tests (API + swipe gesture)
- Critical-path Playwright tests covering real PTY pipe ([#75](https://github.com/mvhenten/mobux/pull/75))

### ⚙️ Miscellaneous

- Smoke-* + podman-* targets, isolated test runs ([#44](https://github.com/mvhenten/mobux/pull/44))
- *(quotes)* Add contemporary computing voices to the loading screen ([#47](https://github.com/mvhenten/mobux/pull/47))
- *(test)* Isolate smoke tests from host tmux/HOME/history ([#53](https://github.com/mvhenten/mobux/pull/53))
- *(sterk)* Bump vendored tarball — unicode + themes + D4 baselines ([#87](https://github.com/mvhenten/mobux/pull/87))
- *(sterk)* Bump vendored tarball — viewport-pin-to-live-screen fix ([#89](https://github.com/mvhenten/mobux/pull/89))
- *(sterk)* Bump vendored tarball — restore SGR colours + bold ([#90](https://github.com/mvhenten/mobux/pull/90))
- *(sterk)* Bump vendored tarball — fix tmux status bar duplicates ([#92](https://github.com/mvhenten/mobux/pull/92))

### 👷 CI

- Replace manual publish with release-plz semantic releases
- Add Playwright e2e tests to PR checks
- Self-heal missing sherpa-onnx libs on warm target/ cache ([#104](https://github.com/mvhenten/mobux/pull/104))

### Build

- Bundle patched @xterm/xterm v6 with esbuild

### Remove

- Custom voice input (SpeechRecognition API)

### Revert

- Loading screen broke scrolling, back to fb6c0e8 state
- Back to fb6c0e8 known-good state
- Restore WheelEvent dispatch for scrolling

