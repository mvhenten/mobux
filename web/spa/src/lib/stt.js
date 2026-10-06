// STT helpers ported 1:1 from the inline IIFE in src/main.rs. Kept framework-
// free so the behaviour is auditable against the original.

import { apiGet } from "./api.js";

export const FALLBACK_MODELS = {
  openai: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
  // The published catalog (src/local_stt/model.lock.json), default first.
  // base.en rides in the release tarball; the other two download on demand.
  local: ["base.en", "tiny.en", "small.en"],
  network: [
    "Systran/faster-whisper-base.en",
    "Systran/faster-whisper-small.en",
    "Systran/faster-whisper-medium.en",
  ],
  mistral: ["voxtral-mini-latest", "voxtral-mini-2507"],
  // moshi-server picks the checkpoint from its own config; this is a label.
  kyutai: ["stt-1b-en_fr", "stt-2.6b-en"],
};

export const SCHEME = /^(https?|wss?):\/\//i;

// Defaults a kind falls back to when it has no stored provider row.
export function kindDefaults(kind) {
  // The local provider runs in this process: no host, no port.
  if (kind === "local")
    return { host: "", port: "", model: FALLBACK_MODELS.local[0] };
  if (kind === "openai")
    return { host: "https://api.openai.com", port: "443", model: "whisper-1" };
  if (kind === "mistral")
    return {
      host: "https://api.mistral.ai",
      port: "443",
      model: "voxtral-mini-latest",
    };
  if (kind === "kyutai")
    return { host: "ws://localhost", port: "8080", model: "stt-1b-en_fr" };
  return { host: "", port: "", model: FALLBACK_MODELS.network[0] };
}

// Normalise a host string to always carry a scheme (default http://). Accepts a
// bare hostname like "lab" → "http://lab". ws:// and wss:// are kept for the
// Kyutai websocket.
export function normalizeHost(h) {
  h = (h || "").trim().replace(/\/$/, "");
  if (!h) return h;
  if (!SCHEME.test(h)) return "http://" + h;
  return h;
}

// Parse a pasted full URL into { host, port } fields. host carries scheme +
// hostname only (no port); port is the explicit port or the scheme default.
// Returns null if the input isn't parseable as a URL with a port/path.
export function parseUrlIntoFields(raw) {
  if (!raw) return null;
  let normalised = raw.trim();
  if (!SCHEME.test(normalised)) normalised = "http://" + normalised;
  let u;
  try {
    u = new URL(normalised);
  } catch (_) {
    return null;
  }
  const host = u.protocol + "//" + u.hostname;
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const port = u.port || (secure ? "443" : "80");
  return { host, port };
}

// Fetch discovered models for a provider; fall back to the static list on any
// failure. Mirrors fetchModels() in the original.
export async function fetchModels(kind, host, port) {
  const query =
    "?kind=" +
    encodeURIComponent(kind) +
    "&host=" +
    encodeURIComponent(normalizeHost(host)) +
    "&port=" +
    encodeURIComponent(port || "");
  try {
    // apiGet raises the signed-out notice on a lapsed Access session; the
    // static list still fills the picker behind it.
    const data = await apiGet("/api/stt/models" + query);
    if (!data.models || !data.models.length) throw new Error("empty");
    return data.models;
  } catch (_) {
    return FALLBACK_MODELS[kind] || FALLBACK_MODELS.local;
  }
}
