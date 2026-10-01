// Lapsed Cloudflare Access session detection for the engine layer
// (web/static). Cloudflare answers an expired session with a redirect to its
// login page, which a fetch made with redirect: "manual" sees as an opaque
// redirect (no API route redirects); the Access guard answers a token that
// expired in flight with a 401 carrying the cloudflare-access challenge.
// Either way the SPA's signed-out notice takes over (it listens for the
// event below). Mirrors web/spa/src/lib/accessSession.js, which the SPA
// bundle needs synchronously and cannot import from here.

export function signedOutResponse(res) {
  return (
    res.type === "opaqueredirect" ||
    (res.status === 401 &&
      (res.headers.get("www-authenticate") || "").includes("cloudflare-access"))
  );
}

export function reportSignedOut() {
  window.dispatchEvent(new Event("mobux:signed-out"));
}

// fetch() that never follows a redirect and reports a lapsed session. The
// response comes back as-is (an opaque redirect is not ok), so a caller's own
// !res.ok handling still runs.
export async function accessFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, redirect: "manual" });
  if (signedOutResponse(res)) reportSignedOut();
  return res;
}
