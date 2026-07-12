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
    const resp = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
    if (resp.ok) {
      const server = await resp.json();
      state = { ...DEFAULTS, ...server };
    }
  } catch (_) {
    // Server unreachable at boot: keep defaults for this load.
  }
  return state;
}

// Apply one change locally and PUT the whole blob. Fire-and-forget on the
// network: the in-memory value already applies for this session.
export async function set(key, value) {
  state = { ...state, [key]: value };
  try {
    window.dispatchEvent(
      new CustomEvent("mobux:prefschange", { detail: { key, value } }),
    );
  } catch (_) {}
  try {
    await fetch(ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
  } catch (_) {}
}

if (typeof window !== "undefined") {
  window.__mobuxPrefs = { get, set, snapshot, hydrate, DEFAULTS };
}
