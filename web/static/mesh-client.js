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

// ── per-page peer override ────────────────────────────────────────────
// A terminal page is bound to the host its session actually lives on
// (encoded as ?host=<peer> on the /s/<name> link). Once set, every
// fetch/WS on THIS page routes to that peer regardless of the globally
// selected peer in localStorage — so flipping the host picker after the
// terminal is open can't re-point the open session at the wrong node.
//
// This is page-lifetime only (a module variable, never persisted). The
// peer's creds still come from getPeerCred(peer) in localStorage, so an
// overridden peer reuses whatever creds the picker already stored for it.
let pagePeer = null; // null = no override (fall back to getPeer())

function usePeerForPage(peer) {
  pagePeer = peer || null;
}

// The peer all routing on this page should use: the page override when
// set, otherwise the globally selected peer from localStorage.
function activePeer() {
  return pagePeer != null ? pagePeer : getPeer();
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
  // Default to 5151 — the fleet-standard mobux port. Using location.port
  // here would make preview instances (:5153) add peers on :5153, where
  // nothing listens. Operators who run a non-standard port type host:port.
  return `${s}:5151`;
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

// ── peer encoding ────────────────────────────────────────────────────
// base64url-encode the host:port so colons don't get mangled in URL path
// segments. The Rust relay decodes this back to host:port before dialing.
function encodePeer(peer) {
  return btoa(peer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── path resolution ──────────────────────────────────────────────────
// `apiPath('/api/sessions')` → same-origin path, or the relay path for the
// selected peer. Accepts paths with or without a leading slash.
function apiPath(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const peer = activePeer();
  if (!peer) return p;
  // /api/foo → /r/<encoded-peer>/api/foo
  return `/r/${encodePeer(peer)}${p}`;
}

// WebSocket URL for a session. Same-origin uses /ws/<name>; a peer uses the
// relay WS path with the peer creds in ?upstream_auth= (browsers can't set
// headers on a WS upgrade — the relay turns the param into a server-side
// Authorization header on the wss hop to the peer).
function wsUrl(session) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const peer = activePeer();
  if (!peer) {
    return `${proto}://${location.host}/ws/${encodeURIComponent(session)}`;
  }
  let url =
    `${proto}://${location.host}/r/${encodePeer(peer)}` +
    `/ws/${encodeURIComponent(session)}`;
  const cred = getPeerCred(peer);
  if (cred) url += `?upstream_auth=${encodeURIComponent(cred)}`;
  return url;
}

// ── structured relay errors ──────────────────────────────────────────
// The relay returns JSON `{error, message}` for upstream_error (502) and
// bad_request (400). Parse that out of a Response so callers can branch on `kind`.
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

// ── fetch wrapper ────────────────────────────────────────────────────
// Drop-in fetch that:
//   * rewrites the path to the relay when a peer is selected,
//   * attaches X-Mobux-Upstream-Authorization with the peer creds,
//   * on 401 from a peer, clears the stored cred so the caller can re-prompt.
// Returns the raw Response; callers decide what to do with non-ok statuses.
// Throws a tagged error only for the cases the UI must react to.
async function apiFetch(path, opts = {}) {
  const peer = activePeer();
  const url = apiPath(path);
  const headers = new Headers(opts.headers || {});
  if (peer) {
    const cred = getPeerCred(peer);
    if (cred) headers.set('X-Mobux-Upstream-Authorization', `Basic ${cred}`);
  }
  const res = await fetch(url, { ...opts, headers });

  if (peer && res.status === 401) {
    // Only wipe the stored cred when the 401 genuinely came from the upstream
    // PEER, not from the relay's own auth middleware. The relay strips
    // WWW-Authenticate from forwarded peer responses (see relay.rs
    // is_stripped_response_header); its own auth rejection always includes it.
    // No WWW-Authenticate header → the 401 is from the peer → safe to clear.
    if (!res.headers.get('www-authenticate')) {
      clearPeerCred(peer);
    }
    const err = new Error('peer authentication failed');
    err.meshKind = 'unauthorized';
    err.peer = peer;
    throw err;
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
  usePeerForPage,
  activePeer,
  isCurrentNode,
  getPeerCred,
  setPeerCred,
  clearPeerCred,
  getManualPeers,
  addManualPeer,
  removeManualPeer,
  normalizeManualPeer,
  encodePeer,
  apiPath,
  wsUrl,
  apiFetch,
  apiFetchJSON,
  parseError,
};
