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

Prebuilt Linux binary from the GitHub release (seconds, no compile; every
release ships `mobux-x86_64-unknown-linux-gnu.tar.gz` and
`mobux-aarch64-unknown-linux-gnu.tar.gz`, each with a `.sha256` checksum file,
as assets). Each is ~137 MB: the binary plus the default speech model
(`stt-models/base.en/`, f16 weights), so a fresh install dictates without
fetching a model from anywhere. The other two checkpoints ship as their own
platform-independent assets, downloaded only if someone picks them —
`mobux-stt-tiny.en.tar.gz` (~67 MB) and `mobux-stt-small.en.tar.gz`
(~424 MB), each with a `.sha256`. `install.sh` picks the platform asset
matching `uname -m`:

```bash
curl -fsSL https://raw.githubusercontent.com/mvhenten/mobux/main/install.sh | bash
```

Each asset carries the voice the reader speaks with alongside the binary, and
`install.sh` unpacks it into `$MOBUX_DATA_DIR/tts-voices` — so a prebuilt
install reads aloud without fetching a model from anywhere. A `cargo install`
build has no voice beside it: build it with `cargo install mobux --locked
--features local-tts` and the first request pulls the same published asset and
checks every file against `src/local_tts/voice.lock.json`. Point
`MOBUX_TTS_MODEL_DIR` at a directory holding the voice to skip that entirely,
which is what an airgapped host wants. Without the feature the reader falls
back to the browser's own speech synthesis.

`install.sh` only reads `MOBUX_DATA_DIR` from the environment, so an instance
whose data dir comes from `paths.data_dir` in `config.json` looks elsewhere for
the voice and fetches its own copy on first use. Run the installer with the
same directory the server uses — `MOBUX_DATA_DIR=… curl … | bash` — or point
`MOBUX_TTS_MODEL_DIR` at where the installer put it.

By hand, naming the triple for your architecture:

```bash
ASSET=mobux-x86_64-unknown-linux-gnu.tar.gz   # or mobux-aarch64-unknown-linux-gnu.tar.gz
curl -fsSLO "https://github.com/mvhenten/mobux/releases/latest/download/$ASSET"
curl -fsSLO "https://github.com/mvhenten/mobux/releases/latest/download/$ASSET.sha256"
sha256sum -c "$ASSET.sha256"
tar -xzf "$ASSET" -C ~/.cargo/bin mobux
mkdir -p ~/.local/share/mobux
tar -xzf "$ASSET" -C ~/.local/share/mobux stt-models   # the speech model
```

From crates.io (released versions; 5-10 min release-mode compile). The crate
carries no weights — crates.io caps a crate near 10 MB — so build with the
engine and it pulls the same release asset on first use, checking every file
against the hashes compiled into it:

```bash
cargo install mobux --locked --features local-stt
# on aarch64, add: RUSTFLAGS="-C target-feature=+fp16"
```

Switching model in settings downloads that checkpoint's asset — from the
release matching the running version, not `latest`, because the hashes are
compiled into the binary — and verifies it against
`src/local_stt/model.lock.json` before loading it. Weights are stored f16 and
run f32, so resident memory is about twice the download: ~290 MB for base.en,
~150 MB for tiny.en, ~970 MB for small.en.

On arm64 the engine needs ARMv8.2 half-precision (FEAT_FP16). candle's gemm
emits those instructions without declaring the target feature, so the build
enables it for the whole binary (`.cargo/config.toml`); an ARMv8.0 core
(Cortex-A72, so a Raspberry Pi 4) cannot execute them, and mobux checks for the
feature before loading anything and reports the local provider as unavailable
instead of taking the process down. For an airgapped
host, or to run a checkpoint mobux does not publish, point
`MOBUX_STT_MODEL_DIR` at a directory holding `config.json`, `tokenizer.json`
and `model.safetensors`. A directory named there is used as given and never
checked against the lock.

