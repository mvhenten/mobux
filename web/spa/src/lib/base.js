// The path prefix the SPA was served under. mobux can sit behind a proxy that
// mounts it at a sub-path (`/user/host/8080/app`), where a root-absolute
// `/api/…` escapes the mount and hits the proxy's own root. Every URL the SPA
// builds goes through u() so it stays inside whatever mount it was served
// from; at the bare-root prefix ("") u() is the identity.
//
// The prefix is read off the entry script's own URL — the same trick
// bundleHash.js uses, and for the same reason: it's the one URL guaranteed to
// describe how this document was actually served, it needs no request, and it
// is already correct before the first fetch goes out. Vite pins the SPA's asset
// base to /static/spa/, so everything left of that marker is the prefix, in dev
// (`…/static/spa/src/main.jsx`) as well as in prod
// (`…/static/spa/assets/index-<hash>.js`).
const SPA_MOUNT = "/static/spa/";

export function derivePrefix(entryUrl) {
  if (!entryUrl) return "";
  let pathname;
  try {
    pathname = new URL(entryUrl, "http://mount.invalid/").pathname;
  } catch (_) {
    return "";
  }
  const at = pathname.indexOf(SPA_MOUNT);
  if (at < 1) return "";
  return pathname.slice(0, at);
}

function entryScriptUrl() {
  if (typeof document === "undefined") return null;
  const script = document.querySelector(
    `script[type="module"][src*="${SPA_MOUNT}"]`,
  );
  return script?.src || null;
}

let cachedEntry;
let cachedPrefix = "";

export function basePrefix() {
  const entry = entryScriptUrl();
  if (entry !== cachedEntry) {
    cachedEntry = entry;
    cachedPrefix = derivePrefix(entry);
  }
  return cachedPrefix;
}

// Root-relative paths get the prefix. A protocol-relative or absolute URL
// already names its own origin, and a document-relative path already resolves
// against the mount, so both pass through untouched.
export function u(path) {
  if (typeof path !== "string") return path;
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  return basePrefix() + path;
}
