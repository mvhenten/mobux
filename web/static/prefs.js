// prefs.js — client access to the server-held UI preferences (#211).
//
// mobux is single-user (one basic-auth user, one sqlite db at the hub), so
// preferences are global, not per-device. The server owns them; every client
// fetches the whole blob once at boot (`hydrate()`) and PUTs the whole blob on
// every change (`set()`). There is no local caching and no per-device state —
// the per-device preference keys that renderer/theme/listen/reader used to keep
// in the browser are gone. If the server is unreachable at boot, this load
// falls back to defaults.
//
// Both the SPA (via `window.__mobuxPrefs`) and the terminal engine (via a plain
// ES import of this module) share one instance: the browser dedupes the module
// by URL, so `get()` reads the same in-memory blob the SPA hydrated at boot.

const ENDPOINT = "/api/settings/preferences";

export const DEFAULTS = Object.freeze({
  renderer: "xterm",
  theme: "tomorrow-night-soft",
  default_view: "xterm",
  osc133_hint_dismissed: false,
  listen_voice: "",
  listen_rate: 1.0,
  listen_pitch: 1.0,
  selected_node: "",
});

let state = { ...DEFAULTS };

export function get(key) {
  return key in state ? state[key] : DEFAULTS[key];
}

export function snapshot() {
  return { ...state };
}

// Fetch the whole blob once. Awaited by the SPA shell before it renders, so a
// synchronous get() from the engine returns server values, not defaults.
export async function hydrate() {
  try {
    const resp = await fetch(ENDPOINT, {
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      const server = await resp.json();
      state = { ...DEFAULTS, ...server };
    }
  } catch (_) {
    // Server unreachable at boot: keep defaults for this load.
  }
  return state;
}

// Serializes the GET-merge-PUT round trips below so overlapping calls (a
// slider firing several `set()`s while being dragged) can't race each other's
// GET against another's PUT and lose an update — see `persist()`.
let writeQueue = Promise.resolve();

async function persist(key, value) {
  // GET-merge-PUT: fetch what the server holds *right now* and overlay only
  // the changed field, instead of PUTting this tab's boot-time snapshot. A
  // long-lived tab (or one whose hydrate() failed and fell back to defaults)
  // must not stomp every other preference changed elsewhere since it booted.
  // Still last-writer-wins on this one field if another writer's GET-PUT
  // interleaves with this one — acceptable for a single-user tool, no
  // versioning needed.
  let base = state;
  try {
    const resp = await fetch(ENDPOINT, {
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      base = { ...DEFAULTS, ...(await resp.json()) };
    }
  } catch (_) {
    // GET failed: fall back to this tab's in-memory snapshot rather than
    // losing the write entirely.
  }

  const merged = { ...base, [key]: value };
  state = merged;

  try {
    await fetch(ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(merged),
    });
  } catch (_) {
    // PUT failed: in-memory state still applies to this tab/session.
  }
}

// Apply one change locally (immediately, so a synchronous get() reflects it)
// and queue the server round trip.
export function set(key, value) {
  state = { ...state, [key]: value };
  try {
    window.dispatchEvent(
      new CustomEvent("mobux:prefschange", { detail: { key, value } }),
    );
  } catch (_) {}
  writeQueue = writeQueue.then(() => persist(key, value));
  return writeQueue;
}

if (typeof window !== "undefined") {
  window.__mobuxPrefs = { get, set, snapshot, hydrate, DEFAULTS };
}
