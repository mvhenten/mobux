# Implementation Plan: TWA Wrapper + Web Push Notifications

**Status**: Draft, 2026-05-01. All non-functional requirements settled.

## Live progress

| Phase | What | Status | PR |
|---|---|---|---|
| 1 | Setup scripts (`bin/setup`, `bin/setup-twa`) | ✅ merged | #14 |
| 2 | SQLite + VAPID state layer | ✅ merged | #13 |
| 3 | Cert layer rewrite (CA + ACME) | ✅ merged | #15 |
| 4 | Service worker rewrite (push-only) | ✅ merged | #12 |
| 5 | Push registration UI + endpoints | ✅ merged | #17 |
| 6 | BEL detection + push delivery | ✅ merged | #19 |
| 7 | Bubblewrap config + `make twa` | ✅ merged | #16 |
| 8 | `/install` page + APK + CA + assetlinks | ✅ merged | #18 |
| 9 | End-to-end smoke test (real device) | 🔄 in progress | — |

**Notes from execution:**
- Phase 5 ruled out the `web-push` crate (transitive openssl-sys); Phase 6 picked `web-push-native` + `reqwest` (rustls), build stays openssl-free.
- `bin/setup-twa` needed three patches during e2e — `set -u` was breaking SDKMAN's and nvm's internal shell functions, and `pipefail` + `yes |` was masking successful installs as failures and triggering an unnecessary fallback that filled the disk on the first attempt. Patches bundled with this PR.
- Phase 9 (e2e) is manual — needs a real Android device on the same network.

---

## Goals

1. **Self-bootstrapping TWA**. Mobux serves its own per-domain Android APK from `/install`, with a QR code for desktop→phone handoff. The same source produces a different APK on every deploy, configured for that deploy's domain.
2. **Web Push notifications**. A terminal BEL (`\x07`) in any PTY stream produces a native Android notification ("session 0: 🔔") that deep-links back to `/s/0`.
3. **Self-bootstrapping certs**. Mobux generates and serves its own root CA by default (LAN-friendly, no domain required), with opt-in ACME / Let's Encrypt for public hosts.
4. **Web UI unchanged for non-install users**. Anyone visiting in any browser still gets the full UI exactly as today; `/install` is opt-in.

## Decisions (locked in — do not relitigate)

- **Target**: Android only. Don't add iOS-Safari fallbacks or hedges.
- **Caching**: cache-light. Service worker has no `fetch` handler. Existing `cache_bust` query param suffices for static assets.
- **Audience**: technical operators on their own boxes. No install banners, no onboarding nudges, no first-run wizards, no "Did you know..." tooltips.
- **State**: SQLite via `rusqlite`. DB at `$MOBUX_DATA_DIR/mobux.db`, default `~/.local/share/mobux/mobux.db`. Hand-rolled `CREATE TABLE IF NOT EXISTS` on boot; no migration framework yet.
- **Build deps**: provisioned via idempotent `bin/setup` (Rust toolchain + clippy + rustfmt) and `bin/setup-twa` (JDK 17, Node, Android command-line tools, `@bubblewrap/cli`). User-local installs (SDKMAN, nvm, npm prefix in `~/.local`); no sudo required.
- **Bell coalescing**: NOT in v1. Fire one notification per BEL. Add coalescing as a follow-up after observing real notification cadence in actual use.
- **OS-side coalescing only**: notifications use a `tag` per session so repeated bells from the same session replace rather than stack. This is free.

---

## Pre-flight (do this before writing code)

The plan below makes assumptions about the codebase. Verify before proceeding; if you find divergences, **update this plan in the same PR — don't proceed silently against stale assumptions.**

- [ ] Read `src/main.rs` end-to-end. Note where `index`, `terminal_page`, the route table, `serve_sw`, `auth_middleware`, and the inline HTML templates live.
- [ ] Read `src/ssl.rs`. Note current cert generation API (`ensure_dev_cert`), how it's called from `main`, and what crates it uses (likely `rcgen`).
- [ ] Read `src/tmux.rs` and `terminal_ws` (the websocket handler in `main.rs`). Note where PTY output is read and forwarded to the websocket — this is where BEL detection will hook in.
- [ ] Read `web/build.js`, `web/static/manifest.json`, the existing `/sw.js` content (whatever `serve_sw` returns), and `web/static/input-bar.js`.
- [ ] Read `Makefile`, `Cargo.toml`, `package.json` for current build wiring.

---

## Phase 1 — Setup scripts (no app changes)

**Goal**: a fresh checkout can run `bin/setup && bin/setup-twa` and end up with everything needed to build mobux and produce a TWA APK.