A maintainer refreshes a checkpoint with
`node scripts/stt-model.mjs fetch <dir> <model>` followed by
`node scripts/stt-model.mjs lock <dir> <model>`, which rewrites
`src/local_stt/model.lock.json` (`models` lists the catalog, `vendored` names
the one the platform tarball carries). That script is the only thing in the
repo that contacts Hugging Face; nothing does at runtime.

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
| `access.port` | `MOBUX_ACCESS_PORT` | `--access-port` | `0` (off) | Loopback port for the Cloudflare Access listener. Must differ from `server.port`; `0` turns it off |
| `access.team_domain` | `MOBUX_ACCESS_TEAM_DOMAIN` | `--access-team-domain` | unset | Cloudflare Access team domain: a bare hostname such as `example.cloudflareaccess.com`, which means https, or an `https://` origin. `http://` only for `127.0.0.1` and `localhost`; no path or query |
| `access.aud` | `MOBUX_ACCESS_AUD` | `--access-aud` | unset | AUD tag of the Cloudflare Access application |
| `access.hostname` | `MOBUX_ACCESS_HOSTNAME` | `--access-hostname` | unset | Public hostname the Cloudflare Tunnel serves mobux on, a bare hostname |
| `access.allowed_emails` | `MOBUX_ACCESS_ALLOWED_EMAILS` | `--access-allowed-email` | empty | Email addresses the Access listener admits |
| `access.service_tokens` | `MOBUX_ACCESS_SERVICE_TOKENS` | `--access-service-token` | empty | Client ids of the service tokens the Access listener admits |
| `files.roots` | `MOBUX_FILES` | none | empty | Host directories served under `/files/<name>/` |
| `files.listing` | `MOBUX_FILES_LISTING` | `--files-listing` | `false` | List a served directory that has no `index.html` |
| `proxy.targets` | `MOBUX_PROXY` | none | empty | Loopback ports proxied under `/proxy/<name>/` |
| `mcp.port` | `MOBUX_MCP_PORT` | `--mcp-port` | `0` (off) | Loopback port for the MCP server at `/mcp`. Must differ from `server.port` and `access.port` |

Config keys nest. `server.port` is `{"server": {"port": 5151}}`, and only the
keys a file states override a default.

The `access` block is off while every key in it is unset. Setting any one of
them turns it on, and mobux then refuses to start until `access.port`,
`access.team_domain` and `access.aud` are set, `access.port` differs from
`server.port`, and `access.allowed_emails` or `access.service_tokens` lists at
least one entry. As with `tls.acme_domains`, the file is validated on its own
before the environment and flags apply, so a block split between the file and
the environment must already pass these rules in the file.

On the Access listener the app behaves as a client of the public hostname.
The install page drops the CA step, since Cloudflare terminates TLS with a
publicly trusted certificate. With `access.hostname` set, the Android package
is signed for that hostname whichever address builds it, and the install page
names the host it opens. Uploads through the tunnel stop at 100 MB, the body
limit on Cloudflare's Free and Pro plans: the app refuses a larger file before
sending it, and the listener answers 413. When the Access session lapses, the
app shows a notice with a "Sign in again" control that loads the page again through
Cloudflare's login and returns to the same screen.

Toggles take `--flag` to turn on and `--no-flag` to turn off. `--flag=` also
takes `1`, `true`, `yes`, `on`, `0`, `false`, `no` and `off`. `MOBUX_TLS` reads
any value other than `0` and `false` as on; every other toggle variable wants
`1` or `true`.

List flags repeat, or take one comma-separated value. Their environment
variables are comma separated. A map variable is comma-separated `name=path`
pairs: `MOBUX_FILES=site=/srv/site,docs=/srv/docs`.

### Serving host directories

`files.roots` maps a name to an absolute directory, served at `/files/<name>/`
behind the same login as the UI. mobux resolves each root at startup and stops
if one is missing. A path that resolves outside its root, through `..` or a
symlink, answers 404. A directory serves its `index.html`, or a plain list of
its entries when `files.listing` is true, each file with an Open and a Download
link. Adding `?download` to any file URL saves the file instead of showing it.

`MOBUX_FILES` replaces the file's `files.roots` rather than adding to them. A
repeated name keeps its last path, and a path cannot contain a comma; name such
a directory in the config file instead.

```json
{ "files": { "roots": { "site": "/home/me/site" }, "listing": false } }
```

### Proxying local ports

`proxy.targets` maps a name to a port on 127.0.0.1, proxied at
`/proxy/<name>/` behind the same login as the UI, WebSockets included. The
upstream never sees the mobux session cookie or `Authorization`, and gets
`X-Forwarded-Prefix: /proxy/<name>`. A target that is not listening answers
502 naming its port. `MOBUX_PROXY=vite=5173,docs=8000` replaces the file's
targets, as `MOBUX_FILES` does. A dev server that emits root-absolute URLs
needs its base set to the mount, e.g. `vite --base /proxy/vite/`.

Settings → Pages adds and removes file roots and proxy targets from the phone:
it writes `files.roots` and `proxy.targets` to the config file and serves the
change at once, without a restart. A section that `MOBUX_FILES` or
`MOBUX_PROXY` sets is read-only there.

