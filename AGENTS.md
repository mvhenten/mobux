# Mobux — Agent Notes

Touch-friendly tmux web UI in Rust (axum). Access tmux sessions from a phone
over Tailscale with HTTPS. The whole frontend is embedded in the binary
(`rust-embed`), so it ships as a single self-contained executable
(`cargo install mobux`).

## Running & deploying — read [`DEPLOY.md`](DEPLOY.md)

- **`:5151` is the live instance the user reaches from their phone.** It runs
  as a systemd **user** service (`~/.config/systemd/user/mobux.service`)
  executing the **`cargo install`ed** binary — decoupled from this checkout.
  **Never** run `make run` / `make start` / `make restart` against it; they
  nohup-bind `:5151` and fight the service's `Restart=always`. A broken
  `:5151` cuts off the phone, so only deploy there once verified.
- **Deploy a change to `:5151`:** `cargo install mobux --locked` (or
  `cargo install --git … --locked`) then `systemctl --user restart mobux`.
- **Releases** are owned by release-plz (conventional commits → version bump
  PR → crates.io publish). The release PR needs a user-authored empty commit
  to trigger CI (don't `--admin`-bypass). See DEPLOY.md → *Release & publish*.

## Working in the repo

- Use Makefile commands to run things; add new ones as needed.
- Use `.envrc` for local credentials (not committed), e.g.:
  ```bash
  export MOBUX_AUTH_USER=me
  export MOBUX_PIN=12345
  ```
- **Dev/experimental builds run on a different port, never `:5151`.** Quick
  throwaway: `make smoke-start` (→ `:8281`). A persistent, installable dev
  instance: `cargo install --git … --root ~/.local/mobux-dev` run on `:5152`
  with its own `MOBUX_DATA_DIR` — see DEPLOY.md → *Installable dev instance*.
  Port map: `:5151` prod · `:5152` dev · `:8281` smoke/test.
- The vendor bundles (`web/static/vendor/*.bundle.js`, `xterm.css`,
  `fonts/*.woff2`) are **committed** so the published crate embeds the real
  frontend. Regenerate with `make build` after frontend changes and commit the
  result. Only `*.map` source maps stay gitignored.
- CI (`check` + `e2e`) runs on every PR and is required to merge — don't bypass
  it. The full suite runs against an isolated smoke instance (`make test-smoke`).

## Handling uploads from the phone (incl. audio transcription)

The 📎 attach and 🎤 record buttons upload to `/api/upload`, which saves the
file to **`/tmp/mobux-uploads/<ts>-<name>`** and drops that path into the
terminal. So when the user sends a path under `/tmp/mobux-uploads/`, that's a
file they handed you — act on it:

- **Images / PDFs / text / code / logs** → read directly with the Read tool.
- **Audio** (e.g. `recording-*.webm` from the 🎤 button) → **transcribe
  locally**: `make transcribe FILE=<path>` (or `./bin/transcribe <path>`).
  It uses local whisper.cpp (offline, private; `ffmpeg` converts the format).
  Treat the transcript as the user's actual message/command.
- **Video** → no native viewing; use `ffmpeg` to extract frames (read as
  images) and/or its audio track (pipe through `bin/transcribe`).

Transcription is **capability-gated host tooling, not bundled in mobux**. If
`bin/transcribe` exits 3 ("local transcription unavailable"), tell the user and
offer to run **`make setup-transcribe`** (builds whisper.cpp + downloads the
model into `~/.local/whisper.cpp`). Local-first ethos: nothing leaves the host.
