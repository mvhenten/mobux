import { signInUrl, signedOut } from "../lib/accessSession.js";

// Shown once a request finds the Cloudflare Access session lapsed. Loading
// the sign-in URL sends the top-level document through Cloudflare, which
// signs the user in and returns to it; boot restores the route it carries
// (restoreSignInRoute), so the user lands on this same screen. It stays until
// then: nothing on the page works while signed out.
export function SignedOutNotice() {
  if (!signedOut.value) return null;
  const target = signInUrl();
  return (
    <div id="signedOutNotice" class="signed-out-notice" role="alert">
      <span class="signed-out-text">
        Your Cloudflare Access session has ended. Sign in again to keep working.
      </span>
      <a id="signInAgain" class="signed-out-action" href={target} target="_top">
        Sign in again
      </a>
    </div>
  );
}
