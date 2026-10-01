import { signal } from "@preact/signals";
import { u } from "./base.js";

// Cloudflare Access answers a request whose session has lapsed with a
// redirect to the team's login page. A fetch made with redirect: "manual"
// sees that as an opaque redirect (no API route redirects), and a guard that
// still saw an expired token answers 401 with the cloudflare-access
// challenge. Either way the user is signed out: the app shows a persistent
// notice and never renders the failure as an empty list. Mirrored for the
// engine layer by web/static/access-session.js.
export const signedOut = signal(false);

const SIGNED_OUT_EVENT = "mobux:signed-out";

export function isSignedOutResponse(res) {
  if (res.type === "opaqueredirect") return true;
  return (
    res.status === 401 &&
    (res.headers.get("www-authenticate") || "").includes("cloudflare-access")
  );
}

export function markSignedOut() {
  signedOut.value = true;
}

// Checks whether a failure (a closed terminal socket, say) was the Access
// session lapsing. One request, made only when something already failed.
export async function probeSession() {
  if (signedOut.value) return true;
  const res = await fetch(u("/api/build-info"), {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    redirect: "manual",
  }).catch(() => null);
  if (!res) return false;
  res.body?.cancel().catch(() => {});
  if (isSignedOutResponse(res)) markSignedOut();
  return signedOut.value;
}

if (typeof window !== "undefined") {
  window.addEventListener(SIGNED_OUT_EVENT, markSignedOut);
}

// Cloudflare's login keeps the full URL it was sent from in its
// redirect_url, but a form-based login can drop the fragment, and the
// fragment is the SPA's route. The sign-in URL carries the route in the query
// too, and boot puts it back.
const ROUTE_PARAM = "mobux_route";

export function signInUrl(location = window.location) {
  const url = new URL(location.href);
  if (url.hash) url.searchParams.set(ROUTE_PARAM, url.hash);
  return url.href;
}

export function restoreSignInRoute(location = window.location) {
  const url = new URL(location.href);
  const route = url.searchParams.get(ROUTE_PARAM);
  if (route === null) return;
  url.searchParams.delete(ROUTE_PARAM);
  if (route.startsWith("#")) url.hash = route;
  window.history.replaceState(null, "", url.href);
}