```json
{ "proxy": { "targets": { "vite": 5173 } } }
```

### MCP server for agents on the host

`mcp.port` turns on an MCP server at `http://127.0.0.1:<port>/mcp` (Streamable
HTTP). Its tools list sessions, read a screen, run a tmux command, type into a
pane, push a notification and push a page to the phone. The simpler route is
Settings → MCP server, which writes this block, starts the listener and shows
the registration command. Register it with Claude Code:

```bash
claude mcp add --scope user --transport http mobux http://127.0.0.1:8415/mcp
```

```json
{ "mcp": { "port": 8415 } }
```

It takes no credentials. It binds 127.0.0.1 only, refuses a `Host` or `Origin`
that is not loopback with a 403, and is never served on the public port or the
Access listener, which answer 404 at `/mcp`. Anything that can open a loopback
connection on this host can drive the sessions, so turn it on only where every
local user is trusted.

### Speech providers

The `stt` block picks where dictation from the 🎤 button is transcribed; the
`tts` block picks the voice Listen mode reads the terminal with. Both are
file-only: no environment variable or flag sets them. Settings → Speech to text
and Settings → Listen write them, and mobux reads the file on every request, so
a hand edit applies without a restart.

`active` names the kind in use. `providers` maps a kind to its settings; a kind
left out, or a field left empty, takes that kind's defaults. `port` is text,
and empty means the scheme's default. The settings API never returns
`api_key`, and saving a kind with an empty key keeps the stored one.

| `stt` kind | Defaults (`host`, `port`, `model`) | What it is |
|---|---|---|
| `local` | none, none, `base.en` | Whisper in the mobux process |
| `network` | none, none, `Systran/faster-whisper-base.en` | A self-hosted OpenAI-compatible `/v1/audio/transcriptions`, see [`deploy/stt/`](deploy/stt/README.md) |
| `openai` | `https://api.openai.com`, `443`, `whisper-1` | OpenAI |
| `mistral` | `https://api.mistral.ai`, `443`, `voxtral-mini-latest` | Mistral Voxtral, hosted |
| `kyutai` | `ws://localhost`, `8080`, `stt-1b-en_fr` | Kyutai STT on `moshi-server`, see [`deploy/stt/`](deploy/stt/README.md) |

| `tts` kind | Defaults (`host`, `port`, `model`, `voice`) | What it is |
|---|---|---|
| `local` | none | The Piper voice in the mobux process |
| `mistral` | `https://api.mistral.ai`, `443`, `voxtral-mini-tts-2603`, `en_paul_neutral` | Mistral Voxtral TTS, hosted |
| `network` | none, none, `mistralai/Voxtral-4B-TTS-2603`, `casual_female` | A self-hosted OpenAI-compatible `/v1/audio/speech`, see [`deploy/tts/`](deploy/tts/README.md) |
| `kyutai` | `http://localhost`, `8000`, `pocket-tts`, `alba` | Kyutai Pocket TTS, see [`deploy/tts/`](deploy/tts/README.md) |

A remote voice that fails is not an error to the listener: `/api/tts/speak`
answers with the words for the browser voice and a `reason` naming the
provider and what it answered.

```json
{
  "stt": {
    "active": "mistral",
    "providers": { "mistral": { "api_key": "…" } }
  },
  "tts": {
    "active": "kyutai",
    "providers": { "kyutai": { "host": "http://gpu-box.tailnet.ts.net", "voice": "alba" } }
  }
}
```

To ship an install with its providers already set, write that file into a
directory and point `MOBUX_CONFIG_DIR` at it, or pass `--config PATH`. Keep it
at mode 600: it holds the keys. mobux writes Settings changes back to the same
file.

An install from before this block kept its speech-to-text settings in the
database. On the first start with a `config.json` that has no `stt` block,
mobux copies them into the file once; the database rows are not read again.

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

The generated CA (`ca.crt`) is valid for 30 years and the leaf for 20. On
every TLS start mobux checks the leaf and reissues it from the same CA when it
expires within a year or no longer covers the current hostnames and IPs, so
the CA installed on the phone stays trusted. mobux never replaces an existing
CA; when the CA itself has under a year left it logs a warning, and replacing
it means reinstalling it on every device. Installs created before this
version keep their original CA expiry, and a leaf never outlives its CA.

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

## Cloudflare Access listener

With the `access` block set, mobux opens a second plain-HTTP listener on
`127.0.0.1:<access.port>`, next to the main one. It serves the same UI and API
and is meant for a Cloudflare Tunnel: point cloudflared's ingress at
`http://127.0.0.1:<access.port>`, never at the main port.

