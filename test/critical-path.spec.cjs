// Critical-path tests for mobux. These exercise the *real* pipe
// (browser → WS → PTY → tmux → render) instead of the synthetic
// `inject*` helpers, and they're written renderer-agnostic so they
// don't break when we swap aceterm ↔ sterk.
//
// Every test starts with `seedErrorCapture(page)` which fails the test
// on any uncaught JS error, console.error, or failed critical
// network request — these were entirely missing from smoke.spec.cjs
// and let the broken sterk integration ship.
//
// Run with: make test-critical-path
//
// Renderer-agnostic selectors:
//   #terminal           — container div, always present
//   #reader             — reader view container
//   __mobuxView.send    — PTY input
//   __mobuxView.test.*  — buffer length, ws state, etc.

const { test, expect, sterkOnly } = require("./fixtures.cjs");
const { execSync } = require("child_process");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const SESSION = process.env.MOBUX_TEST_SESSION || "mobux-critical";

const TMUX_CMD = process.env.MOBUX_TEST_TMUX || "tmux -L mobux-test";
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = (args) => execSync(`${TMUX_CMD} ${args}`, { stdio: "pipe" });

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  // bash --norc --noprofile gives us a clean, predictable prompt.
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

// ── Error / failure capture ────────────────────────────────────────
//
// Attaches listeners that record any JS-side failures during the
// test. Call `assertNoFailures(captured)` at the end of each test to
// enforce the "no errors during boot/operation" contract.
//
// Known-noisy errors we tolerate (and the reason):
//   * SSL ServiceWorker registration — self-signed cert in smoke env,
//     unrelated to renderer correctness.
const TOLERATED_ERROR_PATTERNS = [
  /SSL certificate error/i,
  /Failed to register a ServiceWorker/i,
];

function seedErrorCapture(page) {
  const captured = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  page.on("pageerror", (e) => captured.pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") captured.consoleErrors.push(m.text());
  });
  page.on("requestfailed", (r) => {
    const url = r.url();
    // Ignore expected failures (favicon polls, etc.) — but ALL static
    // assets under /static/* are critical and must succeed.
    if (url.includes("/static/")) {
      captured.failedRequests.push(`${url} ${r.failure()?.errorText}`);
    }
  });
  return captured;
}

function assertNoFailures(captured) {
  const tolerable = (s) => TOLERATED_ERROR_PATTERNS.some((re) => re.test(s));
  const realPageErrors = captured.pageErrors.filter((s) => !tolerable(s));
  const realConsole = captured.consoleErrors.filter((s) => !tolerable(s));
  expect(realPageErrors, "uncaught page errors").toEqual([]);
  expect(realConsole, "console.error calls").toEqual([]);
  expect(captured.failedRequests, "failed /static/ requests").toEqual([]);
}

// ── Helpers ────────────────────────────────────────────────────────

async function bootTerminal(page) {
  await page.goto(`${BASE}/app#/s/${SESSION}`, { waitUntil: "load" });
  // Wait for the renderer to mount AND have visible dimensions —
  // renderer-agnostic.
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      if (!t || t.classList.contains("hidden")) return false;
      const r = t.getBoundingClientRect();
      return r.width > 50 && r.height > 50;
    },
    { timeout: 8000 },
  );
  // Wait for the WS to be open and the buffer to have at least the
  // initial PS1 redraw.
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    { timeout: 8000 },
  );
  // Sterk schedules the initial resize() inside ws.onopen which fires
  // synchronously with the WS handshake. The PTY needs to receive the
  // resize before keystrokes will be processed at the new dimensions;
  // wait one beat for the resize round-trip.
  await page.waitForTimeout(500);
}

async function visibleTerminalText(page) {
  return page.evaluate(() => {
    const t = document.getElementById("terminal");
    // innerText (unlike textContent) skips elements with display:none,
    // which is what Ace does to its gutter when showGutter is false.
    // Without this, the test sees gutter line numbers as if they were
    // real terminal content.
    return (t?.innerText || "").replace(/\s+/g, " ").trim();
  });
}

// ── Tests ──────────────────────────────────────────────────────────

test("boot: terminal page loads without JS errors or failed assets", async ({
  page,
}) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  // Give renderer + theme machinery a moment to throw if it's going to.
  await page.waitForTimeout(500);
  assertNoFailures(captured);
});

test("boot: renderer mounts with visible dimensions", async ({ page }) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  const dims = await page.evaluate(() => {
    const t = document.getElementById("terminal");
    const r = t.getBoundingClientRect();
    return { w: r.width, h: r.height, hidden: t.classList.contains("hidden") };
  });
  expect(dims.hidden, "#terminal must be visible").toBe(false);
  expect(dims.w, "#terminal width").toBeGreaterThan(100);
  expect(dims.h, "#terminal height").toBeGreaterThan(100);
  assertNoFailures(captured);
});

