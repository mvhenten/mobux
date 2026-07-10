// "Add to Home Screen" hint (#199-follow-up: the wasted top strip in a bare
// browser tab is Chrome's own address bar — the fix is running the PWA in
// `display: standalone` mode, per web/static/manifest.json). Device-level
// dismissal so it only nags once.

const DISMISS_KEY = "mobux:installHintDismissed";

export function isStandalone() {
  if (typeof window === "undefined") return true;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari's own non-standard flag; no matchMedia equivalent there.
    window.navigator.standalone === true
  );
}

export function isDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function dismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch (_) {}
}

export function shouldShowInstallHint() {
  return !isStandalone() && !isDismissed();
}