**Files**:
- `bin/setup` (new). Idempotent. Installs Rust toolchain components: `rustup component add clippy rustfmt`. Anything else mobux needs to build (verify by trying to build on a fresh box).
- `bin/setup-twa` (new). Idempotent. For each tool, detect existing install and skip; otherwise:
  - **JDK 17** via SDKMAN (user-local at `~/.sdkman/`).
  - **Node LTS** via `nvm` (user-local at `~/.nvm/`).
  - **Android command-line tools** to `~/.android/cmdline-tools/`. Accept SDK licenses non-interactively.
  - **`@bubblewrap/cli`** via `npm install -g` with prefix set to `~/.local`.
  - At the end, print PATH/env hints for any user-local installs.
- `Makefile` (edit). Add `setup:` and `setup-twa:` targets that call the scripts.
- `README.md` (edit). Document the two scripts and what they install. Mention they're idempotent.

**Verify**: on a fresh user account (or container), run both scripts. Confirm `bubblewrap --version`, `cargo clippy --version`, `javac -version`, `node --version` all work in a new shell.

---

## Phase 2 — State layer (SQLite + data dir + VAPID keys)

**Goal**: mobux opens a SQLite DB on boot, generates VAPID keys if absent, exposes a typed accessor.

**Crates to add to `Cargo.toml`**:
- `rusqlite = { version = "0.32", features = ["bundled"] }` — `bundled` means no system libsqlite needed.
- `directories = "5"` — for XDG dir resolution.
- `p256 = { version = "0.13", features = ["ecdsa", "pkcs8"] }` — for VAPID keypair generation (ES256, P-256 ECDSA per RFC 8292).
- `base64` — likely already present; needed for base64url encoding of the VAPID public key.

**New module**: `src/db.rs`
- `pub struct Db(Arc<Mutex<rusqlite::Connection>>)`. Mutex is fine — writes are infrequent.
- `Db::open(path: &Path) -> Result<Self>`. Opens the DB, runs `CREATE TABLE IF NOT EXISTS` for the tables below.
- `Db::vapid_keys(&self) -> Result<VapidKeys>`. Returns the existing single row, or generates a new keypair, inserts, and returns.
- `Db::list_subscriptions(&self) -> Result<Vec<Subscription>>`.
- `Db::insert_subscription(&self, sub: NewSubscription) -> Result<()>`. Use `INSERT ... ON CONFLICT(endpoint) DO UPDATE SET last_seen_at = ..., label = COALESCE(?, label)`.
- `Db::remove_subscription(&self, endpoint: &str) -> Result<()>`.

**Schema (initial)**:
```sql
CREATE TABLE IF NOT EXISTS vapid_keys (
  id INTEGER PRIMARY KEY,
  public_key BLOB NOT NULL,    -- raw 65-byte uncompressed P-256 point
  private_key BLOB NOT NULL,   -- raw 32-byte scalar
  created_at INTEGER NOT NULL  -- unix seconds
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh BLOB NOT NULL,
  auth BLOB NOT NULL,
  label TEXT,                  -- user-set device name, optional
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
```

**Wire-up**: `AppState` gains a `db: Arc<Db>` field. Construct in `main()`. `MOBUX_DATA_DIR` env var overrides the default location.

**Verify**: start mobux fresh. Confirm DB file is created at the expected path. Confirm exactly one `vapid_keys` row exists. Restart and confirm the row is the same (key not regenerated).

---

## Phase 3 — Cert layer rewrite (root CA + per-host leaf, with optional ACME)

**Goal**: replace `ssl::ensure_dev_cert` with a CA-backed flow. Default mode generates a long-lived CA + per-host leaf. Opt-in ACME mode uses Let's Encrypt instead.

**Crates**:
- `rcgen` — likely already present in the current `ssl.rs`. Supports CA and leaf signing.
- `instant-acme = "0.7"` — for ACME mode. Tokio-native.
- `time = "0.3"` — date math.

