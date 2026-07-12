import { localGet } from "./api.js";

// Automatic hard-reload on server update (issue #189) — a reload is how a
// running tab picks up freshly-served bundles. Watches the
// server's `build_hash` (`/api/build-info`) and forces `location.reload()`
// once it observes a change — covers both a self-update (#130) and a plain
// service restart, so a tab can never keep running against a stale server.
//
// sessionStorage remembers the last hash THIS TAB observed:
//   - nothing remembered yet → record the current hash, don't reload (a
//     first visit is never "stale", it just has no baseline).
//   - remembered === current → no-op.
//   - remembered !== current → record the new hash, THEN reload. Writing
//     first is what stops a reload loop: the reloaded tab's next check sees
//     remembered === current and settles.
const STORAGE_KEY = "mobux:buildHash";
const POLL_MS = 60000;

async function checkBuildHash() {
  let hash;
  try {
    hash = (await localGet("/api/build-info"))?.build_hash;
  } catch (_) {
    return; // offline / mid-restart — the next poll or visibility check retries
  }
  // "unknown" means the server has no embedded hash to compare against —
  // not evidence of staleness (mirrors BuildInfoCard's `stale` computation).
  if (!hash || hash === "unknown") return;

  let seen;
  try {
    seen = sessionStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return; // sessionStorage unavailable (private mode) — skip the feature
  }

  if (seen === hash) return;

  try {
    sessionStorage.setItem(STORAGE_KEY, hash);
  } catch (_) {}

  if (seen !== null) location.reload();
}

export function watchBuildHash() {
  checkBuildHash();
  setInterval(checkBuildHash, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkBuildHash();
  });
  // Exposed for the SPA e2e suite (test/spa.spec.cjs) to force a check
  // without waiting out the poll interval — mirrors terminal.js's
  // window.__mobux* test hooks (e.g. forceDrop for auto-reconnect).
  window.__mobuxCheckBuildHash = checkBuildHash;
}
