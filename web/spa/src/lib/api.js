// Thin fetch wrappers for the Rust backend. In dev these are same-origin
// requests to the Vite server on :5173, which proxies to the backend on :5152
// (attaching Basic auth server-side). In production the SPA is served by the
// backend itself at /app, so these stay same-origin.

export async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

export async function apiPutJSON(path, body) {
  return fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function apiPost(path, body) {
  const opts = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : { method: "POST" };
  return fetch(path, opts);
}

// JSON POST/PUT that throws on non-2xx and returns the parsed body. Used by
// the session create/kill/rename actions on Home.
export async function apiSend(path, opts = {}) {
  const merged = {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  };
  const res = await fetch(path, merged);
  if (!res.ok)
    throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Host-pinned helpers (always the page's own origin) ────────────────
// Update + shell-integration + STT install/run act on the binary that served
// the page (mirrors update.js's `fetchPath`).

export async function localGet(path) {
  const res = await fetch(path, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

export async function localFetch(path, opts = {}) {
  return fetch(path, { credentials: "same-origin", ...opts });
}
