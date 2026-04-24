# 🤖 mobux

**tmux on your phone. Yes, really.**

<p align="center">
  <img src="https://raw.githubusercontent.com/mvhenten/mobux/assets/sessions.png" width="270" alt="Session list">
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/mvhenten/mobux/assets/terminal.png" width="270" alt="Terminal">
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/mvhenten/mobux/assets/commands.png" width="270" alt="Command menu">
</p>

For the clinically unhinged among us who think "I should SSH into my server" while
picking up dog poop in the park. For people who can't stop thinking about that
one running process even though the sun is shining and the birds are singing.
For those who believe the best time to talk to your favorite LLM is while your
golden retriever is sniffing a fire hydrant for the eleventh time.

If you're a sane person who puts their phone away and touches grass — this is not
for you. Close this tab. Go outside. You're doing great.

Still here? Of course you are. Welcome home.

## What this cursed thing does

- Lists your tmux sessions in a fat-finger-friendly mobile UI
- Tap a session to get a full live terminal on your phone
- Create, kill, split panes, switch windows — all from touch gestures
- Long-press for a tmux command menu (new pane, close pane, split, zoom, etc.)
- Swipe left/right to switch windows
- Pinch to zoom the font size because your eyes aren't what they used to be
- Two-finger pull to reload because why not
- Double-tap to focus and bring up the keyboard
- Voice input so you can dictate shell commands to your phone while your dog
  judges you silently
- Self-signed HTTPS out of the box — no nginx, no certbot, no suffering
- Optional auth via HTTP Basic or a simple PIN

## Install

### From crates.io (recommended for fellow degenerates)

```bash
cargo install mobux
```

That's it. You now have `mobux` in your PATH. You need `tmux` installed too,
obviously. If you don't have tmux, what are you even doing here?

### From source (for the extra unhinged)

```bash
git clone https://github.com/mvhenten/mobux.git
cd mobux
cargo build --release
# Binary is at target/release/mobux
```

## Requirements

- `tmux` in your PATH (the whole point)
- Rust toolchain if building from source
- A phone, a dog (optional but recommended), and questionable life choices

## Run

```bash
# With auth (you probably want this unless you enjoy strangers in your shell)
MOBUX_AUTH_USER="$USER" MOBUX_AUTH_PASS="change-me" mobux

# PIN mode (username defaults to 'mobux')
MOBUX_PIN="123456" mobux

# Custom port
PORT=5151 mobux

# Disable TLS if you like living dangerously
MOBUX_TLS=0 mobux

# Extra SANs for Tailscale or whatever
MOBUX_TLS_HOSTS="myhost.tailnet.ts.net,100.64.0.1" mobux
```

Then open on your phone:

- Local: `https://localhost:8080`
- Over Tailscale: `https://<your-tailscale-ip>:8080`

> Your browser will scream about the self-signed cert. In Chrome, type
> `thisisunsafe` on the warning page. Yes that's a real thing. No I didn't
> make it up.

## Touch gestures

| Gesture | Action |
|---------|--------|
| Swipe up/down | Scroll with momentum |
| Swipe left/right | Switch tmux windows |
| Double-tap | Focus terminal + keyboard |
| Long-press (~600ms) | Open tmux command menu |
| Pinch | Zoom font size |
| Two-finger pull down | Reload page |

## TLS details

HTTPS is on by default with a self-signed cert generated at startup via `rcgen`
(pure Rust, no openssl needed). Cached in `~/.local/share/mobux/ssl/`, auto-regenerates
after 30 days.

SANs include `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, and your hostname.
Add more with `MOBUX_TLS_HOSTS`. Override the cert dir with `MOBUX_CERT_DIR`.

## The dog walking workflow

1. Start mobux on your server
2. Leash up your dog
3. Open mobux on your phone
4. Ask your LLM to refactor that module while Barkley does his business
5. Review the diff while waiting at the crosswalk
6. Deploy from the dog park
7. Question your life choices
8. Repeat tomorrow

## License

MIT — because even bad ideas deserve to be free.
