import { getPref, setPref } from "./prefs.js";

// Selected-node preference for the hub → node SSH proxy (#176 phase 3).
// Server-held (`selected_node` in the preferences blob), global across
// devices — last writer wins, which is fine for a single-user tool. "" means
// the local host, the only state when no nodes are configured.

export function getSelectedNode() {
  const v = getPref("selected_node");
  return typeof v === "string" ? v : "";
}

export function setSelectedNode(name) {
  setPref("selected_node", name || "");
}

// Append ?node=<name> to an API path; no node ⇒ path untouched (local host).
export function withNode(path, node) {
  if (!node) return path;
  return `${path}${path.includes("?") ? "&" : "?"}node=${encodeURIComponent(node)}`;
}
