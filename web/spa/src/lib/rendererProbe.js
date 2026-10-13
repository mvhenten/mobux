import { ensureStylesheet, loadScript, staticUrl } from "./staticAssets.js";

export const RENDERER_LABELS = { xterm: "xterm.js", sterk: "sterk" };
export const PROBE_TIMEOUT_MS = 5000;

const BUNDLES = {
  xterm: ["vendor/xterm-headless.bundle.js", "vendor/xterm.bundle.js"],
  sterk: ["vendor/xterm-headless.bundle.js", "vendor/sterk.bundle.js"],
};

export function otherRenderer(name) {
  return name === "sterk" ? "xterm" : "sterk";
}

// Loads the renderer's vendor bundles (and its stylesheet) once per document.
// Resolves `{ ok: false, asset }` naming the first bundle that did not load.
export async function loadRenderer(name) {
  if (name === "xterm") ensureStylesheet(staticUrl("vendor/xterm.css"));
  const results = await Promise.allSettled(
    BUNDLES[name].map((asset) => loadScript(staticUrl(asset))),
  );
  const failed = results.findIndex((r) => r.status === "rejected");
  return failed === -1
    ? { ok: true }
    : { ok: false, asset: BUNDLES[name][failed] };
}

function fetchStatus(asset) {
  return fetch(staticUrl(asset), { cache: "no-store" }).then(
    (res) => res.status,
    () => 0,
  );
}

function timeLeft(deadlineAt) {
  return Math.max(0, deadlineAt - performance.now());
}

function beforeDeadline(promise, deadlineAt) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, step: "timeout" }),
      timeLeft(deadlineAt),
    );
  });
  return Promise.race([promise, expired]).then((result) => {
    clearTimeout(timer);
    return result;
  });
}

function probeHost() {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.dataset.rendererProbe = "";
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "640px",
    height: "320px",
    pointerEvents: "none",
  });
  document.body.appendChild(host);
  return host;
}

async function loadStep(name, deadlineAt) {
  const loaded = await beforeDeadline(loadRenderer(name), deadlineAt);
  if (loaded.ok || loaded.step === "timeout") return loaded;
  const status = await fetchStatus(loaded.asset);
  return { ok: false, step: "load", asset: loaded.asset, status };
}

function importStep(deadlineAt) {
  const asset = "renderer-probe.js";
  return beforeDeadline(
    import(/* @vite-ignore */ staticUrl(asset)).then(
      (mod) => ({ ok: true, mod }),
      (err) => ({ ok: false, step: "import", asset, message: err.message }),
    ),
    deadlineAt,
  );
}

// End-to-end check that `name` can run in this browser: its bundles load,
// its module imports, and an offscreen instance starts and accepts a line.
export async function probeRenderer(name) {
  const deadlineAt = performance.now() + PROBE_TIMEOUT_MS;
  const loaded = await loadStep(name, deadlineAt);
  if (!loaded.ok) return loaded;
  const imported = await importStep(deadlineAt);
  if (!imported.ok) return imported;
  const host = probeHost();
  const result = await imported.mod.probeRenderer(
    name,
    host,
    timeLeft(deadlineAt),
  );
  host.remove();
  return result;
}

const REINSTALL =
  "This mobux install is missing or serving a broken file; update or reinstall mobux, then try again.";

function loadFix(status) {
  if (status === 401 || status === 403) {
    return "Your session may have ended; reload the page to sign in again.";
  }
  if (status === 0) return "Check the connection to the host and try again.";
  return REINSTALL;
}

export function describeProbeFailure(name, failure) {
  const label = RENDERER_LABELS[name];
  if (failure.step === "load") {
    const status = failure.status
      ? `HTTP ${failure.status}`
      : "no response (network error)";
    return {
      what: `${label} check failed: /static/${failure.asset} returned ${status}.`,
      fix: loadFix(failure.status),
    };
  }
  if (failure.step === "import") {
    return {
      what: `${label} check failed: /static/${failure.asset} did not import (${failure.message}).`,
      fix: REINSTALL,
    };
  }
  if (failure.step === "timeout") {
    return {
      what: `${label} check timed out after ${PROBE_TIMEOUT_MS / 1000} s.`,
      fix: "Check the connection to the host and try again.",
    };
  }
  const stage = failure.step === "start" ? "starting" : "accepting a test line";
  return {
    what: `${label} failed while ${stage}: ${failure.message}.`,
    fix: "Keep the current renderer and report an issue.",
  };
}
