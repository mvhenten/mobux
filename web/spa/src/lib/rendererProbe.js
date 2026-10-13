import { loadScript, staticUrl } from "./staticAssets.js";

export const RENDERER_LABELS = { xterm: "xterm.js", sterk: "sterk" };
export const PROBE_TIMEOUT_MS = 5000;

const HEADLESS_BUNDLE = "vendor/xterm-headless.bundle.js";
const BUNDLES = {
  xterm: "vendor/xterm.bundle.js",
  sterk: "vendor/sterk.bundle.js",
};

export function rendererBundles(name) {
  return [HEADLESS_BUNDLE, BUNDLES[name]];
}

export function otherRenderer(name) {
  return name === "sterk" ? "xterm" : "sterk";
}

function fetchStatus(asset) {
  return fetch(staticUrl(asset), { cache: "no-store" }).then(
    (res) => ({ asset, status: res.status }),
    () => ({ asset, status: 0 }),
  );
}

async function checkAssets(name) {
  const results = await Promise.all(
    [`renderer-${name}.js`, ...rendererBundles(name)].map(fetchStatus),
  );
  const missing = results.find((r) => r.status !== 200);
  return missing ? { ok: false, step: "fetch", ...missing } : { ok: true };
}

function loadBundles(name) {
  return rendererBundles(name).reduce(
    (prev, asset) =>
      prev.then((result) =>
        result.ok
          ? loadScript(staticUrl(asset)).then(
              () => ({ ok: true }),
              () => ({ ok: false, step: "load", asset }),
            )
          : result,
      ),
    Promise.resolve({ ok: true }),
  );
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

async function drawLine(name) {
  const asset = "renderer-probe.js";
  const imported = await import(/* @vite-ignore */ staticUrl(asset)).then(
    (mod) => ({ ok: true, mod }),
    (err) => ({ ok: false, step: "import", asset, message: err.message }),
  );
  if (!imported.ok) return imported;
  const host = probeHost();
  const result = await imported.mod.probeRenderer(name, host).then(
    (r) => r,
    (err) => ({ ok: false, step: "draw", message: err.message }),
  );
  host.remove();
  return result;
}

async function runSteps(name, progress) {
  progress.step = "fetch";
  const assets = await checkAssets(name);
  if (!assets.ok) return assets;
  progress.step = "load";
  const loaded = await loadBundles(name);
  if (!loaded.ok) return loaded;
  progress.step = "start";
  return drawLine(name);
}

// End-to-end check that `name` can run in this browser: its files are
// served, its bundles execute, and an offscreen instance draws a line.
export function probeRenderer(name) {
  const progress = { step: "fetch" };
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, step: "timeout", during: progress.step }),
      PROBE_TIMEOUT_MS,
    );
  });
  return Promise.race([runSteps(name, progress), timedOut]).then((result) => {
    clearTimeout(timer);
    return result;
  });
}

const REINSTALL =
  "This mobux install is missing or serving a broken file; update or reinstall mobux, then try again.";

const STEP_NAMES = {
  fetch: "downloading its files",
  load: "loading its bundle",
  start: "starting it",
};

export function describeProbeFailure(name, failure) {
  const label = RENDERER_LABELS[name];
  const path = failure.asset ? `/static/${failure.asset}` : "";
  if (failure.step === "fetch") {
    const status = failure.status
      ? `HTTP ${failure.status}`
      : "no response (network error)";
    const fix =
      failure.status === 401 || failure.status === 403
        ? "Your session may have ended; reload the page to sign in again."
        : failure.status
          ? REINSTALL
          : "Check the connection to the host and try again.";
    return { what: `${label} check failed: ${path} returned ${status}.`, fix };
  }
  if (failure.step === "load") {
    return {
      what: `${label} check failed: ${path} did not load.`,
      fix: REINSTALL,
    };
  }
  if (failure.step === "import") {
    return {
      what: `${label} check failed: ${path} did not import (${failure.message}).`,
      fix: REINSTALL,
    };
  }
  if (failure.step === "timeout") {
    return {
      what: `${label} check timed out after ${PROBE_TIMEOUT_MS / 1000} s while ${STEP_NAMES[failure.during]}.`,
      fix: "Check the connection to the host and try again.",
    };
  }
  return {
    what: `${label} failed while ${failure.step === "start" ? "starting" : "drawing a test line"}: ${failure.message}.`,
    fix: "Keep the current renderer and report an issue.",
  };
}
