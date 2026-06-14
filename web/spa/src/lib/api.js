// Thin fetch wrappers for the Rust backend. In dev these are same-origin
// requests to the Vite server on :5173, which proxies to the backend on :5152
// (attaching Basic auth server-side). In production the SPA will be served by
// the backend itself, so these stay same-origin. No mesh/peer rewriting yet —
// that is a later migration phase; phase 1 talks to the page's own host only.

export async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

export async function apiPutJSON(path, body) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

export async function apiPost(path) {
  return fetch(path, { method: 'POST' });
}