**`src/ssl.rs` rewrite**:
- `ensure_ca() -> Result<(rcgen::Certificate, ...)>`. Reads `~/.config/mobux/ca.crt` + `ca.key` if present (key file mode 0600); else generates a 10-year ECDSA P-256 CA, writes both, returns. Subject CN: `mobux local CA`.
- `issue_leaf(ca, hosts: &[String]) -> Result<(LeafCert, LeafKey)>`. Issues a 90-day leaf cert covering provided hostnames + IPs as SANs. Cache by hosts hash; reissue when expired or hosts change.
- `ensure_certs(extra_hosts: &[String]) -> Result<CertPaths>`. Orchestrator. In default mode: returns paths to CA cert (for the install page to serve), leaf cert, and leaf key. In ACME mode: skips CA, returns ACME-issued cert + key.
- `acme_mode_enabled() -> bool`. True if `MOBUX_ACME_DOMAINS` is set.
- `obtain_acme_cert(...)`. Runs ACME order via `instant-acme`. HTTP-01 challenge served from mobux itself (need `/.well-known/acme-challenge/{token}` route). Caches certs in `~/.config/mobux/acme/`. Spawns a renewal task that wakes every 24h and reissues if <30 days remain.

**Env vars introduced**:
- `MOBUX_CONFIG_DIR` — default `~/.config/mobux/`. (Distinct from `MOBUX_DATA_DIR`: config holds keys; data holds the DB.)
- `MOBUX_ACME_EMAIL` — ACME contact email. Required for ACME mode.
- `MOBUX_ACME_DOMAINS` — comma-separated. Presence turns on ACME mode.
- `MOBUX_ACME_DIRECTORY` — default `https://acme-v02.api.letsencrypt.org/directory`; override for staging during testing.

**Routes added**:
- `/.well-known/acme-challenge/{token}` — only mounted in ACME mode.

**Verify**:
- Default mode: delete `~/.config/mobux/`, start mobux, confirm CA + leaf are generated; visit `/` from a browser that has the CA installed — green padlock.
- ACME mode: with a real domain pointing at the box and ports 80+443 reachable from the internet, set the env vars (use the staging directory first), start mobux, confirm cert is fetched and stored.

---

## Phase 4 — Service worker rewrite (push-only, no caching)

**Goal**: `/sw.js` does only what's needed for Web Push.