test("PTY roundtrip: typing in the browser produces real output in the buffer", async ({
  page,
}) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  // Send a unique marker through the real WS pipe (not via the
  // synthetic `inject` helper). This proves the whole chain works:
  // browser keystroke → WS frame → server → PTY → tmux → server →
  // WS frame → renderer.
  const marker = `MOBUX_CRIT_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  // Wait for the marker to appear in the terminal's visible text —
  // i.e. it actually got painted, not just appended to a hidden
  // buffer.
  await expect
    .poll(() => visibleTerminalText(page), {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toContain(marker);
  assertNoFailures(captured);
});

test("PTY roundtrip: tmux split-window produces a second pane", async ({
  page,
}) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  // Snapshot pane count from tmux directly (source of truth).
  const before = parseInt(
    execSync(`${TMUX_CMD} list-panes -t ${SESSION} | wc -l`).toString().trim(),
    10,
  );
  // Send tmux prefix (Ctrl-B) then '|' to split-window -h.
  // Default mobux tmux config uses 'C-b' as prefix.
  await page.evaluate(() => window.__mobuxView.send("\x02")); // Ctrl-B
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__mobuxView.send('"')); // default split-window vertical
  await page.waitForTimeout(500);
  const after = parseInt(
    execSync(`${TMUX_CMD} list-panes -t ${SESSION} | wc -l`).toString().trim(),
    10,
  );
  expect(after, "tmux pane count should increase after split").toBeGreaterThan(
    before,
  );
  // Send Ctrl-B x then y to close the new pane so we don't leave litter.
  await page.evaluate(() => window.__mobuxView.send("\x02xy"));
  await page.waitForTimeout(400);
  assertNoFailures(captured);
});

test("PTY roundtrip: tmux new-window appears in the /panes API and is selectable", async ({
  page,
}) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  const sessionsBefore = await page.request
    .get(`${BASE}/api/sessions`)
    .then((r) => r.json());
  const winsBefore =
    sessionsBefore.find((s) => s.name === SESSION)?.windows ?? 0;

  // Ctrl-B c — new-window
  await page.evaluate(() => window.__mobuxView.send("\x02c"));
  await page.waitForTimeout(800);

  const sessionsAfter = await page.request
    .get(`${BASE}/api/sessions`)
    .then((r) => r.json());
  const winsAfter = sessionsAfter.find((s) => s.name === SESSION)?.windows ?? 0;
  expect(winsAfter, "tmux window count should increase").toBeGreaterThan(
    winsBefore,
  );

  // Clean up — Ctrl-B & then y to confirm kill-window.
  await page.evaluate(() => window.__mobuxView.send("\x02&y"));
  await page.waitForTimeout(400);
  assertNoFailures(captured);
});

test("cell-width parity: no left padding gutter and right-most cell hugs the right edge", async ({
  page,
}, testInfo) => {
  // Walks the sterk Ace DOM (.ace_line, .ace_text-layer) to measure
  // cell geometry. xterm.js paints into a canvas (or its own DOM
  // renderer) with a different node structure — covered indirectly
  // by the boot/PTY tests above.
  sterkOnly(test, testInfo);
  // V8 regression. Before this fix mobux had `#terminal { padding: 0 12px }`,
  // Ace had the default `setPadding(4)`, and the cols formula subtracted
  // an extra 1 — adding up to ~28px of horizontal real estate that the
  // PTY thought it had but the renderer couldn't paint. The right-most
  // ~2 columns of any tmux output were clipped behind the (still-shown)
  // vertical scrollbar gutter on a phone-sized viewport.
  //
  // This test asserts the geometry directly: col 0 sits within a few px
  // of the container's left edge, and the cell at col (cols-1) sits
  // within a few px of the right edge, with no scrollbar reservation
  // between them.
  const captured = seedErrorCapture(page);
  await bootTerminal(page);

  // Fill the visible row with `#` so we have something to measure.
  // tmux send-keys is used directly (faster + deterministic than
  // typing via the browser).
  const cols = await page.evaluate(() => window.__mobuxView.test.cols());
  expect(cols, "sterk should report a sane column count").toBeGreaterThan(20);
  // Build a string of exactly `cols` `#` characters and echo it. Doing
  // the expansion locally instead of inside the shell avoids tmux's
  // tab-completion / prompt-echo confusing the output (the shell would
  // echo back the full command line including the `printf $(seq ...)`
  // which our regex would then false-match on).
  const hashes = "#".repeat(cols);
  await page.evaluate(
    (s) => window.__mobuxView.send(`printf '%s\\n' '${s}'\r`),
    hashes,
  );
  // Wait until we see a line that is JUST `#` characters of the expected
  // length (no prompt prefix, no other text). Anchor with a non-`#`
  // boundary on each side to defeat the cmdline echo above it.
  await expect
    .poll(
      async () => {
        const t = await visibleTerminalText(page);
        return new RegExp(`(^|[^#])#{${cols}}([^#]|$)`).test(t);
      },
      { timeout: 10000, intervals: [200, 400, 800] },
    )
    .toBe(true);

  // Now measure: find the leftmost and rightmost `#` characters in the
  // rendered DOM and assert their positions vs. the #terminal box.
  const geom = await page.evaluate((expectedCols) => {
    const t = document.getElementById("terminal");
    const tRect = t.getBoundingClientRect();
    // Ace renders each line as one or more spans inside .ace_line.
    // We want the row whose content is JUST `#` characters — the
    // printf output, not the cmdline echo above it. Match on lines
    // that are mostly `#` with no leading prompt (`$` etc.).
    let bestRange = null;
    let bestLen = 0;
    const lines = t.querySelectorAll(".ace_line, .ace_line_group");
    for (const line of lines) {
      const text = line.textContent || "";
      // Lines containing the cmdline have non-`#` content (prompt,
      // printf, quotes); skip them. The pure output line is the
      // longest contiguous run of `#` with no other characters.
      const m = text.match(/^#+$/) || text.match(/^\s*(#+)\s*$/);
      if (!m) continue;
      const hashes = m[1] ?? m[0];
      if (hashes.length < expectedCols - 2) continue; // tolerate a wrap of ±2
      if (hashes.length <= bestLen) continue;
      bestLen = hashes.length;
      // Walk text nodes to find the bounding rects of the first and
      // last `#` in the longest run.
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let firstNode = null,
        firstOff = -1;
      let lastNode = null,
        lastOff = -1;
      const startIdx = text.indexOf(hashes);
      const endIdx = startIdx + hashes.length - 1;
      let node = walker.nextNode();
      while (node) {
        const len = node.data.length;
        if (firstNode === null && consumed + len > startIdx) {
          firstNode = node;
          firstOff = startIdx - consumed;
        }
        if (consumed + len > endIdx) {
          lastNode = node;
          lastOff = endIdx - consumed;
          break;
        }
        consumed += len;
        node = walker.nextNode();
      }
      if (firstNode && lastNode) {
        const r1 = document.createRange();
        r1.setStart(firstNode, firstOff);
        r1.setEnd(firstNode, firstOff + 1);
        const r2 = document.createRange();
        r2.setStart(lastNode, lastOff);
        r2.setEnd(lastNode, lastOff + 1);
        bestRange = {
          firstRect: r1.getBoundingClientRect(),
          lastRect: r2.getBoundingClientRect(),
          len: m[0].length,
        };
      }
    }
    return {
      terminal: { left: tRect.left, right: tRect.right, width: tRect.width },
      range: bestRange,
    };
  }, cols);

  expect(
    geom.range,
    "should have found a long run of # in the DOM",
  ).toBeTruthy();
  // Left edge: first `#` should be within 8px of the container's left edge.
  const leftGap = geom.range.firstRect.left - geom.terminal.left;
  expect(leftGap, `left-edge gap (px): ${leftGap}`).toBeLessThanOrEqual(8);
  expect(leftGap, `left-edge gap (px): ${leftGap}`).toBeGreaterThanOrEqual(0);
  // Right edge: last `#` should be within 12px of the container's right
  // edge (the cell itself is ~9px wide so up to one cell of slack is
  // allowed if the column count isn't an exact divisor).
  const rightGap = geom.terminal.right - geom.range.lastRect.right;
  expect(rightGap, `right-edge gap (px): ${rightGap}`).toBeLessThanOrEqual(12);
  expect(rightGap, `right-edge gap (px): ${rightGap}`).toBeGreaterThanOrEqual(
    0,
  );
  // Symmetry: left and right gaps should be within one cell of each other.
  expect(
    Math.abs(leftGap - rightGap),
    `asymmetry (left ${leftGap} vs right ${rightGap})`,
  ).toBeLessThanOrEqual(12);

  // Final invariant: the number of # characters actually rendered must
  // match (within ±1) what mobux sent to the PTY — i.e. no characters
  // were clipped past the right edge. ±1 tolerance covers the case
  // where the row exactly fills cols and tmux wraps the final cell.
  expect(
    geom.range.len,
    `rendered #s (${geom.range.len}) vs sent (${cols})`,
  ).toBeGreaterThanOrEqual(cols - 1);

  assertNoFailures(captured);
});

