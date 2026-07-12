// Selected-node preference for the hub → node SSH proxy (#176 phase 3).
// Device-level by design: localStorage on this single origin. "" means the
// local host — exactly today's behavior, and the only state when no nodes
// are configured.

const KEY = "mobux:node";

export function getSelectedNode() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch (_) {
    return "";
  }
}

export function setSelectedNode(name) {
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch (_) {}
}

// Append ?node=<name> to an API path; no node ⇒ path untouched (local host).
export function withNode(path, node) {
  if (!node) return path;
  return `${path}${path.includes("?") ? "&" : "?"}node=${encodeURIComponent(node)}`;
}

// Per-session node memory. The node a session lives on is carried only in the
// hash URL (`#/s/<node>/<name>`), so any re-entry by session name alone — a
// push-notification deep-link (push.rs builds `/s/<name>`, node-less), the
// `/s/<name>` server redirect, a saved/restored link — drops it and the engine
// attaches to the LOCAL host instead of the node ("can't find session"). We
// remember, per session, the node it was last opened on, so a node-less
// re-entry can recover it. Keyed by session name and set only at open time, so
// — unlike the device's *currently selected* node — a later picker change can
// never re-target an already-known session (#185).
const SESSION_NODES_KEY = "mobux:sessionNodes";

function readSessionNodes() {
  try {
    const raw = localStorage.getItem(SESSION_NODES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

// Record (or clear) the node a session was opened on. An empty node clears the
// entry: a session re-opened locally must not keep pointing at an old node.
export function rememberSessionNode(session, node) {
  if (!session) return;
  try {
    const map = readSessionNodes();
    if (node) map[session] = node;
    else delete map[session];
    localStorage.setItem(SESSION_NODES_KEY, JSON.stringify(map));
  } catch (_) {}
}

// The node a session was last opened on, or "" if none is remembered.
export function recallSessionNode(session) {
  if (!session) return "";
  const map = readSessionNodes();
  const node = map[session];
  return typeof node === "string" ? node : "";
}
