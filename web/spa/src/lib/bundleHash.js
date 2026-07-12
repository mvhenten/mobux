// The content hash Vite bakes into the currently-loaded entry script's
// filename (`assets/index-<hash>.js`), read straight off the DOM. This is the
// one hash guaranteed to describe the code running in this tab — no request,
// and crucially not re-derived from /static/build-info.json (which the server
// serves fresh, so a stale tab would read the server's new hash and hide its
// own staleness). A long-lived tab keeps whatever script tag it loaded with,
// so this stays pinned to the build the tab actually runs.
export function readLoadedBundleHash() {
  if (typeof document === "undefined") return null;
  const script = document.querySelector(
    'script[type="module"][src*="/assets/index-"]',
  );
  const match = script?.src.match(/index-([\w-]+)\.js/);
  return match ? match[1] : null;
}
