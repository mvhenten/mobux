// Thin fetch wrappers for the Rust backend. In dev these are same-origin
// requests to the Vite server on :5173, which proxies to the backend on :5152
// (attaching Basic auth server-side). In production the SPA is served by the
// backend itself at /app, so these stay same-origin.
//
// Mesh awareness: when the terminal-island has loaded the existing
// `mesh-client.js` (it sets `window.MobuxMesh`), API calls route through the
// relay for the selected peer (`/r/<peer>/…`) and inherit its credential /
// pin-mismatch handling. When MobuxMesh isn't present (e.g. a settings page the
// user opened without ever mounting a terminal), we fall back to a plain
// same-origin fetch against the page's own host. Settings/update/install always
// act on the page's own host regardless — call the `*Local` helpers there.

function mesh() {
  return typeof window !== "undefined" ? window.MobuxMesh : undefined;
}

// ── Mesh-aware helpers (peer-routed when a host is selected) ──────────

export async function apiGet(path) {
  const m = mesh();
  if (m) return m.apiFetchJSON(path);
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

export async function apiPutJSON(path, body) {
  const m = mesh();
  if (m) {
    return m.apiFetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function apiPost(path, body) {
  const m = mesh();
  const opts = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : { method: "POST" };
  if (m) return m.apiFetch(path, opts);
  return fetch(path, opts);
}

// JSON POST/PUT that throws on non-2xx and returns the parsed body. Used by the
// session create/kill/rename actions on Home, which need the mesh error modes
// (peer 401, pin mismatch) surfaced rather than swallowed.
export async function apiSend(path, opts = {}) {
  const m = mesh();
  const merged = {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  };
  if (m) return m.apiFetchJSON(path, merged);
  const res = await fetch(path, merged);
  if (!res.ok)
    throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Host-pinned helpers (always the page's own origin) ────────────────
// Update + shell-integration + STT install/run must never route through the
// host picker — they act on the binary that served the page. These bypass
// MobuxMesh entirely (mirrors update.js's `fetchPath`).

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
