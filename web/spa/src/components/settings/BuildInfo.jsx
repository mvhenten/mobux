import { useEffect } from "preact/hooks";
import { signal, computed } from "@preact/signals";
import { localGet } from "../../lib/api.js";

// Build-info card. Ports the Build section of the Rust /settings page.
// Shows backend version, server bundle hash (from /api/build-info), and the
// FE bundle hash loaded in this tab (from /static/build-info.json — the same
// file written at build time). If they diverge the UI is stale and a
// hard-reload is needed.

const info = signal(null); // { version, build_hash }
const feHash = signal(null); // from /static/build-info.json

const stale = computed(() => {
  if (!info.value || !feHash.value) return false;
  return info.value.build_hash !== feHash.value;
});

export function BuildInfoCard() {
  useEffect(() => {
    localGet("/api/build-info")
      .then((d) => (info.value = d))
      .catch(() => {});

    localGet("/static/build-info.json")
      .then((d) => (feHash.value = d?.hash || null))
      .catch(() => {});
  }, []);

  const srv = info.value;
  const fe = feHash.value;

  return (
    <section class="settings-card" id="build-info">
      <h2>Build</h2>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Backend version</strong>
        </span>
        <span class="settings-value" id="buildVersion">
          {srv?.version || "…"}
        </span>
      </div>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Server bundle hash</strong>
          <small>
            Hash of the frontend bundle on disk when the server started.
          </small>
        </span>
        <span class="settings-value" id="buildServerHash">
          {srv?.build_hash || "…"}
        </span>
      </div>
      <div class="settings-row">
        <span class="settings-label">
          <strong>Loaded bundle hash</strong>
          <small>
            Hash of the bundle currently loaded in this browser tab.
          </small>
        </span>
        <span class="settings-value" id="buildFeHash">
          {fe || "—"}
        </span>
      </div>
      {stale.value && (
        <div class="settings-row" id="buildStaleRow">
          <span class="settings-label">
            <strong>Status</strong>
          </span>
          <span class="settings-value" style="color:#8a7c5a">
            stale — hard-reload needed
          </span>
        </div>
      )}
    </section>
  );
}
