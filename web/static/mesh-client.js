// Mesh client (EDD phase 3): resolves where API + WebSocket traffic goes.
//
// The browser always stays same-origin with the node that served the page.
// Picking a peer routes everything through that node's relay:
//
//   same-origin (current node):  /api/...        wss://host/ws/...
//   peer selected:               /r/<peer>/api/...  wss://host/r/<peer>/ws/...?upstream_auth=...
//
// The current node is the default and works with zero config exactly as
// before — when no peer is selected, every path here is the plain
// non-relayed one and no extra headers are added.
//
// State (selected peer + per-peer creds) persists per device in
// localStorage. This module is the single chokepoint every fetch/WS in the
// frontend goes through, so behaviour is consistent across the session list,
// the terminal, and uploads.

const PEER_KEY = 'mobux:peer'; // selected peer: "host:port" or "" (current node)
const CRED_PREFIX = 'mobux:peer-cred:'; // per-peer base64(user:pass), keyed by peer
const MANUAL_KEY = 'mobux:manual-peers'; // JSON array of "host:port" added by hand

// ── selection ────────────────────────────────────────────────────────
function getPeer() {
  try {
    return localStorage.getItem(PEER_KEY) || '';
  } catch (_) {
    return '';
  }
}

function setPeer(peer) {
  try {
    if (peer) localStorage.setItem(PEER_KEY, peer);
    else localStorage.removeItem(PEER_KEY);
  } catch (_) {}
}

// True when driving the current (serving) node — the zero-config default.
function isCurrentNode() {
  return !getPeer();
}

// ── per-peer credentials ─────────────────────────────────────────────
// Stored as base64("user:pass"), exactly the token Basic auth needs, so we
// never keep the cleartext PIN around longer than the prompt.
function getPeerCred(peer) {
  if (!peer) return null;
  try {
    return localStorage.getItem(CRED_PREFIX + peer) || null;
  } catch (_) {
    return null;
  }
}

function setPeerCred(peer, user, pin) {
  if (!peer) return;
  try {
    localStorage.setItem(CRED_PREFIX + peer, btoa(`${user}:${pin}`));
  } catch (_) {}
}

function clearPeerCred(peer) {
  if (!peer) return;
  try {
    localStorage.removeItem(CRED_PREFIX + peer);
  } catch (_) {}
}

// ── manual peers ──────────────────────────────────────────────────────
// Hosts the operator adds by hand for nodes tailscale enumeration doesn't
// surface (per the EDD UI section). Stored per device as "host:port" and
// merged into the picker alongside discovered peers. They go through the
// relay exactly like a discovered peer — only their origin differs.

