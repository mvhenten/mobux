# mobux

A touch-friendly tmux web UI (session list + terminal + voice-to-command button).

## What it does

- Lists tmux sessions in a mobile-friendly UI
- Tap a session to open a live terminal
- Create/kill sessions from the phone
- Optional mic button on terminal page (browser speech recognition) to send text as a line into that tmux session

## Requirements

- Rust toolchain (stable)
- `tmux` installed and available in `PATH`
- A browser with WebSocket support
- For voice button: browser `SpeechRecognition` support (works best on Chromium browsers)

## Run

```bash
cd /home/alice/development/mobux
# Option A: explicit user/password (HTTPS enabled by default)
MOBUX_AUTH_USER="$USER" MOBUX_AUTH_PASS="change-me" PORT=5151 cargo run

# Option B: PIN mode (username defaults to 'mobux' unless MOBUX_AUTH_USER is set)
MOBUX_PIN="123456" PORT=5151 cargo run

# Disable TLS (plain HTTP)
MOBUX_TLS=0 PORT=5151 cargo run

# Add extra SANs (e.g. Tailscale hostname)
MOBUX_TLS_HOSTS="myhost.tailnet.ts.net,100.64.0.1" PORT=5151 cargo run
```

Open:

- Local: `https://localhost:8080`
- From phone on Tailscale: `https://<your-tailscale-ip>:8080`

> Your browser will show a self-signed certificate warning — this is expected.
> In Chrome, type `thisisunsafe` on the warning page to bypass it.

### TLS details

SSL is enabled by default with a self-signed certificate generated at startup
using `rcgen` (pure Rust, no openssl/mkcert/nginx needed). The cert is cached in
`~/.local/share/mobux/ssl/` and auto-regenerates when it expires (30-day validity).

SANs always include `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, and the machine
hostname. Add more via `MOBUX_TLS_HOSTS` (comma-separated). Override the cert
cache directory with `MOBUX_CERT_DIR`.

## Notes

- This MVP has optional auth. Put it behind Tailscale ACLs and/or a reverse proxy auth layer.
- HTTPS is on by default (needed for mic/speech on non-localhost). Set `MOBUX_TLS=0` to disable.
- Session names are restricted to: `a-z A-Z 0-9 . _ -`
- Voice button sends text via tmux buffer + Enter:
  - `tmux set-buffer -- "$TEXT"`
  - `tmux paste-buffer -t <session>`
  - `tmux send-keys -t <session> Enter`

## Suggested next steps

- Add read-only mode endpoint (`tmux attach -r`)
- Add basic auth or OAuth proxy
- Add CSRF/rate-limiting for `/send`
- Add reconnect/session-preserve behavior
