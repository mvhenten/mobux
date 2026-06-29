// Two-instance relayed-flow test (mesh EDD phase 3).
//
// Spins up a SECOND mobux instance — the "peer" — with its own TLS cert,
// data dir, and tmux socket on a separate high port, then drives it
// THROUGH the smoke instance's relay (`/r/<peer>/api/...`). This proves the
// full phase-3 path: peer selection → relay → upstream-auth header swap →
// TOFU cert pin, exactly as the host picker wires it in the browser.
//
// The peer serves HTTPS (relay dials peers over wss/https). The smoke
// instance under MOBUX_URL is the relay node. If the peer can't be started
// (no built binary, port busy), the suite skips rather than failing — the
// in-browser picker tests in smoke.spec.cjs cover the UI regardless.

const { test, expect } = require("./fixtures.cjs");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const RELAY = process.env.MOBUX_URL || "http://localhost:8281";
const RELAY_USER = process.env.MOBUX_USER || "smoke";
const RELAY_PASS = process.env.MOBUX_PASS || "00000";
const RELAY_AUTH =
  "Basic " + Buffer.from(`${RELAY_USER}:${RELAY_PASS}`).toString("base64");

// The peer's own credentials (separate per node, per the EDD).
const PEER_PORT = Number(process.env.MOBUX_PEER_PORT || 8282);
const PEER_USER = "peer";
const PEER_PASS = "99999";
const PEER_AUTH_B64 = Buffer.from(`${PEER_USER}:${PEER_PASS}`).toString(
  "base64",
);
const PEER = `localhost:${PEER_PORT}`;
const PEER_HOST = `https://localhost:${PEER_PORT}`;

const PEER_DATA = "/tmp/mobux-mesh-peer";
const PEER_TMUX = "mobux-mesh-peer";
const PEER_SESSION = "peer-session";

const BIN = path.resolve(__dirname, "..", "target", "debug", "mobux");
const tmux = (args) =>
  execSync(`tmux -L ${PEER_TMUX} ${args}`, { stdio: "pipe" });

let peerProc = null;

