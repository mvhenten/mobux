// base.js — the one place the legacy static modules learn where mobux lives.
//
// Every other module here used to hard-code root-absolute paths ("/api/...",
// "/ws/...", "/static/..."), which only resolve when mobux owns the origin
// root. Behind a reverse proxy that mounts it under a path prefix — a
// code-server style "/user/host/8080/" — those paths land outside the app.
//
// The prefix is not configured anywhere; it is derived. `import.meta.url` is
// the fully-resolved URL the browser used to load THIS file, and these modules
// are always served from `<prefix>/static/`, so the app root is exactly one
// directory up. No request, no server-injected constant, no guessing from
// `location` (which is a page URL and varies per route).
//
// Usage: build every URL through `u()`, and PTY sockets through `wsUrl()`.
//
//   fetch(u("api/upload"))            → <prefix>/api/upload
//   new WebSocket(wsUrl("ws/dev"))    → ws(s)://host<prefix>/ws/dev
//
// At prefix "" both return exactly what the old string literals produced.

const BASE = new URL("../", import.meta.url);

function resolve(path) {
  return new URL(String(path).replace(/^\/+/, ""), BASE);
}

// The app root, with its trailing slash — for the rare caller that needs the
// base itself rather than a path under it.
export function base() {
  return BASE.href;
}

export function u(path) {
  return resolve(path).href;
}

// Same derivation, swapped onto the socket scheme: https ⇒ wss, http ⇒ ws.
// Reading it off the base rather than `location.protocol` keeps a page served
// over one scheme from dictating the socket scheme of another.
export function wsUrl(path) {
  const url = resolve(path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