**Where**: replace whatever `serve_sw` currently returns. Likely an inline string in `main.rs`. If it grows, move to `web/static/sw.js` and serve as a static file.

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'mobux';
  const options = {
    body: data.body || '',
    tag: data.tag,
    data: { url: data.url || '/' },
    icon: '/static/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((all) => {
      for (const client of all) {
        if (client.url.includes(url)) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
```

No `fetch` handler. No precache. No Workbox.

**Verify**: load app, register the SW from DevTools, send a test push payload via DevTools "Push" — confirm a notification appears, tap deep-links to the URL.

---

## Phase 5 — Push registration UI + endpoints

**Goal**: from inside any session view, the user can enable notifications. Subscription is sent to mobux and stored.

**Crates to add**:
- `web-push = "0.10"` — VAPID-compatible push delivery. **Verify before implementing**: confirm the crate accepts an existing VAPID keypair (raw bytes from the DB) rather than only generating its own. If not, swap to `wpush` or hand-roll JWT signing on top of `p256` + `jsonwebtoken`.

> **Verified during Phase 5 (2026-04-29):**
> - `web-push 0.11` (current) accepts an existing keypair via `VapidSignatureBuilder::from_base64`, which takes the raw 32-byte P-256 scalar base64-encoded — perfect fit for what `db.vapid_keys()` returns.
> - **Blocker for hermetic builds**: `web-push` transitively depends on `ece` → `openssl` → `openssl-sys`, which needs system pkg-config + libssl. Disabling `default-features` does NOT remove the openssl dep, because the http-ece encryption (the load-bearing part) lives in `ece`, not in the optional HTTP client features. Phase 5 therefore did not add `web-push` — the Phase 5 endpoints don't need it.
> - **Recommendation for Phase 6**: hand-roll the push pipeline. The pieces are: (a) JWT signing with `p256` + `jsonwebtoken` for the VAPID auth header, (b) HTTP-ECE encryption of the payload with the `aes-gcm` + `hkdf` + `p256` crates we already pull in transitively, (c) POST via `reqwest` with the existing rustls stack. Avoids dragging openssl into the build. If hand-rolling ECE is too much, evaluate `web-push-native` (RFC8030 only, no openssl) or `wpush` as alternatives.

**New API routes** (in `main.rs`):
- `GET /api/push/vapid-public-key` → `{ key: "<base64url>" }`. Read from DB.
- `POST /api/push/subscribe` → body: `{ endpoint, p256dh, auth, label? }`. Insert/update subscription.
- `DELETE /api/push/subscribe` → body: `{ endpoint }`. Remove subscription.
- `GET /api/push/devices` → `[{ id, label, created_at, last_seen_at }, ...]`. Powers a future "manage devices" UI; not consumed by anything in v1.

**Client JS**: add a small `web/static/push.js` that:
- Detects `'serviceWorker' in navigator && 'PushManager' in window`. If absent, render nothing.
- Adds a "🔔 Notifications" button to the existing input ribbon (coordinate with `web/static/input-bar.js` — pick a spot that doesn't crowd the control characters; possibly in the session menu instead of the ribbon if ribbon space is tight).
- On click (when not subscribed): register SW (`navigator.serviceWorker.register('/sw.js')`), `Notification.requestPermission()`, fetch the VAPID public key, `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <raw bytes> })`, POST to `/api/push/subscribe`. Update button to "🔕".
- On click (when subscribed): unsubscribe locally, DELETE `/api/push/subscribe`. Update button to "🔔".

**Verify**: tap button on phone, accept permission, confirm row in `push_subscriptions`. Disable, confirm row removed.

---

## Phase 6 — BEL detection + push delivery

**Goal**: when any PTY stream emits `\x07`, mobux sends a push to all subscribed devices, deep-linked to the originating session.

**Where to hook**: in `terminal_ws` (main.rs), in the loop that reads from PTY and forwards to the WS. Scan each chunk for `0x07` bytes. If found, fire a push.

**New module**: `src/push.rs`
- `pub async fn notify_bell(db: Arc<Db>, vapid: VapidKeys, session_name: String)`.
  - Loads all subscriptions.
  - Builds payload: `{ title: "mobux", body: format!("session {session_name}: 🔔"), tag: format!("bell-{session_name}"), url: format!("/s/{session_name}") }`.
  - Sends via `web-push` to each endpoint.
  - On `410 Gone` or `404`, calls `db.remove_subscription(endpoint)` — subscription is dead.
  - All other errors: log and continue. Push delivery is best-effort and must never affect the WS loop.

**Wire-up**: in `terminal_ws`, after detecting a BEL byte, `tokio::spawn(notify_bell(...))` so the WS forwarding loop is never blocked. Pass cloned `Arc`s and the session name.

**Verify**: from a session, run `printf '\x07'` (or `echo -e '\a'`). Confirm phone receives notification (with phone locked + screen off — that's the real test). Tap notification → unlocks to the session view at `/s/{name}`.

---

## Phase 7 — PWA manifest tighten + Bubblewrap config + `make twa`

**Goal**: `make twa MOBUX_DOMAIN=mine.example.com` produces a signed APK and the matching `assetlinks.json`.

**Files**:
- `web/static/manifest.json` (edit). Confirm `display: "standalone"`, `start_url: "/"`, `name`, `short_name`, `theme_color`, `background_color`, and `icons` covering 192 and 512 PNGs. Add a 512 icon if missing.
- `twa/twa-manifest.json.template` (new). Bubblewrap config template with `__MOBUX_DOMAIN__` placeholder. Pre-filled fields:
  - `packageId`: `io.github.mvhenten.mobux` (confirmed 2026-05-01). Immutable after first install ships — do not change without acknowledging it's a breaking change for existing users.
  - `name`, `launcherName`, `themeColor`, `backgroundColor`.
  - `startUrl`: `/`.
  - `display`: `standalone`.
  - `iconUrl`: pointing at `/static/icon-512.png`.
  - `enableNotifications`: `true`.
  - Signing key fields: see signing-key durability section below.
- `Makefile` (edit). Add a `twa:` target that:
  1. Errors if `MOBUX_DOMAIN` is unset.
  2. Substitutes the placeholder, writes `twa/twa-manifest.json`.
  3. Runs `bubblewrap init --manifest=twa/twa-manifest.json` (or `bubblewrap update` if `twa/` already initialized).
  4. Runs `bubblewrap build`. Output: `twa/app-release-signed.apk` and the SHA-256 fingerprint of the signing cert.
  5. Copies the APK to `web/static/install/mobux.apk`.
  6. Writes `web/static/.well-known/assetlinks.json` with the package id + signing fingerprint.

**Signing key durability**:
- The signing keystore lives at `~/.config/mobux/twa-signing.keystore` — **not in the repo**.
- On first `make twa` run, generate the keystore if absent. Print a clear "BACK THIS UP" warning with the path.
- The keystore password is read from `MOBUX_TWA_KEYSTORE_PASSWORD`. If unset, on first run generate a random one and write it to `~/.config/mobux/twa-signing.password` (mode 0600). Subsequent runs read from there if the env var is unset.
- If the key is lost, the next-built APK has a different fingerprint and existing installations cannot upgrade — only fresh-install. Document this in the README.

**Verify**:
- `make twa MOBUX_DOMAIN=mine.example.com`. Confirm APK + assetlinks.json land in expected paths.
- Confirm fingerprint in assetlinks.json matches `keytool -list -v -keystore ~/.config/mobux/twa-signing.keystore`.

---

## Phase 8 — `/install` page + APK + assetlinks + CA serving

**Goal**: users hit `/install`, get a single page that lets them download the APK and (in self-signed mode) the CA cert, with QR codes for desktop→phone handoff.

**Crates to add**:
- `qrcode = "0.14"` — generate SVG QR codes server-side.

**Routes added**:
- `GET /install` → handler `install_page` (HTML).
- `GET /install/mobux.apk` → serves `web/static/install/mobux.apk` from disk. 404 if not built.
- `GET /install/mobux-ca.crt` → serves the CA cert (Android wants DER for `.crt` extension; verify on a real device).
- `GET /.well-known/assetlinks.json` → serves `web/static/.well-known/assetlinks.json`.

**`install_page` handler**: returns inline HTML containing:
- **"Install the app"** section: APK download button + an inline SVG QR code encoding the absolute URL `https://{host}/install/mobux.apk` (server gets host from the `Host` header). Both controls always visible — no UA-based hiding. Show desktop QR more prominently if `User-Agent` looks like a desktop browser; show button more prominently on mobile. (Trivial CSS reorder.)
- **"Trust the certificate"** section: only rendered in self-signed mode (skip entirely in ACME mode). CA download button + QR code, plus 3 plain lines on how to install the cert in Android settings (Settings → Security → Encryption & credentials → Install a certificate → CA certificate).
- **APK missing**: if `web/static/install/mobux.apk` does not exist, the "Install the app" section instead shows: `Run \`make twa MOBUX_DOMAIN={host}\` on the server to enable.`

