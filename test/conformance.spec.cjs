// Renderer conformance suite (issue #207, D10).
//
// One spec exercises the explicit renderer interface (R1–R11, R15–R16) and
// runs against BOTH adapters via the xterm/sterk Playwright projects
// (playwright.config.cjs) — a renderer is conformant when this suite is green
// on its project. Every probe goes through the engine's test surface
// (`window.__mobuxView.test.*`), never a renderer global, so the assertions
// are renderer-agnostic: the same code must pass on xterm and on sterk.
//
// Scope note: R1–R16 are asserted here, both adapters. R12–R14 (selection,
// links, bell) landed in stage 3 with sterk pinned to a published release, so
// the sterk-side gaps the earlier stages worked around (public alt-screen
// state, native selection, a link module, a bell event) are now real API and
// held to the same contract as xterm. See the PR description.

const { test, expect } = require("./fixtures.cjs");
const { execSync } = require("child_process");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const SESSION = process.env.MOBUX_TEST_SESSION || "mobux-conformance";

const { createTmuxRunner } = require("./lib/tmux.cjs");
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = createTmuxRunner("mobux-test");

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
  tmux(`send-keys -t ${SESSION} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${SESSION} "clear" Enter`);
  execSync("sleep 0.3");
});

test.afterAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
});

// Boot the terminal page and wait until the engine is live and its socket is
// open. Returns once `window.__mobuxView.test` is usable.
async function boot(page) {
  await page.goto(`${BASE}/app#/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== "undefined", {
    timeout: 8000,
  });
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    { timeout: 15000 },
  );
}

// Scan the whole buffer for a marker string. Renderer-agnostic — reads the
// R7 buffer read model through the engine.
async function bufferHasText(page, marker) {
  return page.evaluate((m) => {
    const len = window.__mobuxView.test.bufferLength();
    for (let y = 0; y < len; y++) {
      const t = window.__mobuxView.test.lineText(y);
      if (t && t.includes(m)) return true;
    }
    return false;
  }, marker);
}

// R1 — create / dispose. Mount attaches the engine test surface; a same-
// document navigation away disposes it (the island unmount path), tearing the
// surface down.
test("R1: create mounts the engine, navigation disposes it", async ({
  page,
}) => {
  await boot(page);
  expect(await page.evaluate(() => !!window.__mobuxView)).toBe(true);

  await page.goto(`${BASE}/app#/`);
  await page.waitForFunction(() => window.__mobuxView === undefined, {
    timeout: 8000,
  });
  expect(await page.evaluate(() => window.__mobuxView === undefined)).toBe(
    true,
  );
});

// R2 — write(data) resolves after the buffer reflects the data. (The stronger
// slow-CI flush guarantee for sterk is the upstream fix, stage 3; here both
// renderers must have the written text readable once the promise resolves.)
test("R2: write resolves after the buffer reflects the data", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() =>
    window.__mobuxView.test.inject("CONFORMANCE_R2_MARKER\n"),
  );
  expect(await bufferHasText(page, "CONFORMANCE_R2_MARKER")).toBe(true);
});

// R3 — measure() is the renderer's authoritative fit; R4 — cols/rows report
// the current grid. Both must be positive and self-consistent.
test("R3/R4: measure and current grid are positive", async ({ page }) => {
  await boot(page);
  const dims = await page.evaluate(() => ({
    m: window.__mobuxView.test.measure(),
    cell: window.__mobuxView.test.cellMetrics(),
    cols: window.__mobuxView.test.cols(),
    rows: window.__mobuxView.test.rows(),
  }));
  expect(dims.m.cols).toBeGreaterThan(0);
  expect(dims.m.rows).toBeGreaterThan(0);
  expect(dims.m.cellWidth).toBeGreaterThan(0);
  expect(dims.m.cellHeight).toBeGreaterThan(0);
  expect(dims.cell.width).toBeGreaterThan(0);
  expect(dims.cell.height).toBeGreaterThan(0);
  expect(dims.cols).toBeGreaterThan(0);
  expect(dims.rows).toBeGreaterThan(0);
});

