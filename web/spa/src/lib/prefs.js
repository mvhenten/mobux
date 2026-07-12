// SPA accessor for the server-held UI preferences (#211).
//
// The real implementation is the engine module /static/prefs.js, loaded and
// hydrated once in main.jsx before the app renders. It publishes itself on
// window.__mobuxPrefs, so by the time any component mounts the blob is already
// in memory. This module is a thin, synchronous-read wrapper over that global;
// the FALLBACK only covers the case where the shell was bypassed (e.g. a unit
// test rendering a card in isolation).

const FALLBACK = {
  renderer: "xterm",
  theme: "tomorrow-night-soft",
  default_view: "xterm",
  osc133_hint_dismissed: false,
  listen_voice: "",
  listen_rate: 1.0,
  listen_pitch: 1.0,
};

export function getPref(key) {
  const p = globalThis.__mobuxPrefs;
  return p ? p.get(key) : FALLBACK[key];
}

export function setPref(key, value) {
  const p = globalThis.__mobuxPrefs;
  return p ? p.set(key, value) : Promise.resolve();
}

export function prefsSnapshot() {
  const p = globalThis.__mobuxPrefs;
  return p ? p.snapshot() : { ...FALLBACK };
}
