// Draws one line through a renderer on a throwaway buffer, the way the
// engine wires it, so a renderer can be proven before a terminal depends on
// it. The renderer's vendor bundle (and the headless one) must be loaded.

import { createXtermRenderer } from "./renderer-xterm.js";
import { createSterkRenderer } from "./renderer-sterk.js";
import { createTerminalBuffer } from "./terminal-buffer.js";
import { createRedrawWriter } from "./terminal-redraw.js";

export const PROBE_LINE = "mobux renderer probe";

const FACTORIES = { xterm: createXtermRenderer, sterk: createSterkRenderer };

const OPTIONS = {
  fontFamily: "monospace",
  fontSize: 13,
  scrollback: 100,
};

function drawnLine(renderer) {
  const { length } = renderer.viewport();
  for (let y = 0; y < length; y++) {
    if (renderer.rowText(y)?.includes(PROBE_LINE)) return true;
  }
  return false;
}

function start(name, host) {
  const parts = {};
  try {
    parts.renderer = FACTORIES[name](host, OPTIONS);
    parts.buffer = createTerminalBuffer({
      cols: parts.renderer.cols,
      rows: parts.renderer.rows,
      scrollback: OPTIONS.scrollback,
    });
    parts.view = parts.renderer.drawBuffer
      ? parts.renderer.drawBuffer(parts.buffer)
      : createRedrawWriter(parts.buffer, parts.renderer);
    return { ok: true, parts };
  } catch (err) {
    return { ok: false, parts, message: err.message };
  }
}

function teardown({ view, buffer, renderer }) {
  view?.dispose();
  buffer?.dispose();
  renderer?.dispose();
}

export async function probeRenderer(name, host) {
  const started = start(name, host);
  if (!started.ok) {
    teardown(started.parts);
    return { ok: false, step: "start", message: started.message };
  }
  const { parts } = started;
  const drawn = await parts.buffer
    .writeScreen(`${PROBE_LINE}\r\n`)
    .then(() => parts.view.settle())
    .then(
      () => ({ ok: drawnLine(parts.renderer) }),
      (err) => ({ ok: false, message: err.message }),
    );
  teardown(parts);
  if (drawn.ok) return { ok: true };
  return {
    ok: false,
    step: "draw",
    message: drawn.message || "the test line did not appear on screen",
  };
}
