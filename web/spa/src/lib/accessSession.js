import { signal } from "@preact/signals";
import { u } from "./base.js";

// Cloudflare Access answers a request whose session has lapsed with a
// redirect to the team's login page. A fetch made with redirect: "manual"
// sees that as an opaque redirect (no API route redirects), and a guard that
// still saw an expired token answers 401 with the cloudflare-access
// challenge. Either way the user is signed out: the app shows a persistent
// notice and never renders the failure as an empty list.
export const signedOut = signal(false);

const SIGNED_OUT_EVENT = "mobux:signed-out";

const ACCESS_LOGIN = /\.cloudflareaccess\.com$|\/cdn-cgi\/access\/login/;

function redirectsToLogin(res) {
  if (res.status !== 302 && res.status !== 303) return false;
  const location = res.headers.get("location") || "";
  try {
    const target = new URL(location, window.location.href);
    return (
      ACCESS_LOGIN.test(target.hostname) || ACCESS_LOGIN.test(target.pathname)
    );
  } catch (_) {
    return false;
  }
}

export function isSignedOutResponse(res) {
  if (res.type === "opaqueredirect") return true;
  if (redirectsToLogin(res)) return true;
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
