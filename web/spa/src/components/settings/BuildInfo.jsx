import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { localGet } from "../../lib/api.js";

// Build-info card. Shows the backend version, the server's build_hash
// (/api/build-info — unchanged, server-side), and the SPA's own bundle hash.
//
// The SPA hash is NOT re-derived from web/static/build-info.json: that file
// only hashes the two terminal-renderer bundles (xterm/sterk, see
// web/build.js), so it never matched this bundle and comparing them as
// "server vs loaded" was comparing two unrelated builds. Instead this reads
// the content hash Vite already baked into the currently-loaded script's
// filename (`assets/index-<hash>.js`) straight off the DOM — the one hash
// that's actually guaranteed to describe the code running in this tab, no
// extra request needed.

const info = signal(null); // { version, build_hash }

function readLoadedBundleHash() {
  const script = document.querySelector(
    'script[type="module"][src*="/assets/index-"]',
  );
  const match = script?.src.match(/index-([\w-]+)\.js/);
  return match ? match[1] : null;
}

export function BuildInfoCard() {
  useEffect(() => {
    localGet("/api/build-info")
      .then((d) => (info.value = d))
      .catch(() => {});
  }, []);

  const srv = info.value;
  const feHash = readLoadedBundleHash();

  return (
    <section class="settings-group" id="build-info">
      <h2>Build</h2>
      <div class="settings-row">
        <span class="settings-label">
          <strong>App version</strong>
        </span>
        <span class="settings-value" id="buildVersion">
          {srv?.version || "…"}
        </span>
      </div>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Server build hash</strong>
          <small>Hash of the frontend bundle this server has on disk.</small>
        </span>
        <span class="settings-value" id="buildServerHash">
          {srv?.build_hash || "…"}
        </span>
      </div>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Frontend bundle hash</strong>
          <small>Hash of the SPA bundle loaded in this browser tab.</small>
        </span>
        <span class="settings-value" id="buildFeHash">
          {feHash || "dev"}
        </span>
      </div>
    </section>
  );
}