// R5 — onInput carries keystrokes to the PTY. Type into the renderer's native
// input surface and confirm the shell echoes it back into the buffer.
test("R5: keystrokes typed into the renderer reach the PTY", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    window.__mobuxView.test.setNativeInputEnabled(true);
    window.__mobuxView.test.focus();
  });
  await page.keyboard.type("echo R5_CONFORMANCE_OK\r");
  await page.waitForFunction(
    () => {
      const len = window.__mobuxView.test.bufferLength();
      for (let y = 0; y < len; y++) {
        const t = window.__mobuxView.test.lineText(y);
        // The typed command line contains the literal marker; the echoed
        // output line contains it too. Either proves onInput reached the PTY.
        if (t && t.includes("R5_CONFORMANCE_OK")) return true;
      }
      return false;
    },
    { timeout: 15000 },
  );
});

// R6 — scroll: scrollLines moves the viewport off the bottom, scrollToBottom
// pins it back. Viewport position is read through the buffer.
test("R6: scrollLines and scrollToBottom move the viewport", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => window.__mobuxView.test.injectLines(300, "r6seed"));
  await page.waitForFunction(
    () => window.__mobuxView.test.bufferLength() > 200,
    { timeout: 10000 },
  );
  await page.evaluate(() => window.__mobuxView.test.scrollToBottom());
  const bottom = await page.evaluate(() => window.__mobuxView.test.viewportY());
  await page.evaluate(() => window.__mobuxView.test.scrollLines(-10));
  const scrolled = await page.evaluate(() =>
    window.__mobuxView.test.viewportY(),
  );
  expect(scrolled).toBeLessThan(bottom);
  await page.evaluate(() => window.__mobuxView.test.scrollToBottom());
  const back = await page.evaluate(() => window.__mobuxView.test.viewportY());
  expect(back).toBe(bottom);
});

// R7 — buffer read model: line + cell surface term-tokenizer.js consumes.
test("R7: buffer exposes lines and styled cells", async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    window.__mobuxView.test.inject("R7_CELL_SURFACE_XYZ\n"),
  );
  const info = await page.evaluate((m) => {
    const len = window.__mobuxView.test.bufferLength();
    for (let y = 0; y < len; y++) {
      const t = window.__mobuxView.test.lineText(y);
      if (t && t.includes(m)) {
        const x = t.indexOf(m);
        return { text: t, cell: window.__mobuxView.test.cellInfo(y, x) };
      }
    }
    return null;
  }, "R7_CELL_SURFACE_XYZ");
  expect(info).not.toBeNull();
  expect(info.cell).not.toBeNull();
  expect(info.cell.chars).toBe("R");
  expect(info.cell.code).toBe("R".charCodeAt(0));
  // The style surface term-tokenizer.js consumes is present and truthy-usable.
  // (xterm's predicates return a numeric attribute value, sterk's return a
  // boolean; both are consumed as truthy — the read model, not the JS type, is
  // the contract.)
  expect(info.cell.bold).toBeDefined();
  expect(info.cell.fgDefault).toBeDefined();
  expect(info.cell.bgDefault).toBeDefined();
});

// R8 — onBufferChanged fires after a write is parsed. Subscribe, then write
// in the same pass so the subscription is guaranteed live before the write.
test("R8: onBufferChanged fires after a write", async ({ page }) => {
  await boot(page);
  const observed = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let done = false;
        const settle = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        window.__mobuxView.test.awaitBufferChange().then(() => settle(true));
        setTimeout(() => settle(false), 5000);
        window.__mobuxView.test.writeData("R8_CHANGE\r\n");
      }),
  );
  expect(observed).toBe(true);
});