async function waitFor(url, headers, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 1000);
      const res = await fetch(url, { headers, signal: ac.signal });
      clearTimeout(t);
      if (res.ok || res.status === 401) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test.beforeAll(async () => {
  if (!fs.existsSync(BIN)) {
    test.skip(true, `peer binary not built at ${BIN}`);
    return;
  }
  // Node 18+ fetch rejects self-signed certs; the peer serves one. Relax it
  // for this process only (we're a test reaching the peer directly to seed it).
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  fs.rmSync(PEER_DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(PEER_DATA, "home"), { recursive: true });

  // Seed a tmux session on the peer's dedicated server so the relayed
  // /api/sessions has something to return.
  try {
    tmux(`kill-session -t ${PEER_SESSION}`);
  } catch (_) {}
  tmux(
    `new-session -d -s ${PEER_SESSION} -e HISTFILE=/dev/null -e HOME=${PEER_DATA}/home "bash --norc --noprofile"`,
  );

  peerProc = spawn(BIN, [], {
    env: {
      ...process.env,
      PORT: String(PEER_PORT),
      MOBUX_DATA_DIR: PEER_DATA,
      MOBUX_TMUX_SOCKET: PEER_TMUX,
      MOBUX_AUTH_USER: PEER_USER,
      MOBUX_PIN: PEER_PASS,
      HOME: `${PEER_DATA}/home`,
      HISTFILE: "/dev/null",
      // Default TLS (self-signed CA + leaf) so the relay can dial https.
      MOBUX_TLS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const log = fs.createWriteStream(path.join(PEER_DATA, "peer.log"));
  peerProc.stdout.pipe(log);
  peerProc.stderr.pipe(log);

  const up = await waitFor(`${PEER_HOST}/api/identify`, {});
  if (!up) {
    test.skip(
      true,
      `peer did not come up on ${PEER_HOST} (see ${PEER_DATA}/peer.log)`,
    );
  }
});

test.afterAll(() => {
  if (peerProc) {
    try {
      peerProc.kill("SIGKILL");
    } catch (_) {}
  }
  try {
    tmux(`kill-session -t ${PEER_SESSION}`);
  } catch (_) {}
  fs.rmSync(PEER_DATA, { recursive: true, force: true });
});

test("peer is directly reachable and identifies as mobux", async () => {
  const res = await fetch(`${PEER_HOST}/api/identify`);
  expect(res.ok).toBeTruthy();
  const id = await res.json();
  expect(id.app).toBe("mobux");
  expect(typeof id.version).toBe("string");
});

test("relayed /api/sessions returns the PEER's sessions, not the relay's", async () => {
  // Through the relay node, with the relay's own auth + the peer's upstream
  // auth — exactly what mesh-client.js sends for a selected peer.
  const res = await fetch(
    `${RELAY}/r/${encodeURIComponent(PEER)}/api/sessions`,
    {
      headers: {
        Authorization: RELAY_AUTH,
        "X-Mobux-Upstream-Authorization": `Basic ${PEER_AUTH_B64}`,
      },
    },
  );
  expect(res.ok).toBeTruthy();
  const sessions = await res.json();
  const names = sessions.map((s) => s.name);
  expect(names).toContain(PEER_SESSION);
});

test("relay without upstream auth is rejected by the peer (401)", async () => {
  const res = await fetch(
    `${RELAY}/r/${encodeURIComponent(PEER)}/api/sessions`,
    {
      headers: { Authorization: RELAY_AUTH },
    },
  );
  // No X-Mobux-Upstream-Authorization → relay forwards no Authorization →
  // the peer's auth middleware rejects.
  expect(res.status).toBe(401);
});

// ── Per-page host binding (issue #123) ────────────────────────────────
// A terminal page derives its session NAME from the URL but, pre-fix, the
// PEER from the global host picker. So opening a session that lives on host
// A, then flipping the picker to host B, re-pointed the OPEN terminal at B →
// tmux on B answered "can't find session: <name>".
//
// The fix pins each session link to its host (`/s/<host>/<name>`, with the
// host injected back as window.MOBUX_PEER) and makes the terminal page route
// through that peer for its whole lifetime via
// MobuxMesh.usePeerForPage(), independent of the global picker. These tests
// assert the routing contract that pinning produces: the WS the pinned page
// opens hits the RIGHT host regardless of what the picker is set to.
//
// A = the peer (has PEER_SESSION). B = the relay/current node (does NOT).
// The relay WS path the pinned page builds is /r/<peer>/ws/<name>?upstream_auth=…
// for a peer link, and the plain /ws/<name> for a same-origin link — exactly
// what mesh-client.wsUrl() emits for the page's bound peer.

const RELAY_WS_BASE = RELAY.replace(/^http/, "ws");

// Open a relay WS to a peer, collect frames until close or timeout. Returns
// the concatenated text received (binary frames decoded as utf-8).
function collectWs(url, { headers, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (_) {}
      resolve(text);
    };
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(finish, timeoutMs);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") text += ev.data;
      else text += Buffer.from(ev.data).toString("utf-8");
    };
    ws.onclose = () => {
      clearTimeout(timer);
      finish();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

// The WS URL a page pinned to PEER builds (mirror of mesh-client.wsUrl with
// activePeer() === PEER): relay path + the peer creds in ?upstream_auth=.
const pinnedPeerWsUrl = (name) =>
  `${RELAY_WS_BASE}/r/${encodeURIComponent(PEER)}/ws/${encodeURIComponent(name)}` +
  `?upstream_auth=${encodeURIComponent(PEER_AUTH_B64)}`;

test("pinned to host A (the peer): WS attaches the session that lives there", async () => {
  // /s/<PEER>/<PEER_SESSION> → page pins PEER → this WS.
  const out = await collectWs(pinnedPeerWsUrl(PEER_SESSION), {
    headers: { Authorization: RELAY_AUTH },
  });
  // A successful attach streams the live screen; it must NOT be the
  // can't-find-session error. tmux paints something (prompt / status line),
  // so we get non-empty data and no not-found marker.
  expect(out).not.toContain("can't find session");
  expect(out.length).toBeGreaterThan(0);
});

test("pinned to host B (relay/current node): a peer-only session surfaces not-found, not silence", async () => {
  // The session lives on the PEER, not on the relay. Opening it bound to the
  // CURRENT node (same-origin /ws/<name>, no relay) is what the old bug did
  // after flipping the picker to "This host". tmux on the relay can't find it
  // and says so — the error reaches the terminal rather than wedging.
  const out = await collectWs(
    `${RELAY_WS_BASE}/ws/${encodeURIComponent(PEER_SESSION)}`,
    { headers: { Authorization: RELAY_AUTH } },
  );
  // tmux on the relay can't attach a session that isn't there. The exact
  // wording depends on whether the relay's tmux server has any sessions at
  // all ("can't find session: <name>" vs "no sessions"); either way an error
  // surfaces in the stream instead of the session's live screen — that's the
  // not-found-rather-than-silently-wedged contract.
  expect(out).toMatch(/can't find session|no sessions|session not found/);
});

test("host-pinned page route 307-redirects to /app#/s/<host>/<name>", async () => {
  // Two-segment /s/<host>/<name> now 307-redirects to the SPA hash route with
  // the host percent-encoded. The one-segment /s/<name> redirects to /app#/s/<name>.
  // Both still validate the host/name and preserve the peer in the fragment.
  const pinnedUrl = `${RELAY}/s/${encodeURIComponent(PEER)}/${encodeURIComponent(PEER_SESSION)}`;
  const pinnedResp = await fetch(pinnedUrl, {
    headers: { Authorization: RELAY_AUTH },
    redirect: "manual",
  });
  expect(pinnedResp.status).toBe(307);
  const pinnedLoc = pinnedResp.headers.get("location");
  // Colon in host:port is encoded as %3A (same as encodeURIComponent).
  const encodedPeer = PEER.replace(/:/g, "%3A");
  expect(pinnedLoc).toBe(`/app#/s/${encodedPeer}/${PEER_SESSION}`);

  const plainUrl = `${RELAY}/s/${encodeURIComponent(PEER_SESSION)}`;
  const plainResp = await fetch(plainUrl, {
    headers: { Authorization: RELAY_AUTH },
    redirect: "manual",
  });
  expect(plainResp.status).toBe(307);
  const plainLoc = plainResp.headers.get("location");
  expect(plainLoc).toBe(`/app#/s/${PEER_SESSION}`);
});

test("host-pinned route rejects a script-breakout host (reflected XSS guard)", async () => {
  // The host segment is reflected into an inline <script> as window.MOBUX_PEER
  // and serde_json does not escape markup. A host carrying </script> / < / >
  // must be rejected (400), never rendered into the page.
  const payload = "</script><script>window.__xss=1</script>";
  const res = await fetch(
    `${RELAY}/s/${encodeURIComponent(payload)}/${encodeURIComponent(PEER_SESSION)}`,
    { headers: { Authorization: RELAY_AUTH } },
  );
  expect(res.status).toBe(400);
  const body = await res.text();
  // The payload must not be reflected verbatim into any response body.
  expect(body).not.toContain("window.__xss");
});

test("global picker set to B does not cross-wire a link pinned to A", async () => {
  // Pinning is page-lifetime state, independent of the global selection. The
  // pinned WS targets PEER regardless of what "the picker" (the relay's own
  // global selection) would be — so the same pinned URL still attaches the
  // peer session. (The browser-side guarantee is usePeerForPage overriding
  // getPeer(); here we assert the resulting relay route is unchanged.)
  const out = await collectWs(pinnedPeerWsUrl(PEER_SESSION), {
    headers: { Authorization: RELAY_AUTH },
  });
  expect(out).not.toContain("can't find session");
  expect(out.length).toBeGreaterThan(0);
});
