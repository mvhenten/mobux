import { u } from "./base.js";

// web/static/external-link.js, the one open-outside-the-shell path shared with
// the classic terminal. Loaded once at boot; held here so a click handler can
// call it synchronously, inside the tap's user gesture.
let loaded = null;

export function loadExternalLink() {
  return import(
    /* @vite-ignore */ new URL(u("/static/external-link.js"), location.origin)
      .href
  ).then((m) => {
    loaded = m;
    return m;
  });
}

// Click handler for a same-origin anchor that must still leave the app shell:
// the system browser in the TWA, a new tab elsewhere. Until the module has
// loaded, the anchor's own target="_blank" opens it.
export function openOutside(e) {
  if (!loaded) return;
  e.preventDefault();
  loaded.openExternal(e.currentTarget.href);
}
