import { u } from "./base.js";

export const staticUrl = (path) => u(`/static/${path}`);

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
