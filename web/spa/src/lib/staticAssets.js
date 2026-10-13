import { u } from "./base.js";

// `CACHE_BUST` mirrors the old Rust page's `?v=` query-param convention on
// <script>/<link> tags, but it's a fixed string — it does no cache-busting
// of its own. What actually guarantees a stale cache never hands back an
// old bundle is `serve_static` in src/main.rs serving every /static/* asset
// `no-store, must-revalidate`; the query param is vestigial and harmless.
const CACHE_BUST = "spa";

export function staticUrl(path) {
  return u(`/static/${path}?v=${CACHE_BUST}`);
}

// Append a classic <script> and resolve when it loads. Deduped per document:
// the vendor bundles pin window globals (window.Terminal / window.Sterk) and
// chime.js self-boots, so each URL loads exactly once no matter how many
// times the terminal island mounts or the renderer probe runs.
const loadedScripts = new Map();
export function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = false; // preserve execution order
        el.onload = () => resolve();
        el.onerror = () => {
          loadedScripts.delete(src); // a later mount may retry
          el.remove();
          reject(new Error(`failed to load ${src}`));
        };
        document.body.appendChild(el);
      }),
    );
  }
  return loadedScripts.get(src);
}

export function ensureStylesheet(href) {
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