// R9 — alt-screen state reads false in normal operation. R16 — the "no
// alternate screen" policy holds: after the injected alt-screen-exit prefix
// the renderer reports the normal screen. (xterm additionally hard-blocks the
// alt buffer via its adapter stubs; sterk's own suppression is the upstream
// stage-3 item — both agree on the normal-operation contract asserted here.)
test("R9/R16: reports the normal (non-alternate) screen", async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    window.__mobuxView.test.inject("R9_NORMAL_SCREEN\n"),
  );
  expect(await page.evaluate(() => window.__mobuxView.test.isAlternate())).toBe(
    false,
  );
});

// R16 (mixed DEC private modes) — a CSI `?…h` that packs a blocked mode with
// an allowed one must suppress the blocked mode AND still apply the allowed
// one. Both adapters enforce the "no alt screen / no mouse" policy; neither may
// leak the alt buffer when a benign mode rides along, and neither may drop the
// benign mode. (xterm blocks via its alt/mouse stubs; sterk consumes the
// blocked mode at the parser and re-emits the allowed remainder.)
test("R16: mixed DEC private modes suppress the blocked mode, keep the allowed one", async ({
  page,
}) => {
  await boot(page);
  // Close the WS so tmux can't re-assert modes or clobber the injected content.
  await page.evaluate(() => window.__mobuxView.test.inject(""));

  // Alt-screen (1049) packed with cursor-visibility (25): the alt buffer must
  // not activate even though 25 is allowed through.
  await page.evaluate(() =>
    window.__mobuxView.test.writeData("\x1b[?1049;25h"),
  );
  expect(await page.evaluate(() => window.__mobuxView.test.isAlternate())).toBe(
    false,
  );

  // Mouse tracking (1002) packed with save-cursor (1048): the allowed 1048 must
  // still take effect. Save the cursor after a marker, move away, restore, then
  // print — the trailing char lands back at the saved column iff 1048 applied.
  await page.evaluate(() =>
    window.__mobuxView.test.writeData(
      "\x1b[2J\x1b[HR16SAVE\x1b[?1002;1048h\r\nR16OTHR\x1b[?1048lZ",
    ),
  );
  const restored = await page.evaluate(() => {
    const len = window.__mobuxView.test.bufferLength();
    for (let y = 0; y < len; y++) {
      const t = window.__mobuxView.test.lineText(y);
      if (t && t.includes("R16SAVEZ")) return true;
    }
    return false;
  });
  expect(restored).toBe(true);
  // Still no alt screen after the second sequence.
  expect(await page.evaluate(() => window.__mobuxView.test.isAlternate())).toBe(
    false,
  );
});

// R10 — the engine registers an OSC 133 handler through the renderer; an OSC
// 133 marker in the stream is detected and recorded.
test("R10: OSC 133 markers are detected via registerOscHandler", async ({
  page,
}) => {
  await boot(page);
  expect(await page.evaluate(() => window.__mobuxView.test.oscDetected())).toBe(
    false,
  );
  await page.evaluate(() =>
    window.__mobuxView.test.writeData("\x1b]133;A\x07prompt$ \r\n"),
  );
  await page.waitForFunction(
    () => window.__mobuxView.test.oscDetected() === true,
    { timeout: 5000 },
  );
  expect(
    await page.evaluate(() => window.__mobuxView.test.oscMarkerCount()),
  ).toBeGreaterThan(0);
});

// R11 — font size round-trips through the interface. (setTheme's renderer-
// specific palette application is covered by the theme-picker tests.)
test("R11: setFontSize / getFontSize round-trip", async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const before = window.__mobuxView.test.getFontSize();
    window.__mobuxView.test.setFontSize(before + 3);
    const after = window.__mobuxView.test.getFontSize();
    window.__mobuxView.test.setFontSize(before);
    return { before, after, restored: window.__mobuxView.test.getFontSize() };
  });
  expect(result.after).toBe(result.before + 3);
  expect(result.restored).toBe(result.before);
});

