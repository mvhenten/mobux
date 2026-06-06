# EDD: Mobux mesh — every node proxies to every peer

Issue: [#123](https://github.com/mvhenten/mobux/issues/123)

## Problem

The UI only talks to the host that served it. If that host is down, other
mobux hosts on the tailnet are up but unreachable from the app. Required: any
mobux host gives access to all of them; any single host outage is survivable.

## Architecture

A mesh of equal nodes. Every mobux binary:

- serves the embedded UI (unchanged)
- runs its own tmux backend (unchanged)
- **enumerates** mobux peers on the tailnet
- **relays** API + WebSocket traffic to any peer

The browser stays same-origin with the node it loaded from. Picking another
host in the UI routes everything through the current node:

```
phone ──HTTPS──> node-a:5151 ──tailnet──> node-b:5151
                 (UI + relay)             (selected peer)
```

The relay validates peers server-side, so the browser never touches a peer's
origin or cert. Any survivor's URL serves the full UI.

## Decisions

### Relay: stateless pass-through

`/r/<peer>/api/...` and `/r/<peer>/ws/...`. The client authenticates to the
relay node with `Authorization` and supplies the peer's creds in
`X-Mobux-Upstream-Authorization`; the relay swaps headers when forwarding and
stores no creds.

### Credentials: separate per node

Each node keeps its own Basic-auth user/PIN, so a leaked credential reaches
one node. The UI prompts when a peer is first selected and remembers
per-device.

### Peer certs: server-side TOFU

Peers run self-signed leafs (status quo). The relay pins a peer's cert
fingerprint on first contact and rejects changes.

### Enumeration

- `GET /api/identify` (unauthed): `{app: "mobux", version}` — nothing else
- `GET /api/peers` (authed): tailnet peers from `tailscale status --json`,
  probed for `/api/identify` on the mobux port with a short timeout; plus
  manually configured peers
- Prereq on Linux: `tailscale set --operator=<user>` so mobux can query
  tailscaled; surface the error in the UI, never an empty list

### UI

- First boot: current host is the backend, as today — zero config
- Host picker in the session list, fed by `/api/peers`; manual add for
  non-discovered hosts
- Selected peer + per-peer creds persist per device (localStorage)

### Version skew

FE from node A drives backend B. API changes are additive; `/api/identify`
carries the version; the UI warns when a peer is older than it knows how to
drive.

## Phases

| # | Scope |
|---|-------|
| 1 | `/api/identify` + `/api/peers` (enumeration) |
| 2 | Relay: `/r/<peer>/...` API + WS forwarding, TOFU cert pinning |
| 3 | UI: host picker, per-peer creds prompt, peer status |

Each phase lands independently; behavior without peers is identical to today.

## Risks

- **Relay hop latency** — phone → node-a → node-b adds a tailnet round trip
  per request and per WS frame. Measure in phase 2.
- **Peer creds in localStorage** — readable by XSS on the serving node's
  origin. Strict CSP; per-node creds cap the reach.
- **TOFU pinning** — a reinstalled peer (new leaf cert) needs an explicit
  un-pin; the UI makes that a one-tap action, not a config-file dig.
