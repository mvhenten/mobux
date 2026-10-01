// Thin fetch wrappers for the Rust backend. In dev these are same-origin
// requests to the Vite server on :5173, which proxies to the backend on :5152
// (attaching Basic auth server-side). In production the SPA is served by the
// backend itself at /app, so these stay same-origin.
//
// Every request is made with redirect: "manual". No API route redirects, so a
// redirect is Cloudflare Access sending a lapsed session to its login page:
// it marks the app signed out (lib/accessSession.js) and fails the call.

import { ApiError } from "./apiError.js";
import { u } from "./base.js";
import { isSignedOutResponse, markSignedOut } from "./accessSession.js";

// Best-effort response body for an ApiError — never throws.
async function readBody(res) {
  try {
    return await res.text();
  } catch (_) {
    return "";
  }
}

// A network failure rejects with fetch's own error, as it always has for the
// helpers that hand back the raw Response.
async function request(method, url, opts) {
  const res = await fetch(url, { ...opts, redirect: "manual" });
  if (isSignedOutResponse(res)) {
    markSignedOut();
    const err = new ApiError(
      method,
      url,
      401,
      "signed out of Cloudflare Access",
      await readBody(res),
    );
    err.signedOut = true;
    throw err;
  }
  return res;
}

async function json(method, url, opts) {
  let res;
  try {
    res = await request(method, url, opts);
  } catch (e) {
    if (e instanceof ApiError) throw e;
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
  return res;
}

export async function apiGet(path) {
  const url = u(path);
  const res = await json("GET", url, {
    headers: { Accept: "application/json" },
  });
  return res.json();
}

export async function apiPutJSON(path, body) {
  return request("PUT", u(path), {
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
  return request("POST", u(path), opts);
}

// JSON POST/PUT that throws on non-2xx and returns the parsed body. Used by
// the session create/kill/rename actions on Home.
export async function apiSend(path, opts = {}) {
  const merged = {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  };
  const method = opts.method || "GET";
  const res = await json(method, u(path), merged);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Host-pinned helpers (always the page's own origin) ────────────────
// Update + shell-integration + STT install/run act on the binary that served
// the page (mirrors update.js's `fetchPath`).

export async function localGet(path) {
  const res = await json("GET", u(path), {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  return res.json();
}

export async function localFetch(path, opts = {}) {
  return request((opts.method || "GET").toUpperCase(), u(path), {
    credentials: "same-origin",
    ...opts,
  });
}