// Normalize a hand-typed entry to "host:port", defaulting the port to the
// current page's port (homogeneous mesh). Returns null for empty/invalid.
function normalizeManualPeer(raw) {
  const s = (raw || '').trim();
  if (!s || s.includes('/') || s.includes(' ')) return null;
  const i = s.lastIndexOf(':');
  if (i > 0) {
    const port = Number(s.slice(i + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return `${s.slice(0, i)}:${port}`;
  }
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  return `${s}:${port}`;
}

function getManualPeers() {
  try {
    const arr = JSON.parse(localStorage.getItem(MANUAL_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : [];
  } catch (_) {
    return [];
  }
}

// Add a manual peer. Returns the normalized id, or null if invalid.
function addManualPeer(raw) {
  const peer = normalizeManualPeer(raw);
  if (!peer) return null;
  const peers = getManualPeers();
  if (!peers.includes(peer)) {
    peers.push(peer);
    try {
      localStorage.setItem(MANUAL_KEY, JSON.stringify(peers));
    } catch (_) {}
  }
  return peer;
}

function removeManualPeer(peer) {
  const peers = getManualPeers().filter((p) => p !== peer);
  try {
    localStorage.setItem(MANUAL_KEY, JSON.stringify(peers));
  } catch (_) {}
  // Forget its creds too, and deselect if it was the active host.
  clearPeerCred(peer);
  if (getPeer() === peer) setPeer('');
}

// ── path resolution ──────────────────────────────────────────────────
// `apiPath('/api/sessions')` → same-origin path, or the relay path for the
// selected peer. Accepts paths with or without a leading slash.
function apiPath(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const peer = getPeer();
  if (!peer) return p;
  // /api/foo → /r/<peer>/api/foo
  return `/r/${encodeURIComponent(peer)}${p}`;
}

// WebSocket URL for a session. Same-origin uses /ws/<name>; a peer uses the
// relay WS path with the peer creds in ?upstream_auth= (browsers can't set
// headers on a WS upgrade — the relay turns the param into a server-side
// Authorization header over the pinned wss hop, per PR #128).
function wsUrl(session) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const peer = getPeer();
  if (!peer) {
    return `${proto}://${location.host}/ws/${encodeURIComponent(session)}`;
  }
  let url =
    `${proto}://${location.host}/r/${encodeURIComponent(peer)}` +
    `/ws/${encodeURIComponent(session)}`;
  const cred = getPeerCred(peer);
  if (cred) url += `?upstream_auth=${encodeURIComponent(cred)}`;
  return url;
}

// ── structured relay errors ──────────────────────────────────────────
// The relay returns JSON `{error, message}` for pin_mismatch (409),
// upstream_error (502) and bad_request (400). Parse that out of a Response
// so callers can branch on `kind`.
async function parseError(res) {
  let body = null;
  try {
    body = await res.clone().json();
  } catch (_) {}
  if (body && body.error) {
    return { status: res.status, kind: body.error, message: body.message || body.error };
  }
  let text = '';
  try {
    text = await res.clone().text();
  } catch (_) {}
  return { status: res.status, kind: null, message: text || `${res.status}` };
}

// Re-trust a peer after a cert change: drop the server-side pin so the next
// contact re-pins (TOFU). One-tap action behind the pin_mismatch UX.
async function trustNewCert(peer) {
  const res = await fetch(`/api/peers/${encodeURIComponent(peer)}/pin`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`failed to reset pin: ${res.status}`);
}

// ── fetch wrapper ────────────────────────────────────────────────────
// Drop-in fetch that:
//   * rewrites the path to the relay when a peer is selected,
//   * attaches X-Mobux-Upstream-Authorization with the peer creds,
//   * on 401 from a peer, clears the stored cred so the caller can re-prompt,
//   * exposes the structured pin_mismatch error.
// Returns the raw Response; callers decide what to do with non-ok statuses.
// Throws a tagged error only for the cases the UI must react to.
async function apiFetch(path, opts = {}) {
  const peer = getPeer();
  const url = apiPath(path);
  const headers = new Headers(opts.headers || {});
  if (peer) {
    const cred = getPeerCred(peer);
    if (cred) headers.set('X-Mobux-Upstream-Authorization', `Basic ${cred}`);
  }
  const res = await fetch(url, { ...opts, headers });

  if (peer && res.status === 401) {
    // Peer rejected the creds — forget them so the next call re-prompts.
    clearPeerCred(peer);
    const err = new Error('peer authentication failed');
    err.meshKind = 'unauthorized';
    err.peer = peer;
    throw err;
  }
  if (peer && res.status === 409) {
    const e = await parseError(res);
    if (e.kind === 'pin_mismatch') {
      const err = new Error(e.message);
      err.meshKind = 'pin_mismatch';
      err.peer = peer;
      throw err;
    }
  }
  return res;
}

// JSON convenience used across the UI (mirrors the old index.js fetchJSON,
// but mesh-aware). Throws on non-ok with the response text as the message.
async function apiFetchJSON(path, opts = {}) {
  const merged = {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  };
  const res = await apiFetch(path, merged);
  if (!res.ok) {
    const e = await parseError(res);
    throw new Error(e.message);
  }
  return res.json();
}

window.MobuxMesh = {
  getPeer,
  setPeer,
  isCurrentNode,
  getPeerCred,
  setPeerCred,
  clearPeerCred,
  getManualPeers,
  addManualPeer,
  removeManualPeer,
  normalizeManualPeer,
  apiPath,
  wsUrl,
  apiFetch,
  apiFetchJSON,
  parseError,
  trustNewCert,
};