**Verify**:
- Visit `/install` from desktop browser; scan QR with phone; confirm phone downloads correct APK from correct URL.
- Visit `/install` directly from phone; confirm both buttons download the right files.
- After installing CA + APK on phone, launch the TWA app — confirm fullscreen, no Chrome chrome, correct theme color.

---

## Phase 9 — End-to-end smoke test

This is the gate before declaring done.

- [ ] Fresh box, fresh checkout. Run `bin/setup && bin/setup-twa`. Both succeed.
- [ ] Pick a domain (LAN IP fine for self-signed). Run `make twa MOBUX_DOMAIN=192.168.1.50:5151`. APK + assetlinks land in `web/static/`.
- [ ] `make start`.
- [ ] On phone (same LAN), visit `https://192.168.1.50:5151/install`. Install CA. Install APK.
- [ ] Open the TWA app. Lands on session list. Fullscreen. No browser chrome. Correct theme color.
- [ ] Open a session. Tap "🔔". Accept the permission prompt.
- [ ] In the session, run `echo -e '\a'`. Lock the phone.
- [ ] Confirm a notification arrives on the lock screen.
- [ ] Tap the notification. Phone unlocks straight to `/s/{session}` in the TWA app.
- [ ] Edit some JS in `web/static/`. Run `make build && make restart`. Reopen the TWA app. Confirm new JS is served (no APK reinstall needed). This is the dev-loop guarantee.

---

## Out of scope (explicit non-goals for v1)

- Bell coalescing / per-session mute (deferred — design after observing real cadence).
- "Manage devices" UI. The `devices` endpoint and DB table are built; the UI is v2.
- iOS support of any kind.
- Service worker offline support, app-shell caching, precache manifests.
- Auto-detection of Bubblewrap availability for in-process APK builds. Manual `make twa` for v1.
- Play Store distribution.
- Multi-tenant / multi-user mobux. Single-user assumption holds throughout.
- Push payload size optimization or batching.

## Risks & open questions for the implementing agent

- **`web-push` crate**: confirm it accepts an existing VAPID keypair from raw bytes before committing to it. If not, swap or hand-roll. Check before Phase 5.
- **ACME requires reachable HTTP**: HTTP-01 needs port 80 reachable from Let's Encrypt. If that's not available, document DNS-01 as a future option but don't implement.
- **Android user-CA trust**: TWA-via-Custom-Tabs should respect user-installed CAs (Chrome trust store). Verify on a real Android device before declaring Phase 3 done. If broken, the fallback is "ACME mode required" — document and move on.
- **PTY chunk boundaries**: a BEL byte could in principle land at a chunk boundary. Scanning each chunk independently is fine because BEL is a single byte. No multi-byte sequences to worry about.
- **Notification flood at session boot**: some shells / programs emit BEL on startup. Test what happens when reattaching to an already-running session and decide if that's OK.