// R15 — the renderer owns its input surface: focus() and
// setNativeInputEnabled(bool) are callable and idempotent without throwing.
test("R15: focus and setNativeInputEnabled are callable", async ({ page }) => {
  await boot(page);
  const ok = await page.evaluate(() => {
    window.__mobuxView.test.setNativeInputEnabled(false);
    window.__mobuxView.test.setNativeInputEnabled(true);
    window.__mobuxView.test.setNativeInputEnabled(false);
    window.__mobuxView.test.focus();
    return true;
  });
  expect(ok).toBe(true);
});

// R12 — selection: selectAll produces a readable, non-empty selection that
// fires onSelectionChange; clearSelection empties it. Sterk implements it with
// native DOM selection, xterm with its selection API — same contract.
test("R12: selectAll, getSelection, onSelectionChange, clearSelection", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() =>
    window.__mobuxView.test.inject("R12_SELECTION_MARKER\n"),
  );
  await page.waitForFunction(() => window.__mobuxView.test.bufferLength() > 0, {
    timeout: 8000,
  });

  // Subscribe BEFORE selecting so the change event can't be missed.
  const changePromise = page.evaluate(
    () =>
      new Promise((resolve) => {
        let done = false;
        const settle = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        window.__mobuxView.test.awaitSelectionChange().then(() => settle(true));
        setTimeout(() => settle(false), 5000);
      }),
  );
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__mobuxView.test.selectAll());
  expect(await changePromise).toBe(true);

  expect(
    await page.evaluate(() => window.__mobuxView.test.hasSelection()),
  ).toBe(true);
  const selected = await page.evaluate(() =>
    window.__mobuxView.test.getSelection(),
  );
  expect(selected).toContain("R12_SELECTION_MARKER");

  await page.evaluate(() => window.__mobuxView.test.clearSelection());
  expect(
    await page.evaluate(() => window.__mobuxView.test.hasSelection()),
  ).toBe(false);
});

// R13 — links: a URL in the buffer, when activated, is reported through
// onLink. Both adapters detect the URL themselves (xterm: WebLinks addon;
// sterk: its link module) and fan the activation out to the UI.
test("R13: URL activation is reported through onLink", async ({ page }) => {
  await boot(page);
  const URL = "https://example.com/r13-conformance";

  // The coarse-pointer touch overlay and the loading splash both sit above the
  // terminal and would eat the click; drop them so the renderer's own link
  // layer sees the mouse (the desktop path). inject() closes the WS, so the
  // splash's first-data dismissal never fires on its own. The mobile
  // tap-to-open affordance is separate.
  await page.evaluate(() => {
    const o = document.getElementById("touchOverlay");
    if (o) o.style.pointerEvents = "none";
    const q = document.getElementById("loadquote");
    if (q) q.remove();
  });

  // `\x1b[K` erases to end of line after the URL so a residual char left on the
  // row by earlier output can't extend the detected link (the URL regex is
  // greedy up to the next whitespace).
  await page.evaluate(
    (u) => window.__mobuxView.test.inject(`open ${u}\x1b[K\n`),
    URL,
  );
  await page.evaluate(() => window.__mobuxView.test.scrollToBottom());
  await page.waitForFunction(
    (u) => {
      const len = window.__mobuxView.test.bufferLength();
      for (let y = 0; y < len; y++) {
        const t = window.__mobuxView.test.lineText(y);
        if (t && t.includes(u)) return true;
      }
      return false;
    },
    URL,
    { timeout: 10000 },
  );

  // Centre of the URL text, in viewport pixels.
  const point = await page.evaluate((u) => {
    const len = window.__mobuxView.test.bufferLength();
    const vy = window.__mobuxView.test.viewportY();
    const rows = window.__mobuxView.test.rows();
    const cell = window.__mobuxView.test.cellMetrics();
    const rect = document.getElementById("terminal").getBoundingClientRect();
    for (let y = vy; y < Math.min(len, vy + rows); y++) {
      const t = window.__mobuxView.test.lineText(y);
      const idx = t ? t.indexOf(u) : -1;
      if (idx >= 0) {
        const col = idx + Math.floor(u.length / 2);
        return {
          x: rect.left + (col + 0.5) * cell.width,
          y: rect.top + (y - vy + 0.5) * cell.height,
        };
      }
    }
    return null;
  }, URL);
  expect(point).not.toBeNull();

  const linkPromise = page.evaluate(
    () =>
      new Promise((resolve) => {
        let done = false;
        const settle = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        window.__mobuxView.test.awaitLink().then((uri) => settle(uri));
        setTimeout(() => settle(null), 6000);
      }),
  );
  await page.waitForTimeout(100);
  await page.mouse.move(point.x, point.y);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  expect(await linkPromise).toBe(URL);
});