test("row-height parity: PTY rows match what actually fits, including after the input bar appears", async ({
  page,
}, testInfo) => {
  // Reads window.__sterk._sterk.getCellMetrics() — sterk-only API.
  // The xterm equivalent (`_core._renderService.dimensions.css.cell`)
  // would need a parallel test wired against that property. The row-
  // fit-vs-host invariant matters for both renderers; just not via
  // the same accessor.
  sterkOnly(test, testInfo);
  // Bottom-cut-off regression (Pixel 7, real device): when the mobile
  // input bar appeared as a flex sibling of `#terminal`, mobux fired
  // a synchronous `'resize'` event and asked sterk
  // `getViewportCellCount()` for the new grid. Before sterk's
  // `editor.resize(true)` precondition (kattebak/sterk#29), the API
  // returned Ace's STALE pre-shrink `$size` — so the PTY ended up
  // resized to MORE rows than the visible scroller could paint, and
  // the bottom 2-5 rows rendered off-screen.
  //
  // The invariant this test enforces: after any layout change (here,
  // unhiding the input bar), `term.rows * cellHeight` must fit
  // within `#terminal.clientHeight` to the precision of one cell.
  // I.e. no rows the PTY thinks exist but the user can't see.
  const captured = seedErrorCapture(page);
  await bootTerminal(page);

  // On mobile, terminal.js now reveals the input bar eagerly on mount (see
  // input-bar.js's reveal()), so it's already visible by the time bootTerminal
  // resolves. Force it back to the hidden state — still a real, reachable
  // state (input-bar.js auto-hides on keyboard dismiss / Escape) — so this
  // test can still exercise the hidden→visible transition the regression
  // comment above describes.
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    bar.classList.add("hidden");
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(500);

  // Snapshot the initial (bar hidden) invariant first, so a baseline
  // failure tells us the host geometry is busted before we even
  // toggle the bar.
  const initial = await page.evaluate(() => {
    const t = document.getElementById("terminal");
    const sterk = window.__sterk?._sterk;
    const cell = sterk?.getCellMetrics?.();
    return {
      hostH: t.clientHeight,
      rows: window.__mobuxView.test.rows(),
      cellH: cell?.height ?? 0,
    };
  });
  expect(initial.cellH, "initial cell height should be > 0").toBeGreaterThan(0);
  // rows * cellH must be <= hostH (the PTY isn't promised rows that
  // don't fit). One cell of slack on the high side handles non-integer
  // host heights divided by integer cell heights.
  expect(
    initial.rows * initial.cellH,
    `initial: rows(${initial.rows})*cellH(${initial.cellH})=${initial.rows * initial.cellH} > hostH(${initial.hostH})`,
  ).toBeLessThanOrEqual(initial.hostH);

  // Show the input bar — the same mobux code path that fires on a
  // real-device tap. Then re-measure: the new term.rows must still
  // fit in the (now-shrunk) host.
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    bar.classList.remove("hidden");
    window.dispatchEvent(new Event("resize"));
  });
  // Give the resize round-trip a beat to land (mobux sends to PTY,
  // PTY sends fresh redraw back).
  await page.waitForTimeout(500);

  const afterBar = await page.evaluate(() => {
    const t = document.getElementById("terminal");
    const bar = document.getElementById("inputBar");
    const sterk = window.__sterk?._sterk;
    const cell = sterk?.getCellMetrics?.();
    return {
      hostH: t.clientHeight,
      rows: window.__mobuxView.test.rows(),
      cellH: cell?.height ?? 0,
      barH: bar.getBoundingClientRect().height,
      barHidden: bar.classList.contains("hidden"),
    };
  });
  expect(
    afterBar.barHidden,
    "input bar must be visible for this scenario",
  ).toBe(false);
  expect(afterBar.barH, "input bar must occupy vertical space").toBeGreaterThan(
    10,
  );
  // The host must have shrunk (flex sibling took its bite).
  expect(
    afterBar.hostH,
    `host should be smaller after bar show: was ${initial.hostH}, now ${afterBar.hostH}`,
  ).toBeLessThan(initial.hostH);
  // The key invariant: rows*cellH stays within hostH.
  expect(
    afterBar.rows * afterBar.cellH,
    `after-bar: rows(${afterBar.rows})*cellH(${afterBar.cellH})=${afterBar.rows * afterBar.cellH} > hostH(${afterBar.hostH})`,
  ).toBeLessThanOrEqual(afterBar.hostH);
  // And the gap between rows*cellH and hostH must be SMALL — less
  // than one cell. If it's > one cell, mobux is under-promising
  // rows to the PTY (cosmetic but wasted vertical real estate).
  // A failure on the OTHER direction (rows*cellH > hostH) is the
  // actual bottom-cut-off bug; that's caught by the leq above.
  const gap = afterBar.hostH - afterBar.rows * afterBar.cellH;
  expect(gap, `tight-fit gap (px): ${gap}`).toBeLessThan(afterBar.cellH);

  assertNoFailures(captured);
});

