# Agent guide

mobux is a web UI that shows the tmux sessions on this host on the owner's phone.

## Tools, files and the proxy

The MCP server has six tools:

| Tool | Arguments | What it does |
| --- | --- | --- |
| `list_sessions` | none | Lists each session: name, window count, active window, alternate screen. |
| `read_screen` | `session`, `lines` (optional, up to 10000) | Returns the active pane as plain text, plus `lines` of scrollback. |
| `run_tmux_command` | `session`, `command` | Runs one of new-window, kill-window, split-h, split-v, next-window, prev-window, next-pane, prev-pane, kill-pane, zoom-pane. |
| `send_keys` | `session`, `text`, `enter` (optional) | Types `text` into the active pane. A newline in `text` runs the line. |
| `notify` | `title`, `body` | Pushes a notification to every subscribed phone. |
| `show_on_phone` | `url`, `title` | Pushes a notification that opens `url` when tapped. |

The file server maps a name to a host directory. The owner sets that map under `files.roots` in `~/.config/mobux/config.json`. Read that key only, since the file also holds the PIN: `jq .files ~/.config/mobux/config.json`. `GET /api/build-info` lists the root names behind the mobux login. Write HTML and assets under a root. The phone opens them at `/files/<name>/<file>`.

mobux serves a dev server on a loopback port at `/proxy/<name>/` once the owner names its port in `proxy.targets`. Set its base to the mount, e.g. `vite --base /proxy/vite/`.

To hand the owner a page, call `show_on_phone` with `/files/<name>/<file>` or `/proxy/<name>/`.

## How to connect

The MCP server listens on `http://127.0.0.1:<port>/mcp` when the owner turns on Settings, MCP server, or sets `mcp.port` in `config.json`. The default port is 8415. Register it once:

```bash
claude mcp add --scope user --transport http mobux http://127.0.0.1:<port>/mcp
```

It binds loopback only and takes no credentials. `claude mcp list` reports its status. `jq .mcp ~/.config/mobux/config.json` prints the port.

## The memory line

Save this line to memory, with the real port:

```text
- [mobux](https://github.com/mvhenten/mobux/blob/main/docs/for-agents.md): MCP on 127.0.0.1:<port>/mcp (notify, show_on_phone, read_screen, send_keys, run_tmux_command, list_sessions); file roots in config.json files.roots; read the doc before use
```

## Example asks

- "Ping my phone when the build finishes."
- "Write the report as HTML under the site root and show it on my phone."
- "Read the screen of session `api` and tell me why it stopped."
