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

`mobux --help` lists the flags (`--port`, `--pin`, `--user`) and the main
environment variables. A flag wins over the variable next to it; a PIN on the
command line is visible in the process list, so a service unit should keep
using `MOBUX_PIN`.

The listen port resolves as `--port` → `MOBUX_PORT` → `PORT` → 8080. Bare
`PORT` is deprecated: it still works, and the server warns at startup until it
is renamed to `MOBUX_PORT`.

## Run as a boot-persistent service (`:5151`)

The host runs mobux as a **systemd `--user`** service with linger enabled, so
it starts on boot (no login needed) and restarts on crash — no root required.

`mobux service install --port 5151 --user me --pin 12345` does all of this for
you: it writes the unit below (mode 600, since it holds the PIN) pointing at
the binary you ran it from, reloads systemd, enables the service and turns on
linger. `mobux service status` and `mobux service uninstall` cover the rest, and
`mobux update` installs the latest release and restarts that unit.
Rerun `install` with different flags to rewrite and restart the unit. The
manual recipe stays here as the reference for what that unit contains:

```bash
cargo install mobux --locked                 # → ~/.cargo/bin/mobux
loginctl enable-linger "$USER"                # start the user service at boot

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/mobux.service <<'EOF'
[Unit]
Description=mobux — mobile tmux web frontend (HTTPS on :5151)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.cargo/bin/mobux
Environment=MOBUX_PORT=5151
Environment=MOBUX_AUTH_USER=changeme
Environment=MOBUX_PIN=changeme
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

The TLS cert is auto-generated (and reused across restarts) at
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
curl -sk -u "$MOBUX_AUTH_USER:$MOBUX_PIN" https://localhost:5151/static/style.css   # 200 → served from the binary
systemctl --user status mobux
journalctl --user -u mobux -f
```

### Redeploy a new version

```bash
cargo install mobux --locked        # or the --git form
systemctl --user restart mobux      # sub-second swap; :5151 barely blinks
```

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
MOBUX_AUTH_USER=me MOBUX_PIN=changeme \
~/.local/mobux-dev/bin/mobux
```

For a persistent dev instance you can reach from the phone, mirror the prod
unit as `~/.config/systemd/user/mobux-dev.service` with
`ExecStart=%h/.local/mobux-dev/bin/mobux`, `Environment=MOBUX_PORT=5152`,
`Environment=MOBUX_DATA_DIR=%h/.local/share/mobux-dev`, and its own
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