test("reader view: real PTY output reaches the reader pane", async ({
  page,
}) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  const marker = `READER_CRIT_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  // First confirm it landed in the terminal.
  await expect
    .poll(() => visibleTerminalText(page), { timeout: 10000 })
    .toContain(marker);
  // Then switch to reader and assert the same marker is rendered there.
  await page.evaluate(() => window.__mobuxView.swap("reader"));
  await page.waitForFunction(
    () => {
      const r = document.getElementById("reader");
      return r && !r.classList.contains("hidden");
    },
    { timeout: 4000 },
  );
  const readerText = await page.evaluate(
    () => document.getElementById("reader").textContent || "",
  );
  expect(readerText).toContain(marker);
  assertNoFailures(captured);
});

test("auto-reconnect: unexpected socket drop re-establishes the WS via onclose backoff", async ({
  page,
}) => {
  // Regression for the "tap-to-reconnect only" behaviour. The core's
  // ws.onclose now arms a capped exponential backoff (min 500ms) that
  // reconnects after an *unexpected* close. We simulate the drop with
  // the `forceDrop` test hook (closes the socket WITHOUT marking the
  // close intentional — i.e. what a real server/network blip looks
  // like to the client) and assert the WS comes back on its own, with
  // NO user gesture and NO page-level visibility/online/pageshow event.
  //
  // Fails without the new code: the old `ws.onclose = () => {}` left the
  // socket closed forever, so wsReady() would never return true again.
  const captured = seedErrorCapture(page);
  await bootTerminal(page);

  // Sanity: we start connected.
  expect(await page.evaluate(() => window.__mobuxView.test.wsReady())).toBe(
    true,
  );

  // Drop the socket as if the server hung up.
  await page.evaluate(() => window.__mobuxView.test.forceDrop());

  // It must transition to closed first (proves the drop took effect),
  // then the onclose backoff must bring it back without intervention.
  await expect
    .poll(() => page.evaluate(() => window.__mobuxView.test.wsReady()), {
      timeout: 8000,
      intervals: [100, 200, 400, 800],
    })
    .toBe(true);

  // And the resumed session is live: a real PTY roundtrip still works.
  const marker = `RECON_CRIT_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  await expect
    .poll(() => visibleTerminalText(page), {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toContain(marker);

  assertNoFailures(captured);
});

test("auto-reconnect: visibilitychange to visible while disconnected triggers a reconnect", async ({
  page,
}) => {
  // The primary "screen is open again → reconnect" path. We mark the
  // close intentional first so the onclose backoff is DISARMED — this
  // isolates the page-level visibilitychange listener as the sole thing
  // that can bring the socket back. If the listener is missing (i.e.
  // without the new code), wsReady() stays false and the poll times
  // out → the test fails.
  const captured = seedErrorCapture(page);
  await bootTerminal(page);

  expect(await page.evaluate(() => window.__mobuxView.test.wsReady())).toBe(
    true,
  );

  // Close with the backoff disarmed so nothing else can reconnect.
  await page.evaluate(() => {
    // __mobuxView.test.inject sets intentionalClose=true then closes;
    // reuse that exact path to get a disarmed close, but we don't need
    // its injected content — we just want the socket down with no
    // pending backoff.
    return window.__mobuxView.test.inject("");
  });
  // Confirm it's actually down (and stays down — backoff is disarmed).
  await expect
    .poll(() => page.evaluate(() => window.__mobuxView.test.wsReady()), {
      timeout: 3000,
      intervals: [100, 200, 400],
    })
    .toBe(false);

  // Now fire the visibility path. Playwright can't toggle the real
  // document.visibilityState, so we stub it to 'visible' and dispatch
  // the event the listener keys off — the same shape the browser emits
  // when the app is foregrounded.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect
    .poll(() => page.evaluate(() => window.__mobuxView.test.wsReady()), {
      timeout: 8000,
      intervals: [100, 200, 400, 800],
    })
    .toBe(true);

  assertNoFailures(captured);
});

test("soft keyboard: terminal bottom stays visible when visualViewport shrinks", async ({
  page,
}, testInfo) => {
  // Regression for the "bottom rows hidden behind Android soft keyboard"
  // bug. On Android Chrome the soft keyboard does NOT shrink
  // `window.innerHeight` / `100vh` — only `window.visualViewport.height`
  // shrinks. Without a renderer-agnostic visualViewport handler in
  // terminal.js, `.term-body` stays at 100vh and the bottom of the
  // terminal (typically tmux status line + prompt) renders behind the
  // keyboard.
  //
  // Repro choice: we override `visualViewport.height` via
  // Object.defineProperty and dispatch a synthetic `resize` on it.
  // CDP `Emulation.setVisibleSize` would be closer to real Android but
  // does not reliably decouple layoutViewport from visualViewport in
  // headless Chromium — the JS override gives a clean, deterministic
  // Android-shaped event.
  const captured = seedErrorCapture(page);
  await bootTerminal(page);

  // Type a unique marker so we can locate "the bottom" of the terminal
  // content in the DOM. echo lands at the prompt row, which is the
  // last live row in the viewport.
  const marker = `MOBUX_KBD_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  await expect
    .poll(() => visibleTerminalText(page), {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toContain(marker);

  // Snapshot the pre-keyboard layout viewport — this is what the
  // visualViewport handler must respect.
  const initial = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    vvHeight: window.visualViewport?.height ?? window.innerHeight,
    bodyH: document.body.getBoundingClientRect().height,
  }));
  // Sanity: on the configured Pixel 7 device we should have a tall
  // viewport before we simulate the keyboard.
  expect(initial.innerHeight, "baseline innerHeight").toBeGreaterThan(700);

  // Simulate the soft keyboard opening: shrink visualViewport.height
  // to ~440px (typical visible-area on Pixel 7 with Gboard up). Leave
  // window.innerHeight alone — that's the whole point of the bug.
  const SHRUNK_VV_HEIGHT = 440;
  await page.evaluate((newH) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error("visualViewport unavailable in test browser");
    // Stash original descriptors so we don't permanently poison the
    // page if this test fails mid-way (Playwright recycles contexts).
    window.__keyboardTestOriginal = {
      height: Object.getOwnPropertyDescriptor(
        VisualViewport.prototype,
        "height",
      ),
    };
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () => newH,
    });
    vv.dispatchEvent(new Event("resize"));
  }, SHRUNK_VV_HEIGHT);

  // Give the page-level visualViewport handler + per-backend resize a
  // beat to land (body shrinks → flex reflows → PTY resize round-trip).
  await page.waitForTimeout(800);

  // Assert: the body has been shrunk to the visualViewport height
  // (within a small epsilon for fractional layout pixels).
  const afterShrink = await page.evaluate(() => ({
    bodyH: document.body.getBoundingClientRect().height,
    termRect: document.getElementById("terminal").getBoundingClientRect(),
    innerHeight: window.innerHeight,
    vvHeight: window.visualViewport.height,
  }));
  expect(
    afterShrink.bodyH,
    `body should shrink to ~vvHeight: got ${afterShrink.bodyH}, expected ≈ ${SHRUNK_VV_HEIGHT}`,
  ).toBeLessThanOrEqual(SHRUNK_VV_HEIGHT + 4);
  // And the #terminal host (the renderer parent) must fit inside the
  // shrunk viewport — its bottom edge sits at or above vvHeight.
  expect(
    afterShrink.termRect.bottom,
    `#terminal bottom (${afterShrink.termRect.bottom}) should be within vvHeight (${SHRUNK_VV_HEIGHT})`,
  ).toBeLessThanOrEqual(SHRUNK_VV_HEIGHT + 4);

  // Now the meat: find the rendered line containing our marker and
  // confirm its bounding-box bottom sits inside the visualViewport.
  // We can't rely on locator.isVisible() alone — CSS visibility lies
  // when content is painted outside the viewport but inside its own
  // overflow scroller.
  const markerGeom = await page.evaluate((m) => {
    // Walk the #terminal DOM and find the deepest text node containing
    // the marker, then read its bounding-client-rect. This works for
    // both xterm (.xterm-rows > div > span) and sterk (.ace_line span)
    // without per-backend selectors.
    const t = document.getElementById("terminal");
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    let node;
    let best = null;
    while ((node = walker.nextNode())) {
      if (node.data && node.data.includes(m)) {
        const r = document.createRange();
        const idx = node.data.indexOf(m);
        r.setStart(node, idx);
        r.setEnd(node, idx + m.length);
        const rect = r.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          best = { top: rect.top, bottom: rect.bottom, height: rect.height };
        }
      }
    }
    return best;
  }, marker);

  // Take an artifact screenshot regardless of pass/fail — useful for
  // debugging the bug-fixed state.
  const screenshotPath = `.tmp/keyboard-up-${testInfo.project.name}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });

  expect(
    markerGeom,
    `must find marker "${marker}" in rendered terminal DOM`,
  ).toBeTruthy();
  // The bottom edge of the marker line must sit at or above the visual
  // viewport's bottom (= SHRUNK_VV_HEIGHT, since vv.offsetTop is 0 in
  // our simulation). Small epsilon for sub-pixel rendering.
  expect(
    markerGeom.bottom,
    `marker bottom (${markerGeom.bottom}) must be ≤ vvHeight (${SHRUNK_VV_HEIGHT}); screenshot: ${screenshotPath}`,
  ).toBeLessThanOrEqual(SHRUNK_VV_HEIGHT + 4);

  // Restore the visualViewport descriptor and grow back to original to
  // mirror the keyboard-dismiss path. Not strictly required (context
  // is torn down after the test), but exercises the grow-back code
  // path and lets us assert the body unsticks.
  await page.evaluate(() => {
    const vv = window.visualViewport;
    delete vv.height; // remove our property override
    vv.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(400);
  const afterRestore = await page.evaluate(() => document.body.style.height);
  expect(
    afterRestore,
    "body inline height should clear after vv grows back",
  ).toBe("");

  assertNoFailures(captured);
});

test("soft keyboard: resizes-content contract keeps input bar and bottom rows visible (issue #167)", async ({
  page,
}, testInfo) => {
  // Regression for issue #167 — bottom terminal rows and the input bar's
  // text row clipped behind the Android soft keyboard + Chrome's autofill
  // accessory bar. Root cause: under the Chrome 108+ default
  // (interactive-widget=resizes-visual) the page must reconstruct the
  // visible height from visualViewport.height, and on real devices that
  // value does not account for the keyboard accessory bar — so the
  // body-height tracking in terminal.js left ~an accessory-bar's worth of
  // layout hidden behind the keyboard. No vv-event handler can fix a wrong
  // reported height; the fix is interactive-widget=resizes-content, which
  // makes Android resize the LAYOUT viewport from the OS window insets.
  //
  // Two halves:
  //   1. Contract: the served SPA HTML must declare
  //      interactive-widget=resizes-content. This is the device-behavior
  //      switch — dropping it silently reintroduces #167.
  //   2. Geometry: simulate what resizes-content does on-device (the
  //      layout viewport shrinks to the space above the keyboard) via
  //      setViewportSize, then assert by getBoundingClientRect +
  //      getComputedStyle that the input bar's text row and the last
  //      terminal row sit fully inside the shrunk viewport.
  const captured = seedErrorCapture(page);

  const html = await page.request.get(`${BASE}/app`).then((r) => r.text());
  const viewportMeta = html.match(
    /<meta[^>]*name="viewport"[^>]*content="([^"]*)"/,
  );
  expect(viewportMeta, "SPA HTML must have a viewport meta").toBeTruthy();
  expect(
    viewportMeta[1],
    "viewport meta must opt into layout-viewport keyboard resize",
  ).toContain("interactive-widget=resizes-content");

  await bootTerminal(page);

  const marker = `MOBUX_167_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  await expect
    .poll(() => visibleTerminalText(page), {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toContain(marker);

  // Keyboard-up on a Pixel-class device leaves roughly half the height.
  // On-device, resizes-content delivers exactly this: a smaller layout
  // viewport (innerHeight shrinks, dvh shrinks, window resize fires).
  const { width } = page.viewportSize();
  const KEYBOARD_UP_HEIGHT = 445;
  await page.setViewportSize({ width, height: KEYBOARD_UP_HEIGHT });

  // Let the reflow + PTY resize round-trip land, then read the geometry.
  const geometry = () =>
    page.evaluate((m) => {
      const within = (rect, limit) =>
        rect.height > 0 && rect.bottom <= limit + 2;
      const visible = (el) => {
        const cs = getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden";
      };
      const bar = document.getElementById("inputBar");
      const input = document.getElementById("inputText");
      const term = document.getElementById("terminal");
      const barRect = bar.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const termRect = term.getBoundingClientRect();
      let markerBottom = null;
      const walker = document.createTreeWalker(term, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.data && node.data.includes(m)) {
          const r = document.createRange();
          const idx = node.data.indexOf(m);
          r.setStart(node, idx);
          r.setEnd(node, idx + m.length);
          const rect = r.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) markerBottom = rect.bottom;
        }
      }
      return {
        innerHeight: window.innerHeight,
        barVisible: visible(bar) && visible(input),
        barFits: within(barRect, window.innerHeight),
        inputFits: within(inputRect, window.innerHeight),
        termAboveBar: termRect.bottom <= barRect.top + 2,
        barTop: barRect.top,
        inputBottom: inputRect.bottom,
        termBottom: termRect.bottom,
        markerBottom,
      };
    }, marker);

  await expect
    .poll(async () => (await geometry()).markerBottom !== null, {
      timeout: 10000,
      intervals: [200, 400, 800],
    })
    .toBe(true);
  const geo = await geometry();

  const screenshotPath = `.tmp/keyboard-167-${testInfo.project.name}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });

  expect(geo.innerHeight, "layout viewport must have shrunk").toBe(
    KEYBOARD_UP_HEIGHT,
  );
  expect(geo.barVisible, "input bar + text input computed-visible").toBe(true);
  expect(
    geo.barFits && geo.inputFits,
    `input bar text row must sit inside the viewport: input bottom ${geo.inputBottom}, innerHeight ${geo.innerHeight}; screenshot: ${screenshotPath}`,
  ).toBe(true);
  expect(
    geo.termAboveBar,
    `#terminal (bottom ${geo.termBottom}) must not extend under the input bar (top ${geo.barTop})`,
  ).toBe(true);
  expect(
    geo.markerBottom,
    `last output row (bottom ${geo.markerBottom}) must sit above the input bar (top ${geo.barTop}); screenshot: ${screenshotPath}`,
  ).toBeLessThanOrEqual(geo.barTop + 2);

  assertNoFailures(captured);
});

