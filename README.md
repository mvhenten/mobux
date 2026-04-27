# 🤖 mobux

**Touch-friendly tmux web UI.** Access your tmux sessions from a phone over Tailscale, local network, or anywhere with HTTPS.

<p align="center">
  <img src="https://raw.githubusercontent.com/mvhenten/mobux/assets/sessions.png" width="270" alt="Session list">
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/mvhenten/mobux/assets/terminal.png" width="270" alt="Terminal">
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/mvhenten/mobux/assets/commands.png" width="270" alt="Command menu">
</p>

## Features

- Full live terminal on your phone via xterm.js + WebSocket
- Touch gesture layer: scroll with momentum, swipe to switch windows, pinch to zoom, long-press for commands
- Tap URLs in terminal output to open them
- Mobile keyboard autocomplete and voice dictation support
- PWA — install as a standalone app (no browser chrome)
- Session management: create, kill, switch windows, split panes
- Self-signed HTTPS out of the box (no nginx/certbot needed)
- Optional auth via HTTP Basic or PIN

## Install

### From crates.io

```bash
cargo install mobux
```

### From source

```bash
git clone https://github.com/mvhenten/mobux.git
cd mobux
cargo build --release
```

Requires `tmux` in your PATH.

## Run

```bash
# With auth
MOBUX_AUTH_USER="$USER" MOBUX_AUTH_PASS="change-me" mobux

# PIN mode (username defaults to 'mobux')
MOBUX_PIN="123456" mobux

# Custom port (default: 8080)
PORT=5151 mobux

# Disable TLS
MOBUX_TLS=0 mobux

# Extra SANs for Tailscale
MOBUX_TLS_HOSTS="myhost.tailnet.ts.net,100.64.0.1" mobux

# Use external certificates (e.g. from tailscale cert)
MOBUX_CERT_FILE=host.crt MOBUX_KEY_FILE=host.key mobux
```

Open on your phone: `https://<your-ip>:8080`

> Self-signed cert: your browser will show a security warning.
> In Chrome, type `thisisunsafe` on the warning page to proceed.

## Touch gestures

| Gesture | Action |
|---|---|
| Tap on URL | Open link |
| Swipe up/down | Scroll with momentum |
| Swipe left/right | Switch tmux windows |
| Double-tap | Focus terminal + keyboard |
| Long-press (~600ms) | Open tmux command menu |
| Pinch | Zoom font size |
| Two-finger pull down | Reload page |

## PWA install

Mobux can be installed as a standalone app on your phone (no browser chrome, own app switcher entry):

- **iOS**: Safari → Share → Add to Home Screen
- **Android**: Chrome → Menu → Add to Home Screen

> Full standalone mode on Android requires a trusted certificate (see `MOBUX_CERT_FILE`/`MOBUX_KEY_FILE`).

## TLS

HTTPS is on by default with a self-signed cert generated via `rcgen` (pure Rust). Cached in `~/.local/share/mobux/ssl/`, auto-regenerates after 30 days.

SANs include `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, and your hostname. Add more with `MOBUX_TLS_HOSTS`. Override the cert directory with `MOBUX_CERT_DIR`.

For trusted certificates (e.g. Tailscale HTTPS):
```bash
tailscale cert myhost.tailnet.ts.net
MOBUX_CERT_FILE=myhost.tailnet.ts.net.crt MOBUX_KEY_FILE=myhost.tailnet.ts.net.key mobux
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `MOBUX_AUTH_USER` | Auth username | (disabled) |
| `MOBUX_AUTH_PASS` | Auth password | (disabled) |
| `MOBUX_PIN` | PIN-only auth | (disabled) |
| `PORT` | Listen port | `8080` |
| `MOBUX_TLS` | Enable HTTPS (`0` to disable) | `true` |
| `MOBUX_TLS_HOSTS` | Extra SANs (comma-separated) | |
| `MOBUX_CERT_FILE` | External cert PEM path | (auto-generated) |
| `MOBUX_KEY_FILE` | External key PEM path | (auto-generated) |
| `MOBUX_CERT_DIR` | Cert cache directory | `~/.local/share/mobux/ssl/` |

## Development

```bash
make start    # build + start
make restart  # stop + start
make stop
make test     # playwright e2e tests
make logs     # tail server log
```

Copy `.envrc.example` and set your credentials:
```bash
cp .envrc.example .envrc
# edit .envrc with your MOBUX_USER / MOBUX_PIN
```

## License

MIT
