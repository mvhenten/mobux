import { signal } from "@preact/signals";
import { localGet } from "./api.js";

// Server update detection (issue #189). Watches the server's `build_hash`
// (`/api/build-info`) — a self-update (#130) or a plain service restart — so
// a tab never keeps running stale bundles unnoticed.
//
// An open terminal is never reloaded under the user: a changed hash raises
// `updateAvailable`, and the update bar offers the reload. Without a
// terminal open nothing is lost, so the tab reloads at once.
//
// An in-memory module variable remembers the last hash this tab observed —
// no client-side storage, so it resets on every load, which is exactly right:
//   - nothing remembered yet → record the current hash (a first load is
//     never "stale", it just has no baseline).
//   - remembered === current → no-op.
//   - remembered !== current → record the new hash, then reload or offer it.
//     Recording first can't loop: the reloaded tab starts fresh with no
//     baseline, re-records the now-current hash, and settles.
const POLL_MS = 60000;

export const updateAvailable = signal(false);

let seen = null;
let poll = null;

const onTerminal = () => /^#\/s\//.test(location.hash);

function reloadOrOffer() {
  if (onTerminal()) updateAvailable.value = true;
  else location.reload();
}

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

  if (seen === hash) return;

  const hadBaseline = seen !== null;
  seen = hash;

  if (hadBaseline) reloadOrOffer();
}

function startPoll() {
  if (poll === null) poll = setInterval(checkBuildHash, POLL_MS);
}

function stopPoll() {
  clearInterval(poll);
  poll = null;
}

function onVisible() {
  if (document.visibilityState !== "visible") return;
  startPoll();
  checkBuildHash();
}

export function watchBuildHash() {
  checkBuildHash();
  if (document.visibilityState === "visible") startPoll();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onVisible();
    else stopPoll();
  });
  document.addEventListener("freeze", stopPoll);
  document.addEventListener("resume", onVisible);
  // Leaving the terminal with an update pending: nothing is lost any more.
  window.addEventListener("hashchange", () => {
    if (updateAvailable.value && !onTerminal()) location.reload();
  });
  // Exposed for the SPA e2e suite (test/spa.spec.cjs) to force a check
  // without waiting out the poll interval — mirrors terminal.js's
  // window.__mobux* test hooks (e.g. forceDrop for auto-reconnect).
  window.__mobuxCheckBuildHash = checkBuildHash;
  window.__mobuxBuildPollActive = () => poll !== null;
}
