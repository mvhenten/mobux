# Deploying mobux

mobux runs as a **single self-contained binary**: the entire `web/static`
frontend is embedded with `rust-embed`, so the executable serves the UI from
memory and needs no `web/` directory beside it. That makes `cargo install`
the whole deployment story.

The production instance is a **systemd user service** on `:5151`, running the
**published, installed binary** — completely decoupled from the dev checkout.
Hack on the repo all you want; it does not touch the running app until you
deliberately `cargo install` a new version and restart the service.

> ⚠️ `:5151` is the live instance accessed from the phone. Never run
> `make run` / `make start` / `make restart` against it — those launch a
> nohup process that fights the service's `Restart=always`. See
> [Development](#development-never-touch-5151) below.

## Install

Prebuilt Linux x86_64 binary from the GitHub release (seconds, no compile;
every release ships `mobux-x86_64-unknown-linux-gnu.tar.gz` + a `.sha256`
checksum file as assets):

```bash
curl -fsSLO https://github.com/mvhenten/mobux/releases/latest/download/mobux-x86_64-unknown-linux-gnu.tar.gz
curl -fsSLO https://github.com/mvhenten/mobux/releases/latest/download/mobux-x86_64-unknown-linux-gnu.tar.gz.sha256
sha256sum -c mobux-x86_64-unknown-linux-gnu.tar.gz.sha256
tar -xzf mobux-x86_64-unknown-linux-gnu.tar.gz -C ~/.cargo/bin mobux
```

From crates.io (released versions; 5-10 min release-mode compile):

```bash
cargo install mobux --locked
```

Straight from GitHub (latest `main`, including unreleased commits):

```bash
cargo install --git https://github.com/mvhenten/mobux --locked
# or a specific point:  --tag v0.1.1   /   --branch some-branch
```

`cargo install` always builds the release profile, so the result is the
self-contained binary at `~/.cargo/bin/mobux`. It runs from any directory.

## Configuration

`mobux --help` lists every flag and every environment variable. A flag wins over
the variable next to it, which wins over the config file, which wins over the
defaults. The file is `config.json` in the config directory: `MOBUX_CONFIG_DIR`,
else `$XDG_CONFIG_HOME/mobux`, else `~/.config/mobux`. `--config PATH` names
another file.

Anything on the command line is visible to other users in the process list, so a
long-running instance keeps its PIN in the config file or in `MOBUX_PIN`.

### Config reference

| Config key | Environment | Flag | Default | What it sets |
|---|---|---|---|---|
| `server.port` | `MOBUX_PORT` | `--port` | `8080` | TCP port to listen on |
| `server.base_path` | `MOBUX_BASE_PATH` | `--base-path` | site root | Path prefix a reverse proxy publishes mobux under, e.g. `/mobux` |
| `server.behind_tls_proxy` | `MOBUX_BEHIND_TLS_PROXY` | `--behind-tls-proxy` | `false` | Trust a reverse proxy to terminate TLS |
| `auth.user` | `MOBUX_AUTH_USER` | `--user` | unset | Username that unlocks the web UI |
| `auth.pass` | `MOBUX_AUTH_PASS` | `--pass` | unset | Password that unlocks the web UI |
| `auth.pin` | `MOBUX_PIN` | `--pin` | unset | PIN that unlocks the web UI, 4 to 64 characters |
| `tls.enabled` | `MOBUX_TLS` | `--tls` | `false` | Serve HTTPS with a generated certificate |
| `tls.hosts` | `MOBUX_TLS_HOSTS` | `--tls-host` | empty | Extra hostnames on the generated certificate |
| `tls.cert_file` | `MOBUX_CERT_FILE` | `--cert-file` | unset | Certificate PEM to serve instead of a generated one |
| `tls.key_file` | `MOBUX_KEY_FILE` | `--key-file` | unset | Private key PEM matching the certificate |
| `tls.acme_domains` | `MOBUX_ACME_DOMAINS` | `--acme-domain` | empty | Domains to obtain an ACME certificate for. A non-empty list switches TLS into ACME mode |
| `tls.acme_email` | `MOBUX_ACME_EMAIL` | `--acme-email` | unset | Account contact for the ACME directory. Required in ACME mode |
| `tls.acme_directory` | `MOBUX_ACME_DIRECTORY` | `--acme-directory` | `https://acme-v02.api.letsencrypt.org/directory` | ACME directory URL |
| `tls.acme_http_port` | `MOBUX_ACME_HTTP_PORT` | `--acme-http-port` | `80` | Port the HTTP-01 challenge responder binds |
| `paths.data_dir` | `MOBUX_DATA_DIR` | `--data-dir` | `~/.local/share/mobux` | Directory for the database and other state |
| `session.shell` | `MOBUX_SESSION_SHELL` | `--shell` | `$SHELL`, else `/bin/bash` | Shell to launch inside tmux |
| `app.domain` | `MOBUX_DOMAIN` | `--domain` | unset | Public `host` or `host:port` the Android app is pinned to |
| `app.dev` | `MOBUX_DEV` | `--dev` | `false` | Dev mode, reported through `/api/build-info` |
| `app.service_name` | `MOBUX_SERVICE_NAME` | `--service-name` | `mobux` | systemd unit the self-updater restarts |
| `push.vapid_contact` | `MOBUX_VAPID_CONTACT` | `--vapid-contact` | `mailto:admin@example.com` | VAPID contact, a `mailto:` address or an `https://` URL |
| `update.check_url` | `MOBUX_UPDATE_CHECK_URL` | `--update-check-url` | `https://index.crates.io/mo/bu/mobux` | Where the version list is fetched from |

Config keys nest. `server.port` is `{"server": {"port": 5151}}`, and only the
keys a file states override a default.

Toggles take `--flag` to turn on and `--no-flag` to turn off. `--flag=` also
takes `1`, `true`, `yes`, `on`, `0`, `false`, `no` and `off`. `MOBUX_TLS` reads
any value other than `0` and `false` as on; every other toggle variable wants
`1` or `true`.

List flags repeat, or take one comma-separated value. Their environment
variables are comma separated.

### The schema

`mobux configure --schema` prints the JSON schema for `config.json`. The same
document is committed at [`docs/mobux.schema.json`](docs/mobux.schema.json); no
route serves it. `mobux configure --check [PATH]` validates a file and reports
what is wrong with it, naming the key and, for a near miss, the spelling it
expected. The loader rejects any key it does not know, `$schema` included, so
the file carries no schema pointer of its own.

### Environment only

These four have no config-file key.

| Variable | What it does |
|---|---|
| `PORT` | Deprecated alias for `MOBUX_PORT`. The server warns at startup: `PORT is deprecated; rename it to MOBUX_PORT` |
| `MOBUX_CONFIG_DIR` | Directory holding `config.json`, ahead of `$XDG_CONFIG_HOME/mobux` and `~/.config/mobux` |
| `MOBUX_UPDATE_DISABLE_RUN` | Refuses the in-app update on this host |
| `MOBUX_TMUX_SOCKET` | Names a dedicated tmux server socket, for test isolation |

mobux resolves the listen port as `--port`, `MOBUX_PORT`, `PORT`, then `8080`.

## Run as a boot-persistent service (`:5151`)

The host runs mobux as a **systemd `--user`** service with linger enabled, so
it starts on boot (no login needed) and restarts on crash — no root required.

`mobux service install --port 5151 --user me --pin 12345` does all of this for
you: it writes those settings to `~/.config/mobux/config.json` (mode 600, since
it holds the PIN), writes the unit below pointing at the binary you ran it from
and at that file, reloads systemd, enables the service and turns on linger.
`--config PATH` puts the settings somewhere else and points the unit there.
Run it as the user the service belongs to — under `sudo` it is refused, since
it would install a second service for root; `--allow-root` is there for a
deliberate root install, and `sudo loginctl enable-linger "$USER"` covers the
one step polkit may deny. Behind a proxy that authenticates for mobux, pass
`--no-auth` instead of `--user`/`--pin`: the config is written without
credentials, and both the install and every start say auth is off.
`mobux service status` and `mobux service uninstall` cover the rest, and
`mobux update` installs the latest release and restarts that unit.
Rerun `install` with different flags to rewrite the config and restart the
service. The manual recipe stays here as the reference for what that unit
contains:

```bash
cargo install mobux --locked                 # → ~/.cargo/bin/mobux
loginctl enable-linger "$USER"                # start the user service at boot

mobux configure                               # → ~/.config/mobux/config.json

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/mobux.service <<'EOF'
[Unit]
Description=mobux — mobile tmux web frontend (:5151)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.cargo/bin/mobux --config %h/.config/mobux/config.json
# The self-updater runs `cargo install`; the default unit PATH lacks ~/.cargo/bin.
Environment=PATH=%h/.cargo/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
# Only kill the mobux process itself — the tmux server it spawned lives in the
# same cgroup, and the default would kill it (and every session) on restart.
KillMode=process

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now mobux
```

Units written by an older release carry the port, username and PIN as
`Environment=` lines instead. They keep working — the environment still
outranks the config file — and rerunning `mobux service install` migrates them.

`mobux service install` leaves `tls.enabled` off unless you pass `--tls`, so
the service serves plain HTTP. With TLS on, the cert is auto-generated (and
reused across restarts) at
`~/.config/mobux/leaf.crt`; the data dir (sessions, push subscriptions, and
the Android package once built) is `~/.local/share/mobux`. Nothing depends on
the working directory.

The Android APK is built from the `/install` page's **Generate package**
button, which signs it for the address the request arrived on (override with
`Environment=MOBUX_DOMAIN=...`). The button installs the JDK, Node and Android
SDK it needs on first use, so there is no terminal step; only `zip`, `unzip` and
`curl` come from the OS package manager, and the page names them if they are
missing. The signing keystore stays at `~/.config/mobux/twa-signing.keystore`,
so fingerprints survive rebuilds and reinstalls.

Verify the embed + service:

```bash
curl -s -u "$MOBUX_AUTH_USER:$MOBUX_PIN" http://localhost:5151/static/style.css   # 200 → served from the binary
# with TLS on: curl -sk … https://localhost:5151/static/style.css
systemctl --user status mobux
journalctl --user -u mobux -f
```

### Redeploy a new version

```bash
cargo install mobux --locked        # or the --git form
systemctl --user restart mobux      # sub-second swap; :5151 barely blinks
```

## Behind a reverse proxy

mobux builds every URL relative to the page it serves, so a proxy can publish it
under any path prefix. Three settings cover what a relative URL cannot.

```json
{
  "tls": { "enabled": false },
  "server": { "behind_tls_proxy": true, "base_path": "/mobux" }
}
```

`tls.enabled` false is the default: the proxy terminates TLS and mobux binds
plain HTTP.

`server.behind_tls_proxy` true keeps the `Secure` flag on the session cookie and
silences the clear-text warning. Set it only when TLS really terminates in
front. On a plain-HTTP deployment the browser refuses a `Secure` cookie, and
every request then falls back to a fresh Basic-auth prompt.

`server.base_path` is the prefix the browser is on. The proxy strips it before
mobux sees the request, so routing never reads it. It scopes the session
cookie's `Path`: without it the cookie is scoped to `/` and travels to every
other app the same proxy fronts. The value must start with `/` and must not
contain `..` or `;`. A trailing slash is normalised away.

Nothing else needs configuring. Assets, redirects and API calls are all relative
to the served page.

### Limits behind a path prefix

The Android app cannot be installed from a prefixed mount. Android fetches the
Digital Asset Links file from `https://<host>/.well-known/assetlinks.json` at
the origin root ([Android
docs](https://developer.android.com/training/app-links/verify-android-applinks)).
mobux serves that file under its own mount, so behind `/mobux` it answers at
`/mobux/.well-known/assetlinks.json` and verification never finds it. Serve
mobux at the origin root to install the app.

Set `app.domain` to the public address. Left unset, the APK is pinned to the
host on the request's `Host` header, which behind a proxy is whatever the proxy
forwards rather than the address the phone uses.

## Upgrade notes

TLS is off by default. A deployment where mobux terminates HTTPS itself must ask
for it: `tls.enabled` true, `MOBUX_TLS=1`, or `--tls`. With auth on, TLS off and
no `server.behind_tls_proxy`, the server prints a clear-text warning at startup.

`GET /` answers 307 with `Location: app`, resolved against the request URL, so
the redirect lands inside a proxy's path prefix.

An unmatched path answers 200 with the SPA shell, which routes it client-side.

`GET /app/<rest>` answers 307 back to `app`, one `../` per segment of `<rest>`.

## Release & publish (crates.io)

Releasing is owned by **semantic-release** (driven by conventional commits —
single source of truth, don't hand-pick versions). There is **no release PR**
and **no commit back to `main`** (branch protection forbids it). The pipeline is
**fully automatic** from merge to crates.io:

1. Merge feature PRs to `main` with conventional-commit messages. The version
   bump follows the commit types:
   - `feat:` → **minor**
   - `fix:` / `perf:` → **patch**
   - breaking change (`feat!:`, or `BREAKING CHANGE:` footer) → **major**
   - `chore:` / `docs:` / `ci:` / `test:` / `refactor:` / `style:` → **no
     release**
2. The push to `main` runs **CI** (`check` + `e2e`). When CI succeeds, the
   separate **Release** workflow (`.github/workflows/release.yml`, triggered by
   `workflow_run` on CI) runs `npx semantic-release`. It computes the next
   version from the conventional commits since the latest `v*` tag, then:
   creates the **git tag** (`vX.Y.Z`), a **GitHub Release** with generated
   notes plus a **prebuilt Linux x86_64 binary**
   (`mobux-x86_64-unknown-linux-gnu.tar.gz` + `.sha256`, built by
   `scripts/build-release-asset.sh` after the version is patched in), and
   **publishes to crates.io**. The in-app self-updater consumes that asset, so
   updates take seconds instead of a 5-10 min compile.

### The tag is the version truth

There is **no version-bump commit**. The in-repo `Cargo.toml` `version` stays at
the last value that was committed by hand and is therefore **historical** — do
not trust it as the released version; the latest `v*` git tag / GitHub Release /
crates.io is the truth. At publish time the cargo plugin
(`@semantic-release-cargo/semantic-release-cargo`) patches the computed version
into `Cargo.toml` **in the workflow workspace only** before `cargo publish`, so
the crates.io artifact carries the real version while the repo tree is left
untouched. semantic-release derives the next version from the latest `v*` tag,
so the in-repo `Cargo.toml` value is irrelevant to versioning.

### Holding back / skipping a release

- Commit with a non-releasing type (`chore:`, `docs:`, `ci:`, `test:`,
  `refactor:`, `style:`) — semantic-release will find no releasable change and
  do nothing.
- Add `[skip ci]` to the commit message to skip CI entirely (the Release
  workflow only fires on a *successful* CI run, so skipping CI also skips the
  release).

### Dry run

`semantic-release` needs a `GITHUB_TOKEN` even in dry-run mode (it queries the
GitHub API). To preview the next version and notes locally:

```bash
GITHUB_TOKEN=<a token with repo read> npx semantic-release --dry-run --no-ci
```

Without a token the run fails at the GitHub verifyConditions step; that's
expected. To only sanity-check that the config and plugins load (no token
needed), the parse/verify-config portion of `npx semantic-release --dry-run
--no-ci` output is enough — it lists the loaded plugins before hitting auth.

### Prerequisites

The only secret needed is **`CARGO_REGISTRY_TOKEN`** (crates.io publish);
`GITHUB_TOKEN` is the built-in Actions token, and the Release workflow grants it
`contents: write` for tagging + release creation. The old release-plz secrets
(`RELEASE_PLZ_DEPLOY_KEY`, the "release-plz CI trigger" deploy key) and the
"Allow GitHub Actions to create and approve pull requests" repo setting are **no
longer used** and can be removed.

Deploying to hosts stays a separate concern: manual (see above) or the in-app
self-updater (issue #130). The updater downloads the release's prebuilt binary
asset, verifies its sha256, and atomically replaces the binary `ExecStart`
points at (`~/.cargo/bin/mobux`), then restarts the unit and health-checks the
new version (rollback on failure). Releases without the asset (≤ v0.1.10) fall
back to `cargo install`, which is why the unit PATH should still include
`~/.cargo/bin`.

## Development (never touch `:5151`)

`:5151` is the live instance the phone connects to. Run dev/experimental
builds on a **different port**, detached.

**Quick, throwaway test** (ephemeral, isolated, torn down after):

```bash
make smoke-start        # throwaway instance on :8281 (HTTP, isolated data dir)
make smoke-stop
make test-smoke         # full Playwright suite against the smoke instance
```

The `make run` / `make start` / `make restart` targets bind `:5151` directly
and will collide with the systemd service — use them only on a host where
mobux is **not** running as a service.

### Installable dev instance (parallel to prod, isolated config)

You can install and run a **dev build the same way as prod** — via cargo —
just with its own binary path, port, and data dir so it never touches the
`:5151` instance. `cargo install` defaults to `~/.cargo/bin/mobux`, which is
the prod binary, so a dev build must go to a separate `--root`:

```bash
# install a branch/main build into its OWN location (doesn't overwrite prod)
cargo install --git https://github.com/mvhenten/mobux \
  --branch my-feature --root ~/.local/mobux-dev --locked
# → ~/.local/mobux-dev/bin/mobux
```

Run it with a **different context** — distinct port + data dir (keep its
sessions/push state separate from prod). The TLS cert under
`~/.config/mobux/` is shared (same host), which is fine:

```bash
MOBUX_PORT=5152 \
MOBUX_DATA_DIR=~/.local/share/mobux-dev \
MOBUX_AUTH_USER=me MOBUX_PIN=changeme MOBUX_TLS=1 \
~/.local/mobux-dev/bin/mobux
```

For a persistent dev instance you can reach from the phone, mirror the prod
unit as `~/.config/systemd/user/mobux-dev.service` with
`ExecStart=%h/.local/mobux-dev/bin/mobux`, `Environment=MOBUX_PORT=5152`,
`Environment=MOBUX_DATA_DIR=%h/.local/share/mobux-dev`, `Environment=MOBUX_TLS=1`, and its own
`WorkingDirectory`. Enable it alongside `mobux.service`; the two run
independently on `:5151` and `:5152`. Update it with
`cargo install --git … --root ~/.local/mobux-dev && systemctl --user restart mobux-dev`.

Port map: **`:5151`** prod (systemd, installed release) · **`:5152`** dev
(installed branch build) · **`:8281`** ephemeral smoke/test.

#### Dev TWA app

`make twa-dev` builds a separate **Mobux Dev** Android app — package id
`io.github.mvhenten.mobux.dev`, host `sandbox:5152` — into the repo-local
staging dir `twa/dist-dev/`, reusing the **same signing keystore** as prod
(the assetlinks fingerprint is per-key; only `package_name` differs). Because
it has a different package id, it **coexists** with the prod Mobux app on the
same device — both install side by side.

Deploy it to the `:5152` instance by copying both files into that instance's
data dir (`$MOBUX_DATA_DIR`):

```bash
make twa-dev
mkdir -p "$MOBUX_DATA_DIR/install" "$MOBUX_DATA_DIR/.well-known"
cp twa/dist-dev/install/mobux.apk         "$MOBUX_DATA_DIR/install/mobux.apk"
cp twa/dist-dev/.well-known/assetlinks.json "$MOBUX_DATA_DIR/.well-known/assetlinks.json"
```

Then install it from `https://sandbox:5152/install`.

Prod builds are unchanged in what they produce: an APK plus an assetlinks with
`package_name` `io.github.mvhenten.mobux`.

## Reboot behaviour

- **mobux** — comes back automatically (systemd user service + linger).
- **tailscale** — `tailscaled` is an enabled system service with persisted
  state; it reconnects on its own. The phone/tablet reach the host as
  `sandbox:5151` over the tailnet (MagicDNS) — that exact host is baked into
  the TWA app, so keep it stable.
- **tmux sessions** — do **not** survive a reboot. mobux only *attaches* to a
  running tmux server; there's no tmux-resurrect/continuum configured.
