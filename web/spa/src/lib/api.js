// Thin fetch wrappers for the Rust backend. In dev these are same-origin
// requests to the Vite server on :5173, which proxies to the backend on :5152
// (attaching Basic auth server-side). In production the SPA is served by the
// backend itself at /app, so these stay same-origin.

import { ApiError } from "./apiError.js";
import { u } from "./base.js";

// Best-effort response body for an ApiError — never throws.
async function readBody(res) {
  try {
    return await res.text();
  } catch (_) {
    return "";
  }
}

export async function apiGet(path) {
  const url = u(path);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new ApiError("GET", url, null, e.message);
  }
  if (!res.ok)
    throw new ApiError(
      "GET",
      url,
      res.status,
      res.statusText,
      await readBody(res),
    );
  return res.json();
}

export async function apiPutJSON(path, body) {
  return fetch(u(path), {
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
  return fetch(u(path), opts);
}

// JSON POST/PUT that throws on non-2xx and returns the parsed body. Used by
// the session create/kill/rename actions on Home.
export async function apiSend(path, opts = {}) {
  const merged = {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  };
  const method = opts.method || "GET";
  const url = u(path);
  let res;
  try {
    res = await fetch(url, merged);
  } catch (e) {
    throw new ApiError(method, url, null, e.message);
  }
  if (!res.ok)
    throw new ApiError(
      method,
      url,
      res.status,
      res.statusText,
      await readBody(res),
    );
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Host-pinned helpers (always the page's own origin) ────────────────
// Update + shell-integration + STT install/run act on the binary that served
// the page (mirrors update.js's `fetchPath`).

export async function localGet(path) {
  const url = u(path);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
  } catch (e) {
    throw new ApiError("GET", url, null, e.message);
  }
  if (!res.ok)
    throw new ApiError(
      "GET",
      url,
      res.status,
      res.statusText,
      await readBody(res),
    );
  return res.json();
}

export async function localFetch(path, opts = {}) {
  return fetch(u(path), { credentials: "same-origin", ...opts });
}