```json
{
  "access": {
    "port": 5153,
    "team_domain": "example.cloudflareaccess.com",
    "aud": "<Access application AUD tag>",
    "allowed_emails": ["me@example.com"]
  }
}
```

Every request needs a valid Cloudflare Access token, in the
`Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie. mobux checks
its signature against `<team>/cdn-cgi/access/certs`, the AUD, the issuer and the
email or service-token allowlist. The PIN plays no part here. A refused request
gets 401 with a one-line reason and `WWW-Authenticate: Bearer
realm="cloudflare-access"`. A request whose `Origin` is neither the
request host nor `https://<access.hostname>` gets 403, since Cloudflare sends
its cookie on cross-site requests too. Only `/.well-known/assetlinks.json`,
`/static/manifest.json`, `/static/icon-*` and `/sw.js` are open without a
token; the install page, the APK, the CA and `/api/identify` need one.

Terminal WebSockets get a ping every 30 seconds, on both listeners, so
Cloudflare does not close an idle terminal. A port that cannot be bound stops
startup, so a self-update that breaks the listener rolls back. The main listener
and its PIN are unchanged.

## Cloudflare Tunnel and Access

Serves mobux on a public hostname through a Cloudflare Tunnel, with Cloudflare
Access in front and mobux checking every Access token itself.

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   and create a named tunnel:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create mobux
   cloudflared tunnel route dns mobux mobux.example.com
   ```

2. Set the `access` block in `config.json` ([config reference](#config-reference)):
   `port`, `team_domain`, `hostname` and `allowed_emails`. Put any placeholder
   in `aud` for now; step 4 replaces it.

3. Print the tunnel config and move it to `~/.cloudflared/config.yml`. Name the
   config file if the service runs with `--config`:

   ```bash
   mobux configure --cloudflared > ~/.cloudflared/config.yml.new
   mv ~/.cloudflared/config.yml.new ~/.cloudflared/config.yml
   ```

   Fill in `<TUNNEL-ID>` and `<user>` from step 1. The ingress points at
   `http://127.0.0.1:<access.port>` and answers 404 for any other hostname.
   WebSockets need no extra setting. Start it with `cloudflared tunnel run mobux`
   or `cloudflared service install`, which on Linux needs root and reads
   `/etc/cloudflared/config.yml` instead.

4. In Zero Trust, add the two self-hosted applications the output lists:
   - the hostname, with an Allow policy for the printed emails. Set the session
     duration to 24 hours or longer; when it lapses, mobux shows "Sign in
     again". Copy the application's AUD tag into `access.aud` and restart mobux.
   - the printed bypass paths, with a Bypass policy that includes Everyone.
     Android's asset-links check and the manifest and icon fetches send no
     sign-in, so these paths must load without one. The install page, the APK
     and the CA stay behind Access.

5. For scripts, create a service token under Access > Service Auth, add its
   client ID to `access.service_tokens`, and add a Service Auth policy for it
   to the first application. A script sends the `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` headers; Cloudflare swaps them for a token whose
   `common_name` is the client ID, which mobux matches against
   `access.service_tokens`.

Cloudflare caps a request body at 100 MB on the Free and Pro plans, so an
upload over 100 MB fails through the tunnel. Send large files over the tailnet,
where the limit is 200 MB.

The tailnet listener, its CA and the PIN keep working alongside the tunnel.

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
   notes plus **prebuilt Linux x86_64 and aarch64 binaries**
   (`mobux-<triple>-unknown-linux-gnu.tar.gz` + `.sha256`, built by
   `scripts/build-release-asset.sh` after the version is patched in, with
   `--features local-stt` and the default speech model packed alongside;
   aarch64 is cross-compiled with the `gcc-aarch64-linux-gnu` toolchain the
   workflow installs), **the two on-demand speech models**
   (`mobux-stt-<model>.tar.gz` + `.sha256`, platform-independent, listed in
   `.releaserc.json` like every other asset), and
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
asset for the running architecture, verifies its sha256, and atomically
replaces the binary `ExecStart` points at (`~/.cargo/bin/mobux`) — it takes
only the binary out of the asset and leaves the speech model alone, so an
update that changes the pinned weights re-fetches them on first use — then
restarts
the unit and health-checks the new version (rollback on failure). Releases
without the asset (≤ v0.1.10) fall back to `cargo install`, which is why the
unit PATH should still include `~/.cargo/bin`.

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
