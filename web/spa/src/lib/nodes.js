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
