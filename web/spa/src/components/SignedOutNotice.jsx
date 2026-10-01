import { signedOut } from "../lib/accessSession.js";

// Shown once a request finds the Cloudflare Access session lapsed. Reloading
// the current URL sends the top-level document through Cloudflare, which
// signs the user in and returns to this same screen (the hash route rides
// along). It stays until then: nothing on the page works while signed out.
export function SignedOutNotice() {
  if (!signedOut.value) return null;
  const here = window.location.href;
  return (
    <div id="signedOutNotice" class="signed-out-notice" role="alert">
      <span class="signed-out-text">
        Your Cloudflare Access session has ended. Sign in again to keep working.
      </span>
      <a
        id="signInAgain"
        class="signed-out-action"
        href={here}
        target="_top"
        onClick={(e) => {
          e.preventDefault();
          window.location.reload();
        }}
      >
        Sign in again
      </a>
    </div>
  );
}
