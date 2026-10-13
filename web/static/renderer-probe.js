// Starts a renderer under a throwaway engine and writes one line through it,
// so a renderer can be proven before a terminal depends on it. The engine is
// never connected. The renderer's vendor bundle (and the headless one) must
// be loaded.

import { TerminalEngine } from "./terminal-engine.js";
import { createXtermRenderer } from "./renderer-xterm.js";
import { createSterkRenderer } from "./renderer-sterk.js";

export const PROBE_LINE = "mobux renderer probe";

const FACTORIES = { xterm: createXtermRenderer, sterk: createSterkRenderer };

const OPTIONS = {
  fontFamily: "monospace",
  fontSize: 13,
  scrollback: 100,
};

function acceptedLine(renderer) {
  const { length } = renderer.viewport();
  for (let y = 0; y < length; y++) {
    if (renderer.rowText(y)?.includes(PROBE_LINE)) return true;
  }
  return false;
}

function startEngine(name, host) {
  let renderer = null;
  try {
    renderer = FACTORIES[name](host, OPTIONS);
    const engine = new TerminalEngine({
      session: "",
      host,
      renderer,
      scrollback: OPTIONS.scrollback,
    });
    return { ok: true, engine };
  } catch (err) {
    renderer?.dispose();
    return { ok: false, step: "start", message: err.message };
  }
}

function deadline(ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, step: "timeout" }), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

function acceptLine(engine) {
  return engine.buffer
    .writeScreen(`${PROBE_LINE}\r\n`)
    .then(() => engine.view.flush())
    .then(() => engine.view.settle())
    .then(
      () =>
        acceptedLine(engine.renderer)
          ? { ok: true }
          : {
              ok: false,
              step: "accept",
              message: "the test line never reached the renderer",
            },
      (err) => ({ ok: false, step: "accept", message: err.message }),
    );
}

export async function probeRenderer(name, host, timeoutMs) {
  const started = startEngine(name, host);
  if (!started.ok) return started;
  const limit = deadline(timeoutMs);
  const result = await Promise.race([
    acceptLine(started.engine),
    limit.expired,
  ]);
  limit.cancel();
  started.engine.dispose();
  return result;
}
