# EDD: Mobux mesh — fat client, multi-host

Issue: [#123](https://github.com/mvhenten/mobux/issues/123)

## Problem

The FE is same-origin-only and the TWA is pinned to one host. If that host is
down, the app is dead even when other mobux hosts on the tailnet are up.
Required: one UI that can reach any mobux host, surviving any single host
outage (the holiday scenario).

## Architecture

A mesh of equal nodes. Every mobux binary is simultaneously:

- **FE host** — serves the embedded UI (unchanged, also the dev loop)
- **Backend** — tmux API + terminal WebSocket (unchanged)
- **Discovery node** — enumerates tailnet peers, probes for mobux
- **Relay** — stateless proxy to any peer, for clients that can't reach the
  target directly

The client is fat: it owns a **backend registry** (per-device localStorage)
and connects **direct-first, relay-fallback**. Bootstrap from any node:

```
open https://<any-host>:5151
  └─> embedded UI loads ──> wizard: this origin = first backend
        └─> /api/discover ──> peer checklist ──> registry complete
TWA: pinned origin + service-worker cache = boots even when that node is down
```

No master. Lose any host and both the UI and the registry survive via every
other host.

## Decisions

### Credentials: separate per node

Each node keeps its own Basic-auth user/PIN. One leaked PIN doesn't open the
mesh.

- Registry entry: `{name, baseUrl, user, pin}`; wizard prompts per host on add
- Discovery lists peers without creds; adding one requires a successful login
- Cost: creds at rest in localStorage (see Risks)

### Relay: stateless pass-through

`/r/<peer>/api/...` plus WS relay. The client authenticates to the relay node
with the relay's creds (`Authorization`) and sends the target's creds in
`X-Mobux-Upstream-Authorization`; the relay swaps headers when forwarding.
The relay stores nothing and trusts nothing — it is a pipe.

Client policy: try the target directly; on failure (no route, untrusted cert)
route via the node currently serving the UI.

### Discovery

- `GET /api/identify` (unauthed): `{app: "mobux", version}` — nothing else
- `GET /api/discover` (authed): peer list from `tailscale status --json`,
  probed on the mobux port with a short timeout
- Prereq on Linux hosts: `tailscale set --operator=<user>` so the mobux
  process can query tailscaled

### Cross-origin (landed, PR #124)

- CORS allowlist via `MOBUX_ALLOWED_ORIGINS`; unset = same-origin-only
  (today's behavior, dev default)
- WS auth: browsers can't send Basic on cross-origin upgrades →
  `POST /api/ws-token` mints a single-use 30s token, WS accepts `?token=`

### Certificates

Cross-origin fetch requires browser-trusted backend certs. Self-signed leafs
fail silently. Direction: `tailscale cert` (`*.ts.net` Let's Encrypt, free
tier) per host. The relay softens the requirement: only the bootstrap node
strictly needs a trusted cert; relayed peers are validated server-side, where
pinning is possible.

### Offline boot

Service worker precaches the app shell, cache-busted per release. The TWA
boots from cache when its pinned origin is down, then connects to any live
backend. Update strategy: stale-while-revalidate — serve cached shell, refresh
in the background on contact with the serving node.

### Version skew

FE from node A talks to backend B of a different version. Rule: API changes
are additive; `/api/identify` carries the version; the UI warns when a backend
is older than the FE's minimum.

## Phases

| # | Scope | Status |
|---|-------|--------|
| 1 | CORS + WS tokens | PR [#124](https://github.com/mvhenten/mobux/pull/124), CI green, unmerged |
| 2 | FE: backend registry, install wizard, host switcher (per-node creds) | |
| 3 | Service worker offline shell | |
| 4 | Discovery: `/api/identify`, `/api/discover`, wizard scan | |
| 5 | Relay: `/r/<peer>/...`, WS relay, direct-first client policy | |

Each phase lands independently; the mesh degrades gracefully to today's
single-host behavior at every step.

## Risks

- **Creds in localStorage** — readable by any XSS in the FE. Mitigation:
  strict CSP; accept the residual risk (tailnet-only exposure, per-node blast
  radius).
- **Self-signed certs** — direct cross-origin connections fail until hosts
  have `ts.net` certs or a user-installed CA. Verify TWA behavior on device
  before relying on direct mode.
- **Stale SW shell** — an old cached FE against newer backends; covered by the
  additive-API rule, but a kill-switch (SW version floor in `/api/identify`)
  may be warranted.
- **Discovery prereq drift** — hosts without the tailscale operator setting
  silently return empty peer lists; surface the error in the UI rather than
  an empty result.

## Out of scope

- Registry sync between devices (each device discovers on its own)
- Proxying to non-mobux hosts
- GitHub Pages hosting (rejected: public origin adds PNA/cert/version-skew
  constraints for no benefit once every node serves the FE)
