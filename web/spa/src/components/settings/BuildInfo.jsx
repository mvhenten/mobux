import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { localGet } from "../../lib/api.js";
import { readLoadedBundleHash } from "../../lib/bundleHash.js";
import { Group, Lede, NavRow, ValueRow } from "./ui.jsx";

// The server's build_hash is web/static/build-info.json, which web/build.js
// computes over the terminal renderer bundles (xterm/sterk/headless) only.
// The SPA hash is the content hash Vite baked into the loaded script's
// filename. They describe two different builds, so they are shown side by
// side, never compared.

const info = signal(null);

function load() {
  localGet("/api/build-info")
    .then((d) => (info.value = d))
    .catch(() => {});
}

export function AboutRow() {
  useEffect(load, []);
  return (
    <NavRow
      row="about"
      to="/settings/about"
      label="About"
      value={info.value?.version || "…"}
    />
  );
}

export function BuildInfoCard() {
  useEffect(load, []);

  const srv = info.value;
  const feHash = readLoadedBundleHash();

  return (
    <div id="build-info">
      <Lede>
        The running binary and the bundles it serves. Quote these in a bug
        report.
      </Lede>
      <Group title="Build">
        <ValueRow
          label="App version"
          value={srv?.version || "…"}
          valueId="buildVersion"
        />
        <ValueRow
          label="Terminal bundle hash"
          secondary="Renderer bundles embedded in this server"
          value={srv?.build_hash || "…"}
          valueId="buildServerHash"
        />
        <ValueRow
          label="App bundle hash"
          secondary="SPA bundle loaded in this tab"
          value={feHash || "dev"}
          valueId="buildFeHash"
        />
      </Group>
    </div>
  );
}