// R13 (boundary) — the detected link excludes trailing punctuation, matching
// xterm's WebLinks addon (its regex forbids a URL ending in punctuation). A URL
// abutting a sentence-ending period links without the period on BOTH adapters.
test("R13: trailing punctuation is not part of the link", async ({ page }) => {
  await boot(page);
  const URL = "https://example.com/r13-boundary";

  await page.evaluate(() => {
    const o = document.getElementById("touchOverlay");
    if (o) o.style.pointerEvents = "none";
    const q = document.getElementById("loadquote");
    if (q) q.remove();
  });

  // The URL is followed immediately by a period. The detected link must stop
  // before it. `\x1b[K` erases any residual tail so it can't extend the match.
  await page.evaluate(
    (u) => window.__mobuxView.test.inject(`see ${u}.\x1b[K\n`),
    URL,
  );
  await page.evaluate(() => window.__mobuxView.test.scrollToBottom());
  await page.waitForFunction(
    (u) => {
      const len = window.__mobuxView.test.bufferLength();
      for (let y = 0; y < len; y++) {
        const t = window.__mobuxView.test.lineText(y);
        if (t && t.includes(`${u}.`)) return true;
      }
      return false;
    },
    URL,
    { timeout: 10000 },
  );

  // Click the centre of the URL body (excluding the trailing period).
  const point = await page.evaluate((u) => {
    const len = window.__mobuxView.test.bufferLength();
    const vy = window.__mobuxView.test.viewportY();
    const rows = window.__mobuxView.test.rows();
    const cell = window.__mobuxView.test.cellMetrics();
    const rect = document.getElementById("terminal").getBoundingClientRect();
    for (let y = vy; y < Math.min(len, vy + rows); y++) {
      const t = window.__mobuxView.test.lineText(y);
      const idx = t ? t.indexOf(u) : -1;
      if (idx >= 0) {
        const col = idx + Math.floor(u.length / 2);
        return {
          x: rect.left + (col + 0.5) * cell.width,
          y: rect.top + (y - vy + 0.5) * cell.height,
        };
      }
    }
    return null;
  }, URL);
  expect(point).not.toBeNull();

  const linkPromise = page.evaluate(
    () =>
      new Promise((resolve) => {
        let done = false;
        const settle = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        window.__mobuxView.test.awaitLink().then((uri) => settle(uri));
        setTimeout(() => settle(null), 6000);
      }),
  );
  await page.waitForTimeout(100);
  await page.mouse.move(point.x, point.y);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  // No trailing period — the reported URI is the bare URL on both adapters.
  expect(await linkPromise).toBe(URL);
});

// R14 — bell: a terminal BEL (0x07) is reported through onBell.
test("R14: terminal BEL is reported through onBell", async ({ page }) => {
  await boot(page);
  const observed = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let done = false;
        const settle = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        window.__mobuxView.test.awaitBell().then(() => settle(true));
        setTimeout(() => settle(false), 5000);
        window.__mobuxView.test.writeData("\x07");
      }),
  );
  expect(observed).toBe(true);
});