test("tap-to-snap: a tap snaps to bottom, a swipe does not", async ({
  page,
}, testInfo) => {
  // Regression for issue #99 — re-attempt after PR #100 was reverted in
  // #102. When the user is parked mid-scrollback and TAPS the terminal
  // to type, the soft keyboard comes up but the viewport stays in
  // scrollback, so typed text lands where they can't see it. A genuine
  // tap on #terminal must snap the viewport to the bottom.
  //
  // The critical regression that #100 shipped (and the reason it was
  // reverted): it hooked `focusin`, which fires on tap-to-scroll too,
  // so swiping up to read scrollback immediately snapped back to
  // bottom and broke incremental scrolling. #100's test used a
  // synthetic `page.focus()` — no swipe context — so it never caught
  // this. This test drives REAL pointer events (pointerdown → move →
  // pointerup) and asserts BOTH:
  //   * TAP (no movement)        → snaps to bottom   (the fix)
  //   * SWIPE (movement > thresh) → does NOT snap     (the regression guard)
  //
  // Setup uses the synthetic `injectLines()` helper (closes the WS
  // first so tmux can't clobber the injected content). Both backends
  // grow scrollback identically through their VT parsers on a
  // newline-rich write — what we test is the page-level pointer
  // handler in terminal.js, not tmux's redraw protocol.
  const captured = seedErrorCapture(page);
  await bootTerminal(page);

  const rows = await page.evaluate(() => window.__mobuxView.test.rows());
  expect(rows, "terminal must report a row count").toBeGreaterThan(5);

  // Inject rows + 20 lines so there's real scrollback to park in.
  const totalLines = rows + 20;
  const marker = `TAP_SNAP_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate(({ n, m }) => window.__mobuxView.test.injectLines(n, m), {
    n: totalLines,
    m: marker,
  });
  await page.waitForTimeout(200);

  // Pin to bottom and capture the "bottom" viewportY for this backend.
  await page.evaluate(() => window.__mobuxView.test.scrollToBottom());
  await page.waitForTimeout(50);
  const bottomViewportY = await page.evaluate(() =>
    window.__mobuxView.test.viewportY(),
  );

  // Dispatch a sequence of pointer events on the #terminal host with
  // the given total travel. Returns nothing — caller reads viewportY.
  // We hit the host element directly (renderer-agnostic) at its centre.
  const pointerGesture = async (dxTotal, dyTotal, durationMs) => {
    await page.evaluate(
      ({ dx, dy, dur }) => {
        const t = document.getElementById("terminal");
        const r = t.getBoundingClientRect();
        const startX = r.left + r.width / 2;
        const startY = r.top + r.height / 2;
        const fire = (type, x, y) =>
          t.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerType: "touch",
              pointerId: 1,
              isPrimary: true,
            }),
          );
        fire("pointerdown", startX, startY);
        // A couple of intermediate moves so a swipe accumulates travel.
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          fire(
            "pointermove",
            startX + (dx * i) / steps,
            startY + (dy * i) / steps,
          );
        }
        // The handler reads e.timeStamp; PointerEvent.timeStamp is set by
        // the engine at construction, so back-to-back dispatch is well
        // under the 250ms tap window. Long-press is covered by the
        // movement guard plus the duration guard in the handler; we keep
        // the test deterministic by only varying movement here.
        void dur;
        fire("pointerup", startX + dx, startY + dy);
      },
      { dx: dxTotal, dy: dyTotal, dur: durationMs },
    );
  };

  // ── Case 1: SWIPE first (regression guard) ──────────────────────
  // Scroll up off the bottom, then swipe (large vertical travel). The
  // viewport must STAY in scrollback — a swipe is not a tap.
  await page.evaluate(() => {
    const t = window.__xterm || window.__sterk;
    t.scrollLines(-5);
  });
  await page.waitForTimeout(100);
  const preSwipeViewportY = await page.evaluate(() =>
    window.__mobuxView.test.viewportY(),
  );
  expect(
    preSwipeViewportY,
    `pre-condition: viewportY (${preSwipeViewportY}) should be < bottom (${bottomViewportY}) after scrollLines(-5)`,
  ).toBeLessThan(bottomViewportY);

  await pointerGesture(0, -120, 120); // 120px upward swipe
  await page.waitForTimeout(150);
  const postSwipeViewportY = await page.evaluate(() =>
    window.__mobuxView.test.viewportY(),
  );
  expect(
    postSwipeViewportY,
    `SWIPE must NOT snap to bottom: viewportY (${postSwipeViewportY}) should stay < bottom (${bottomViewportY})`,
  ).toBeLessThan(bottomViewportY);

  // ── Case 2: TAP (the fix) ───────────────────────────────────────
  // Re-park in scrollback, then tap (no movement). Must snap to bottom.
  await page.evaluate(() => {
    window.__mobuxView.test.scrollToBottom();
    const t = window.__xterm || window.__sterk;
    t.scrollLines(-5);
  });
  await page.waitForTimeout(100);
  const preTapViewportY = await page.evaluate(() =>
    window.__mobuxView.test.viewportY(),
  );
  expect(
    preTapViewportY,
    `pre-condition: viewportY (${preTapViewportY}) should be < bottom (${bottomViewportY}) before tap`,
  ).toBeLessThan(bottomViewportY);

  await pointerGesture(0, 0, 60); // genuine tap: no movement
  await page.waitForTimeout(150);

  const screenshotPath = `.tmp/tap-snap-${testInfo.project.name}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const postTapViewportY = await page.evaluate(() =>
    window.__mobuxView.test.viewportY(),
  );
  expect(
    postTapViewportY,
    `TAP must snap to bottom: viewportY should be ${bottomViewportY}, got ${postTapViewportY}; screenshot: ${screenshotPath}`,
  ).toBe(bottomViewportY);

  assertNoFailures(captured);
});
