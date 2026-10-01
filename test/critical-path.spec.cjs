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

const { createTmuxRunner, SMOKE_TMUX_SOCKET } = require("./lib/tmux.cjs");
const terminalPage = require("./lib/terminal-page.cjs");
const { touch } = terminalPage;

const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = createTmuxRunner(SMOKE_TMUX_SOCKET);

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

// The whole file drives ONE tmux session, so tmux — not the browser — is the
// shared mutable state here: a test that splits a pane or opens a window
// hands the next test a different active shell, a different pane geometry and
// a different prompt. Every test therefore starts from the same session
// shape: one window, one pane, no half-typed command line, a known prompt and
// a cleared screen.
const resetSession = () => terminalPage.resetSession(tmux, SESSION);

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  // bash --norc --noprofile gives us a clean, predictable prompt.
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
});

test.beforeEach(() => {
  resetSession();
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

const bootTerminal = (page) => terminalPage.bootTerminal(page, BASE, SESSION);

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

test("PTY roundtrip: leaving a full-screen app repaints the screen as one synchronized update", async ({
  page,
}) => {
  // The browser holds painting between ?2026h and ?2026l, so a whole-screen
  // redraw lands as one frame instead of chunk by chunk. tmux brackets its own
  // redraws in those markers, but only for a client that advertises the
  // `sync` terminal feature.
  const captured = seedErrorCapture(page);
  const received = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => received.push(String(frame.payload)));
  });
  const stream = () => received.join("");
  await bootTerminal(page);

  // Markers are split in the typed commands so the command-line echo never
  // matches them.
  await page.evaluate(() => window.__mobuxView.send("echo SYNC''BASE\r"));
  await expect
    .poll(() => stream().includes("SYNCBASE"), { timeout: 10000 })
    .toBe(true);
  const mark = stream().length;

  await page.evaluate(() =>
    window.__mobuxView.send(
      "printf '\\033[?1049h\\033[2J'; seq 1 20; echo SYNC''ALT; sleep 0.3; printf '\\033[?1049l'\r",
    ),
  );
  const restored = () => {
    const wire = stream().slice(mark);
    const alt = wire.indexOf("SYNCALT");
    const base = wire.indexOf("SYNCBASE", alt);
    return { wire, alt, base };
  };
  await expect
    .poll(
      () => {
        const { alt, base } = restored();
        return alt >= 0 && base > alt;
      },
      { message: "tmux repaints the normal screen", timeout: 10000 },
    )
    .toBe(true);
  await expect
    .poll(
      () => {
        const { wire, base } = restored();
        return wire.indexOf("\x1b[?2026l", base) > base;
      },
      { message: "a ?2026l closes the repaint", timeout: 5000 },
    )
    .toBe(true);

  const { wire, base } = restored();
  const opened = wire.lastIndexOf("\x1b[?2026h", base);
  const closedBefore = wire.lastIndexOf("\x1b[?2026l", base);
  expect(opened, "a ?2026h opens the repaint").toBeGreaterThanOrEqual(0);
  expect(opened, "the repaint sits inside an open update").toBeGreaterThan(
    closedBefore,
  );
  assertNoFailures(captured);
});

test("PTY roundtrip: tmux split-window produces a second pane", async ({
  page,
}) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  // Snapshot pane count from tmux directly (source of truth).
  const before = parseInt(
    tmux(`list-panes -t ${SESSION} | wc -l`).toString().trim(),
    10,
  );
  // Send tmux prefix (Ctrl-B) then '|' to split-window -h.
  // Default mobux tmux config uses 'C-b' as prefix.
  await page.evaluate(() => window.__mobuxView.send("\x02")); // Ctrl-B
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__mobuxView.send('"')); // default split-window vertical
  await page.waitForTimeout(500);
  const after = parseInt(
    tmux(`list-panes -t ${SESSION} | wc -l`).toString().trim(),
    10,
  );
  expect(after, "tmux pane count should increase after split").toBeGreaterThan(
    before,
  );
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

  // On mobile, terminal.js mounts the input bar eagerly but it stays
  // hidden until tap-to-focus engagement (#201) — already the state
  // bootTerminal leaves it in. Force it explicitly anyway so this
  // assertion doesn't silently depend on that default, then exercise the
  // hidden→visible transition the regression comment above describes.
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

// The reader draws the engine buffer, not a display: with every write into
// xterm swallowed, injected lines still reach the reader and never xterm.
// sterk has no write path; it draws the same buffer (the sterk test below).
test("reader view: the reader draws from the buffer, not the display", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.use.renderer !== "xterm",
    "sterk draws the buffer itself",
  );
  await bootTerminal(page);
  await page.evaluate(() => window.__mobuxView.swap("reader"));
  await page.waitForFunction(
    () => {
      const r = document.getElementById("reader");
      return r && !r.classList.contains("hidden");
    },
    { timeout: 4000 },
  );
  const marker = `BUFFER_ONLY_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate(async (m) => {
    window.__xterm.write = (_data, done) => done?.();
    await window.__mobuxView.test.injectLines(5, m);
  }, marker);
  await expect
    .poll(
      async () =>
        (await readerLines(page)).filter((l) => l.includes(marker)).length,
      { timeout: 10000 },
    )
    .toBe(5);
  const displayRows = await page.evaluate(() => {
    const t = window.__mobuxView.test;
    const rows = [];
    for (let y = 0; y < t.bufferLength(); y++) rows.push(t.lineText(y) || "");
    return rows;
  });
  expect(displayRows.filter((row) => row.includes(marker))).toEqual([]);
});

// sterk draws the engine buffer itself: the view has no write path, and
// lines injected into the buffer render in it.
test("sterk: the display draws the buffer and nothing writes into it", async ({
  page,
}, testInfo) => {
  sterkOnly(test, testInfo);
  await bootTerminal(page);
  const marker = `STERK_BUFFER_${Math.floor(Math.random() * 1e9)}`;
  expect(
    await page.evaluate(() => typeof window.__sterk._sterk.write),
    "the sterk display takes no writes",
  ).toBe("undefined");
  await page.evaluate((m) => window.__mobuxView.test.injectLines(5, m), marker);
  await expect
    .poll(
      () =>
        page.evaluate(
          (m) =>
            [...document.querySelectorAll("#terminal .ace_line")].filter((l) =>
              l.textContent.includes(m),
            ).length,
          marker,
        ),
      { timeout: 10000 },
    )
    .toBe(5);
  const rows = await page.evaluate(() => {
    const t = window.__mobuxView.test;
    const out = [];
    for (let y = 0; y < t.bufferLength(); y++) out.push(t.lineText(y) || "");
    return out;
  });
  expect(rows.filter((row) => row.includes(marker))).toHaveLength(5);
});

// The screen source reports each buffer change as rows off the top of the
// history, rows onto its end and the screen rows that differ, and falls back
// to a full repaint when history is replaced.
test("sterk: the screen source reports append, trim, row diffs, full and the straddle", async ({
  page,
}, testInfo) => {
  sterkOnly(test, testInfo);
  await bootTerminal(page);
  const result = await page.evaluate(async () => {
    const { createTerminalBuffer } = await import("/static/terminal-buffer.js");
    const { createScreenSource } =
      await import("/static/terminal-screen-source.js");
    const cols = 20;
    const buffer = createTerminalBuffer({ cols, rows: 5, scrollback: 100 });
    const source = createScreenSource(buffer, window.Sterk.screenLineFromCells);
    let changes = [];
    source.subscribe((change) => changes.push(change));
    const text = (line) => line.runs.map((r) => r.text).join("");
    const history = () => {
      const out = [];
      for (let i = 0; i < source.history.length; i++) {
        out.push(text(source.history.line(i)).trimEnd());
      }
      return out;
    };
    const take = async () => {
      await source.settle();
      const out = changes;
      changes = [];
      return out;
    };
    const lines = (n, from = 0) =>
      Array.from({ length: n }, (_, i) => `line ${from + i}`);
    const out = {};

    await buffer.writeScreen("\x1b[?1049h\x1b[Hscreen");
    await take();
    await buffer.syncWhole(lines(80), false);
    out.append = await take();
    out.appendHistory = [history()[0], history()[79], source.history.length];

    await buffer.syncWhole(lines(91), false);
    out.trim = await take();
    out.trimHistory = [history()[0], history().at(-1), source.history.length];

    await buffer.writeScreen("\x1b[3;1Hrow two");
    out.row = await take();
    out.rowText = text(source.screen.line(2)).trimEnd();

    await buffer.clearHistory();
    out.clear = await take();
    out.clearLength = source.history.length;

    await buffer.syncWhole(["A".repeat(cols)], true);
    out.straddle = await take();
    out.straddleRow = source.screen.line(0).wrapped;
    buffer.setStatus(1, "top");
    out.statusTop = await take();
    out.statusTopRow = source.screen.line(0).wrapped;
    buffer.setStatus(1, "bottom");
    await take();
    await buffer.writeScreen("\x1b[4;5H");
    out.cursor = await take();
    out.cursorAt = source.cursor;
    await buffer.syncWhole(["A".repeat(cols * 2)], false);
    out.grown = await take();
    out.grownHistory = history();
    out.fullRepaints = source.fullRepaints();
    source.dispose();
    buffer.dispose();
    return out;
  });
  const history = (change) => change.map((c) => [c.history, c.full]);

  expect(history(result.append)).toEqual([
    [{ removedTop: 0, appended: 80 }, false],
  ]);
  expect(result.appendHistory).toEqual(["line 0", "line 79", 80]);

  expect(history(result.trim)).toEqual([
    [{ removedTop: 31, appended: 11 }, false],
  ]);
  expect(result.trimHistory).toEqual(["line 31", "line 90", 60]);

  expect(result.row).toHaveLength(1);
  expect(result.row[0].screenRows).toEqual([2]);
  expect(result.row[0].full).toBe(false);
  expect(result.rowText).toBe("row two");

  expect(result.clear.map((c) => c.full)).toEqual([true]);
  expect(result.clearLength).toBe(0);

  expect(history(result.straddle)).toEqual([
    [{ removedTop: 0, appended: 1 }, false],
  ]);
  expect(result.straddle[0].screenRows).toContain(0);
  expect(result.straddleRow).toBe(true);

  expect(history(result.grown)).toEqual([
    [{ removedTop: 0, appended: 1 }, false],
  ]);
  expect(result.grown[0].screenRows).toContain(0);
  expect(result.grownHistory).toEqual(["A".repeat(20), "A".repeat(20)]);
  expect(result.statusTop).toHaveLength(1);
  expect(result.statusTop[0].screenRows).toContain(0);
  expect(result.statusTopRow).toBe(false);
  expect(result.cursor).toHaveLength(1);
  expect(result.cursor[0].screenRows).toEqual([]);
  expect(result.cursorAt).toEqual({ x: 4, y: 3, visible: true });
  // The switch to the alternate screen, then the history clear.
  expect(result.fullRepaints).toBe(2);
});

// The normal screen's own scrollback: rows xterm drops off its full top are
// reported as removed, and a screen switch or a scroll region below the top
// row drops nothing.
test("sterk: the screen source follows the normal screen's scrollback", async ({
  page,
}, testInfo) => {
  sterkOnly(test, testInfo);
  await bootTerminal(page);
  const result = await page.evaluate(async () => {
    const { createTerminalBuffer } = await import("/static/terminal-buffer.js");
    const { createScreenSource } =
      await import("/static/terminal-screen-source.js");
    const buffer = createTerminalBuffer({ cols: 20, rows: 5, scrollback: 100 });
    const source = createScreenSource(buffer, window.Sterk.screenLineFromCells);
    let changes = [];
    source.subscribe((change) => changes.push(change));
    const text = (line) =>
      line.runs
        .map((r) => r.text)
        .join("")
        .trimEnd();
    const step = async () => {
      await source.settle();
      const held = [];
      for (let i = 0; i < source.history.length; i++) {
        held.push(text(source.history.line(i)));
      }
      const truth = buffer
        .scrollbackRows()
        .map((row) => row.translateToString(true));
      const out = {
        changes: changes.map((c) => [c.history, c.full]),
        matches: JSON.stringify(held) === JSON.stringify(truth),
        held,
      };
      changes = [];
      return out;
    };
    const lines = (n, from) =>
      Array.from({ length: n }, (_, i) => `n${from + i}\r\n`).join("");
    const out = {};
    await buffer.writeScreen(lines(12, 0));
    out.grow = await step();
    await buffer.writeScreen(lines(5, 12));
    out.trim = await step();
    await buffer.writeScreen("\x1b[?1049halt\x1b[?1049l");
    out.switchOnce = await step();
    await buffer.writeScreen("\x1b[?1049halt");
    await source.settle();
    await buffer.writeScreen("\x1b[?1049l");
    out.switchTwice = await step();
    await buffer.writeScreen("\x1b[2;4r\x1b[4;1H\n\n\n\x1b[r\x1b[5;1H");
    out.region = await step();
    buffer.resize(30, 5);
    await new Promise((resolve) => setTimeout(resolve, 50));
    out.resize = await step();
    out.resizeCols = source.cols;
    await buffer.writeScreen(lines(3, 17));
    out.after = await step();
    source.dispose();
    buffer.dispose();
    return out;
  });
  const moved = (step) =>
    step.changes.reduce(
      (sum, [h]) => [sum[0] + h.removedTop, sum[1] + h.appended],
      [0, 0],
    );

  expect(result.grow.changes).toEqual([
    [{ removedTop: 0, appended: 8 }, false],
  ]);
  expect(result.grow.matches).toBe(true);
  expect(result.trim.changes).toEqual([
    [{ removedTop: 3, appended: 5 }, false],
  ]);
  expect(result.trim.held[0]).toBe("n3");
  expect(result.trim.matches).toBe(true);

  expect(moved(result.switchOnce)).toEqual([0, 0]);
  expect(result.switchOnce.matches).toBe(true);
  expect(result.switchTwice.changes.map(([, full]) => full)).toEqual([
    true,
    true,
  ]);
  expect(result.switchTwice.matches).toBe(true);

  expect(moved(result.region)).toEqual([0, 0]);
  expect(result.region.matches).toBe(true);

  expect(result.resize.changes.map(([, full]) => full)).toContain(true);
  expect(result.resizeCols).toBe(30);
  expect(result.resize.matches).toBe(true);

  expect(result.after.changes).toEqual([
    [{ removedTop: 3, appended: 3 }, false],
  ]);
  expect(result.after.matches).toBe(true);
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

  // This test is about the keyboard-up geometry, not the reveal
  // lifecycle: the bar only reveals on tap-to-focus engagement (#201),
  // not on mount, so reveal it directly here — the real flow this test
  // simulates (soft keyboard up) never starts without the user tapping
  // to focus first anyway.
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    if (bar) bar.classList.remove("hidden");
  });

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
  const displayScrollback = () =>
    page.evaluate(() => {
      const t = window.__mobuxView.test;
      const out = [];
      for (let y = 0; y < t.bufferLength() - t.rows(); y++)
        out.push(t.lineText(y));
      return out;
    });
  const scrollbackBefore = await displayScrollback();
  const redrawsBefore = await page.evaluate(() =>
    window.__mobuxView.test.fullRedrawCount(),
  );
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

  // Only the row count changed: xterm repaints its screen and keeps its
  // history rows. sterk's view repaints in full on any grid change; its
  // history rows must still come back in place.
  if (testInfo.project.use.renderer === "xterm") {
    expect(
      await page.evaluate(() => window.__mobuxView.test.fullRedrawCount()),
      "a keyboard opening must not redraw history",
    ).toBe(redrawsBefore);
  }
  const scrollbackAfter = await displayScrollback();
  expect(
    scrollbackAfter.slice(0, scrollbackBefore.length),
    "a keyboard opening must leave the display scrollback in place",
  ).toEqual(scrollbackBefore);

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
    window.__mobuxView.test.scrollLines(-5);
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
    window.__mobuxView.test.scrollLines(-5);
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

// ── Base-relative URLs (issue #282) ────────────────────────────────
//
// The legacy static modules build every URL through web/static/base.js,
// which derives the app root from its own `import.meta.url`. Two things
// have to hold: nothing moved at prefix "" (the shape mobux ships in),
// and the whole surface follows a path prefix when one is present.

test("base: at the origin root every URL resolves exactly where it used to", async ({
  page,
}) => {
  const origin = new URL(BASE).origin;
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });

  const resolved = await page.evaluate(async () => {
    const { base, u, wsUrl } = await import("/static/base.js");
    return {
      base: base(),
      api: u("api/telemetry"),
      leadingSlash: u("/api/telemetry"),
      asset: u("static/chime.ogg"),
      ws: wsUrl("ws/dev?node=box&build=abc"),
    };
  });

  expect(resolved.base).toBe(`${origin}/`);
  expect(resolved.api).toBe(`${origin}/api/telemetry`);
  expect(resolved.leadingSlash).toBe(`${origin}/api/telemetry`);
  expect(resolved.asset).toBe(`${origin}/static/chime.ogg`);
  expect(resolved.ws).toBe(
    `${origin.replace(/^http/, "ws")}/ws/dev?node=box&build=abc`,
  );
});

test("base: under a path prefix every URL moves with it", async ({ page }) => {
  const origin = new URL(BASE).origin;
  const prefix = "/proxy/workspace/8080";
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "web", "static", "base.js"),
    "utf8",
  );

  // Serve the real module from a prefixed path. mobux itself still owns the
  // origin root here; the point is that the module never consults it.
  await page.route(`**${prefix}/static/base.js`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: source }),
  );
  await page.route(`**${prefix}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>p",
    }),
  );

  await page.goto(`${origin}${prefix}/`, { waitUntil: "domcontentloaded" });

  const resolved = await page.evaluate(async (p) => {
    const { base, u, wsUrl } = await import(`${p}/static/base.js`);
    return { base: base(), api: u("api/telemetry"), ws: wsUrl("ws/dev") };
  }, prefix);

  expect(resolved.base).toBe(`${origin}${prefix}/`);
  expect(resolved.api).toBe(`${origin}${prefix}/api/telemetry`);
  expect(resolved.ws).toBe(`${origin.replace(/^http/, "ws")}${prefix}/ws/dev`);
});

test("base: the command menu's Settings row keeps a path prefix", async ({
  page,
}) => {
  const origin = new URL(BASE).origin;
  const prefix = "/proxy/workspace/8080";

  // Mount the whole app under the prefix: every request below it is
  // forwarded to the real server with the prefix stripped.
  await page.route(`**${prefix}/**`, async (route) => {
    const url = new URL(route.request().url());
    url.pathname = url.pathname.slice(prefix.length);
    const response = await route.fetch({ url: url.href });
    await route.fulfill({ response });
  });

  await page.goto(`${origin}${prefix}/app?drawer=1#/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== "undefined", {
    timeout: 10000,
  });
  await page.evaluate(() => {
    window.__drawerNoReload = true;
    document.getElementById("cmdSettingsBtn").click();
  });

  await expect(page.locator(".app-header h1")).toHaveText("Settings");
  const after = await page.evaluate(() => ({
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    noReload: window.__drawerNoReload,
  }));
  expect(after).toEqual({
    pathname: `${prefix}/app`,
    search: "?drawer=1",
    hash: "#/settings",
    noReload: true,
  });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// ── One buffer, one copy (issue #315) ──────────────────────────────
// The display draws the engine's buffer: tmux history above the screen,
// then the screen parsed from the stream. Nothing may appear twice and
// nothing drawn on an alternate screen may land in scrollback.

const ALT_SCRIPT = require("path").join(
  __dirname,
  "assets",
  "alt-screen-repaint.sh",
);

function terminalLines(page) {
  return page.evaluate(() => {
    const t = window.__mobuxView.test;
    const lines = [];
    for (let y = 0; y < t.bufferLength(); y++) lines.push(t.lineText(y) || "");
    return lines;
  });
}

function readerLines(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll("#reader .rb-line, #reader .rb-codeline"),
    ).map((el) =>
      Array.from(el.childNodes)
        .filter((n) => !(n.classList && n.classList.contains("rb-speaker")))
        .map((n) => n.textContent)
        .join(""),
    ),
  );
}

// Lines that are a bare number, counted: { "1": 1, "2": 1, … }.
function numberCounts(lines) {
  const counts = {};
  for (const line of lines) {
    const m = line.replace(/ /g, " ").trim();
    if (/^\d+$/.test(m)) counts[m] = (counts[m] || 0) + 1;
  }
  return counts;
}

function expectedCounts(from, to) {
  const counts = {};
  for (let i = from; i <= to; i++) counts[String(i)] = 1;
  return counts;
}

const altLines = (lines) =>
  lines.filter((l) => /^alt-line-\d+$/.test(l.replace(/ /g, " ").trim()));

async function runAltScript(page) {
  const rows = await page.evaluate(() => window.__mobuxView.test.rows());
  expect(rows, "the pane must be shorter than one 60-line paint").toBeLessThan(
    60,
  );
  tmux(`send-keys -t ${SESSION} "bash ${ALT_SCRIPT}" Enter`);
  await expect
    .poll(
      async () =>
        (await terminalLines(page)).some((l) => l.trim() === "ALT-DONE"),
      { timeout: 15000 },
    )
    .toBe(true);
}

test("one copy: an alternate-screen app leaves none of its lines in scrollback", async ({
  page,
}) => {
  await bootTerminal(page);
  await runAltScript(page);
  await page.waitForTimeout(1000);
  expect(altLines(await terminalLines(page))).toEqual([]);
});

test("one copy: seq 1 500 shows each line exactly once once output goes quiet", async ({
  page,
}) => {
  tmux(`send-keys -t ${SESSION} "seq 1 500" Enter`);
  execSync("sleep 0.5");
  await bootTerminal(page);
  await expect
    .poll(async () => numberCounts(await terminalLines(page)), {
      timeout: 10000,
    })
    .toEqual(expectedCounts(1, 500));

  await page.evaluate(() => window.__mobuxView.send("seq 501 800\r"));
  await expect
    .poll(async () => numberCounts(await terminalLines(page)), {
      timeout: 10000,
    })
    .toEqual(expectedCounts(1, 800));
});

test("one copy: a tmux command via /command keeps a single copy of history", async ({
  page,
}) => {
  tmux(`send-keys -t ${SESSION} "seq 1 500" Enter`);
  execSync("sleep 0.5");
  await bootTerminal(page);
  await expect
    .poll(async () => numberCounts(await terminalLines(page)), {
      timeout: 10000,
    })
    .toEqual(expectedCounts(1, 500));

  await page.evaluate(() =>
    document.querySelector('#cmdPickList [data-cmd="next-pane"]').click(),
  );
  await page.waitForTimeout(1500);
  expect(numberCounts(await terminalLines(page))).toEqual(
    expectedCounts(1, 500),
  );
});

test("one copy: the reader shows no alternate-screen lines and each number once", async ({
  page,
}) => {
  tmux(`send-keys -t ${SESSION} "seq 1 500" Enter`);
  execSync("sleep 0.5");
  await bootTerminal(page);
  await runAltScript(page);
  await expect
    .poll(async () => numberCounts(await terminalLines(page)), {
      timeout: 10000,
    })
    .toEqual(expectedCounts(1, 500));

  await page.evaluate(() => window.__mobuxView.swap("reader"));
  await page.waitForFunction(
    () => {
      const r = document.getElementById("reader");
      return r && !r.classList.contains("hidden");
    },
    { timeout: 4000 },
  );
  await expect
    .poll(async () => numberCounts(await readerLines(page)), { timeout: 10000 })
    .toEqual(expectedCounts(1, 500));
  expect(altLines(await readerLines(page))).toEqual([]);
});

test("reader view: with the status line on top it is the status bar, not a line", async ({
  page,
}) => {
  tmux(`set-option -t ${SESSION} status-position top`);
  try {
    const marker = `TOP_STATUS_${Math.floor(Math.random() * 1e9)}`;
    tmux(`send-keys -t ${SESSION} "echo ${marker}" Enter`);
    await bootTerminal(page);
    await page.evaluate(() => window.__mobuxView.swap("reader"));
    await expect
      .poll(
        async () =>
          (await readerLines(page)).filter((l) => l.trim() === marker).length,
        { timeout: 10000 },
      )
      .toBe(1);
    expect(
      await page.evaluate(() => window.__mobuxView.test.statusBarFilled()),
    ).toBe(true);
    const statusText = await page.evaluate(
      () => document.querySelector(".reader-statusbar").textContent,
    );
    // tmux cuts the session name in status-left to fit its length.
    const tag = `[${SESSION.slice(0, 5)}`;
    expect(statusText).toContain(tag);
    const lines = await readerLines(page);
    expect(lines.filter((l) => l.includes(tag))).toEqual([]);
  } finally {
    tmux(`set-option -u -t ${SESSION} status-position`);
  }
});

test("one copy: history catches up while output keeps flowing", async ({
  page,
}) => {
  await bootTerminal(page);
  const rows = await page.evaluate(() => window.__mobuxView.test.rows());
  tmux(
    `send-keys -t ${SESSION} "for i in \\$(seq 1 400); do echo flow-\\$i; sleep 0.05; done" Enter`,
  );
  // Output never pauses for 400ms, so only the maximum wait brings the
  // scrolled-off lines into scrollback before the loop ends (~20s).
  await expect
    .poll(
      async () => {
        const lines = await terminalLines(page);
        const scrollback = lines.slice(0, lines.length - rows);
        return scrollback.some((l) => l.trim() === "flow-1");
      },
      { timeout: 8000 },
    )
    .toBe(true);
  tmux(`send-keys -t ${SESSION} C-c`);
});

// alignHistory / normalizeCapture / line keys, run in the page against the
// served modules.
async function inPage(page, fn) {
  await bootTerminal(page);
  return page.evaluate(
    async ({ body }) => {
      const m = await import("/static/terminal-buffer.js");
      const r = await import("/static/terminal-redraw.js");
      return new Function("m", "r", body)(m, r);
    },
    { body: `return (${fn})(m, r);` },
  );
}

// tmux keeps appending until the history reaches its limit, then drops a
// tenth of the limit off the top (grid_collect_history): at a limit of 100,
// 99 lines plus 6 new ones leaves lines 11..105.
test("history sync: lines tmux drops off the top keep the rest in place", async ({
  page,
}) => {
  const result = await inPage(page, (m) => {
    const range = (a, b) =>
      Array.from({ length: b - a + 1 }, (_, i) => `line ${a + i}`);
    const held = range(1, 99);
    return {
      grown: m.alignHistory(held.slice(0, 93), held),
      dropped: m.alignHistory(held, range(11, 105)),
      paneGrew: m.alignHistory(held, range(1, 90)),
      cleared: m.alignHistory(held, ["$ "]),
    };
  });
  expect(result.grown).toEqual({ drop: 0, keep: 93, extended: false });
  expect(result.dropped).toEqual({ drop: 10, keep: 89, extended: false });
  expect(result.paneGrew).toEqual({ drop: 0, keep: 90, extended: false });
  expect(result.cleared).toBeNull();
});

test("history sync: repeating output keeps every line and never guesses a tail", async ({
  page,
}) => {
  const result = await inPage(page, async (m) => {
    const buffer = m.createTerminalBuffer({
      cols: 20,
      rows: 5,
      scrollback: 1000,
    });
    const ys = (n) => Array.from({ length: n }, () => "y");
    await buffer.syncWhole(["$ yes", ...ys(79)], false);
    // tmux has since dropped "$ yes" off its top and added eleven lines.
    await buffer.syncWhole(ys(90), false);
    const lines = [];
    for (let i = 0; i < buffer.historyRowCount(); i++) {
      lines.push(buffer.historyRow(i).translateToString(true));
    }
    const tail = await buffer.syncTail(ys(40), false, 10);
    buffer.dispose();
    return { lines, tail };
  });
  expect(result.lines).toEqual([
    "$ yes",
    ...Array.from({ length: 90 }, () => "y"),
  ]);
  expect(result.tail).toBeNull();
});

test("history sync: coloured capture lines compare equal wherever the capture starts", async ({
  page,
}) => {
  const result = await inPage(page, (m) => {
    // capture-pane -e output: the background set on "bg4" carries into the
    // next lines until "plain7" switches it off.
    const whole = [
      "\x1b[31mred1\x1b[39m",
      "\x1b[31mred2\x1b[39m",
      "\x1b[1m\x1b[31m\x1b[44mbold3\x1b[0m",
      "\x1b[44mbg4",
      "carried5",
      "more6",
      "\x1b[49mplain7",
    ];
    // The same lines captured after tmux dropped the first four: tmux states
    // the style the first line starts in.
    const next = ["\x1b[44mcarried5", "more6", "\x1b[49mplain7", "next8"];
    const held = m.normalizeCapture(whole);
    const captured = m.normalizeCapture(next);
    return { held, captured, aligned: m.alignHistory(held, captured) };
  });
  expect(result.held[1]).toBe("\x1b[0;31mred2");
  expect(result.held[4]).toBe("\x1b[0;44mcarried5");
  expect(result.held[6]).toBe("plain7");
  expect(result.captured.slice(0, 3)).toEqual(result.held.slice(4, 7));
  expect(result.aligned).toEqual({ drop: 4, keep: 3, extended: false });
});

test("history sync: a tail appends only when it overlaps the held end in one place", async ({
  page,
}) => {
  const result = await inPage(page, (m) => {
    const range = (a, b) =>
      Array.from({ length: b - a + 1 }, (_, i) => `line ${a + i}`);
    const held = [...range(1, 200), "$ ", ""];
    return {
      continues: m.alignTail(held, [...range(151, 200), "$ ", "", "new"], 10),
      // More new lines than the tail shows: only the blank lines line up.
      gap: m.alignTail(held, ["", ...range(1000, 1400)], 10),
    };
  });
  expect(result.continues).toEqual({ overlap: 52, extended: false });
  expect(result.gap).toBeNull();
});

// A display stand-in behind the renderer interface the redraw writer drives,
// counting full redraws: a headless xterm, the VT core of the one display
// the redraw writer draws.
const FAKE_DISPLAY = `(cols, rows) => {
  const display = new window.XtermHeadless.Terminal({
    cols, rows, scrollback: 100, allowProposedApi: true,
  });
  const lines = () => {
    const out = [];
    for (let y = 0; y < display.buffer.active.length; y++) {
      out.push(display.buffer.active.getLine(y));
    }
    return out;
  };
  const renderer = {
    resets: 0,
    get cols() { return display.cols; },
    get rows() { return display.rows; },
    viewport: () => ({
      length: display.buffer.active.length,
      top: display.buffer.active.viewportY,
    }),
    resize: (c, r) => display.resize(c, r),
    reset() { this.resets++; display.reset(); },
    scrollLines: (n) => display.scrollLines(n),
    write: (d) => new Promise((res) => display.write(d, res)),
    dispose: () => display.dispose(),
    text: () => lines().map((l) => l.translateToString(false).trimEnd()),
    wrapped: () => lines().map((l) => l.isWrapped),
  };
  return renderer;
}`;

async function withDisplay(page, fn) {
  await bootTerminal(page);
  return page.evaluate(
    async ({ body, fake }) => {
      const m = await import("/static/terminal-buffer.js");
      const r = await import("/static/terminal-redraw.js");
      const d = await import("/static/terminal-document.js");
      const makeDisplay = new Function(`return (${fake})`)();
      return new Function("m", "r", "makeDisplay", "d", body)(
        m,
        r,
        makeDisplay,
        d,
      );
    },
    { body: `return (${fn})(m, r, makeDisplay, d);`, fake: FAKE_DISPLAY },
  );
}

// capture-pane -J gives one history line per logical line; a line wrapped
// on screen and the same line in history get one key, the display marks
// the continuation rows wrapped, and the reader's document holds each as
// one line carrying the marker on its key.
test("line keys: a wrapped line is one line on the screen, in history and on the display", async ({
  page,
}) => {
  const result = await withDisplay(page, async (m, r, makeDisplay, d) => {
    const renderer = makeDisplay(10, 4);
    const buffer = m.createTerminalBuffer({
      cols: 10,
      rows: 4,
      scrollback: 100,
    });
    const view = r.createRedrawWriter(buffer, renderer);
    await buffer.syncWhole(["short", "x".repeat(15), "after"], false);
    await buffer.writeScreen(`\x1b[H${"w".repeat(15)}\r\n$ `);
    await view.flush();
    const reader = d.createTerminalDocument({
      buffer,
      oscMarkers: new Map([
        [1, "C"],
        [3, "D;0"],
        [4, "A"],
      ]),
    });
    const snapshot = reader.snapshot();
    const out = {
      lines: snapshot.lines.map((l) => l.text),
      osc: snapshot.lines.map((l) => l.osc),
      wrapped: renderer.wrapped(),
      rows: renderer.text(),
      cursor: buffer.cursorLineKey(),
    };
    buffer.dispose();
    renderer.dispose();
    return out;
  });
  // history: short(0), xxx… over two rows(1), after(2); screen: www… over
  // two rows(3), "$ "(4), then blank rows.
  expect(result.rows.slice(0, 7)).toEqual([
    "short",
    "xxxxxxxxxx",
    "xxxxx",
    "after",
    "wwwwwwwwww",
    "wwwww",
    "$",
  ]);
  expect(result.osc).toEqual([null, "C", null, "D;0", "A"]);
  expect(result.lines).toEqual([
    "short",
    "x".repeat(15),
    "after",
    "w".repeat(15),
    "$",
  ]);
  expect(result.wrapped.slice(0, 7)).toEqual([
    false,
    false,
    true,
    false,
    false,
    true,
    false,
  ]);
  expect(result.cursor).toBe(4);
});

// A long line whose top rows have scrolled into history while the rest is
// still on screen: capture-pane -J gives it only up to the screen, and the
// endpoint says it continues. When it has scrolled off, the next capture
// has it whole.
test("history sync: a line straddling the screen top keeps its key and grows in place", async ({
  page,
}) => {
  const result = await withDisplay(page, async (m, r, makeDisplay, d) => {
    const renderer = makeDisplay(10, 4);
    const buffer = m.createTerminalBuffer({
      cols: 10,
      rows: 4,
      scrollback: 100,
    });
    const view = r.createRedrawWriter(buffer, renderer);
    const long = "L".repeat(10) + "M".repeat(10) + "N".repeat(5);
    await buffer.writeScreen(`\x1b[?1049h\x1b[H${long.slice(10)}\r\nprompt`);
    await buffer.syncWhole(["one", "two", long.slice(0, 10)], true);
    await view.flush();
    const straddleKey = buffer.screenKeyBase();
    const oscMarkers = new Map([
      [2, "C"],
      [3, "A"],
    ]);
    const reader = d.createTerminalDocument({
      buffer,
      oscMarkers,
    });
    const straddling = reader.snapshot().lines.map((l) => [l.text, l.osc]);
    const resetsBefore = renderer.resets;
    // The pane scrolled: the long line and "three" left the screen.
    await buffer.writeScreen("\x1b[2J\x1b[Hprompt");
    const moved = await buffer.syncTail(
      ["one", "two", long, "three"],
      false,
      2,
    );
    await view.flush();
    oscMarkers.delete(3);
    oscMarkers.set(buffer.cursorLineKey(), "A");
    const rows = renderer.text();
    const out = {
      straddleKey,
      straddling,
      scrolled: reader.snapshot().lines.map((l) => [l.text, l.osc]),
      moved,
      resets: renderer.resets - resetsBefore,
      historyStart: buffer.historyStart(),
      rows: rows.slice(0, 7),
      promptKey: buffer.cursorLineKey(),
    };
    buffer.dispose();
    return out;
  });
  const LONG = "L".repeat(10) + "M".repeat(10) + "N".repeat(5);
  expect(result.straddleKey).toBe(2);
  expect(result.straddling).toEqual([
    ["one", null],
    ["two", null],
    [LONG, "C"],
    ["prompt", "A"],
  ]);
  expect(result.scrolled).toEqual([
    ["one", null],
    ["two", null],
    [LONG, "C"],
    ["three", null],
    ["prompt", "A"],
  ]);
  expect(result.moved).toMatchObject({
    replaced: false,
    before: 3,
    after: 4,
  });
  expect(result.resets).toBe(0);
  expect(result.historyStart).toBe(0);
  expect(result.rows).toEqual([
    "one",
    "two",
    "LLLLLLLLLL",
    "MMMMMMMMMM",
    "NNNNN",
    "three",
    "prompt",
  ]);
  expect(result.promptKey).toBe(4);
});

// At a narrow width a long history line takes several display rows; the
// history is capped by those rows so the display never trims its own top.
test("history sync: history is capped by display rows at a narrow width", async ({
  page,
}) => {
  const result = await withDisplay(page, async (m, r, makeDisplay) => {
    const renderer = makeDisplay(10, 4);
    const buffer = m.createTerminalBuffer({
      cols: 10,
      rows: 4,
      scrollback: 100,
    });
    const view = r.createRedrawWriter(buffer, renderer);
    const lines = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(23)}`,
    );
    await buffer.syncWhole(lines, false);
    await view.flush();
    const out = {
      held: buffer.historyRowCount(),
      start: buffer.historyStart(),
      displayRows: renderer.viewport().length,
      firstRow: renderer.text()[0],
    };
    buffer.dispose();
    return out;
  });
  // 25 cells take three rows at 10 columns: 40 lines are 120 rows, past the
  // 90-row budget (100 minus the screen's 10), so history is cut to 20
  // lines (60 rows).
  expect(result.held).toBe(20);
  expect(result.start).toBe(20);
  expect(result.displayRows).toBeLessThanOrEqual(100 + 4);
  expect(result.firstRow).toBe("20xxxxxxxx");
});

// The straddle holds only while screen row 0 still shows the remainder it
// showed at the sync: once that has scrolled off, a prompt drawn before the
// next sync keys to its own line, and keeps that key after the sync.
test("history sync: a straddle that scrolled off before the next sync keys the prompt to its own line", async ({
  page,
}) => {
  const result = await withDisplay(page, async (m) => {
    const buffer = m.createTerminalBuffer({
      cols: 10,
      rows: 4,
      scrollback: 100,
    });
    const long = "L".repeat(10) + "M".repeat(5);
    await buffer.writeScreen(
      `\x1b[?1049h\x1b[H${long.slice(10)}\r\nout1\r\nout2`,
    );
    await buffer.syncWhole(["one", "two", long.slice(0, 10)], true);
    const straddling = buffer.screenKeyBase();
    // tmux scrolls the remainder off the top and draws a prompt.
    await buffer.writeScreen("\x1b[H\x1b[2Kout1\r\n\x1b[2Kout2\r\n\x1b[2K$ ");
    const promptBefore = buffer.cursorLineKey();
    await buffer.syncTail(["one", "two", long], false, 2);
    const promptAfter = buffer.cursorLineKey();
    buffer.dispose();
    return { straddling, promptBefore, promptAfter };
  });
  // history: one(0) two(1) long(2); screen after the scroll: out1(3)
  // out2(4) "$ "(5).
  expect(result.straddling).toBe(2);
  expect(result.promptBefore).toBe(5);
  expect(result.promptAfter).toBe(5);
});

// The part of a straddling line captured into history is whole screen
// rows, so a blank at its last column belongs to the line.
test("document: a straddling line keeps the blank at the wrap", async ({
  page,
}) => {
  const result = await withDisplay(page, async (m, r, makeDisplay, d) => {
    const read = async (captured) => {
      const buffer = m.createTerminalBuffer({
        cols: 10,
        rows: 4,
        scrollback: 100,
      });
      await buffer.writeScreen("\x1b[?1049h\x1b[Habc\r\n$ ");
      await buffer.syncWhole(["one", captured], true);
      const doc = d.createTerminalDocument({ buffer, oscMarkers: new Map() });
      const lines = doc.snapshot().lines.map((l) => l.text);
      buffer.dispose();
      return lines;
    };
    return {
      spaced: await read("123456789 "),
      trimmed: await read("123456789"),
    };
  });
  expect(result.spaced).toEqual(["one", "123456789 abc", "$"]);
  expect(result.trimmed).toEqual(["one", "123456789 abc", "$"]);
});

// With tmux's status line on top, the pane starts on the second row: the
// straddling line joins there, the status row is no line, and redrawing it
// moves no line key.
test("document: with the status line on top the pane's first row joins the straddle", async ({
  page,
}) => {
  const result = await withDisplay(page, async (m, r, makeDisplay, d) => {
    const { createMarkerBook } = await import("/static/terminal-markers.js");
    const buffer = m.createTerminalBuffer({
      cols: 10,
      rows: 5,
      scrollback: 100,
    });
    buffer.setStatus(1, "top");
    await buffer.writeScreen(
      "\x1b[?1049h\x1b[H[0] 10:00\x1b[2;1Habc\r\nout\r\n$ ",
    );
    await buffer.syncWhole(["one", "123456789 "], true);
    const book = createMarkerBook(buffer);
    book.record("A");
    const doc = d.createTerminalDocument({ buffer, oscMarkers: book.map });
    const snap = () => {
      const { lines, status } = doc.snapshot();
      return {
        lines: lines.map((l) => [l.text, l.osc]),
        status: status.rows.map((row) => row.runs.map((x) => x.text).join("")),
      };
    };
    const before = { ...snap(), key: buffer.cursorLineKey() };
    await buffer.writeScreen("\x1b[s\x1b[1;1H\x1b[2K[0] 10:01\x1b[u");
    const after = { ...snap(), key: buffer.cursorLineKey() };
    buffer.dispose();
    return { before, after };
  });
  const lines = [
    ["one", null],
    ["123456789 abc", null],
    ["out", null],
    ["$", "A"],
  ];
  expect(result.before.lines).toEqual(lines);
  expect(result.before.status).toEqual(["[0] 10:00"]);
  expect(result.after.lines).toEqual(lines);
  expect(result.after.status).toEqual(["[0] 10:01"]);
  expect(result.after.key).toBe(result.before.key);
});

// A wrapped line whose first row scrolls off the top is still on the
// screen: until the next sync the lines below it keep their keys, so a
// prompt's marker stays on the prompt.
test("markers: a wrapped line half scrolled off moves no line key", async ({
  page,
}) => {
  const result = await withDisplay(page, async (m, r, makeDisplay, d) => {
    const { createMarkerBook } = await import("/static/terminal-markers.js");
    const buffer = m.createTerminalBuffer({
      cols: 10,
      rows: 5,
      scrollback: 100,
    });
    const book = createMarkerBook(buffer);
    const doc = d.createTerminalDocument({
      buffer,
      get oscMarkers() {
        return book.map;
      },
    });
    await buffer.writeScreen(
      `\x1b[?1049h\x1b[1;4r\x1b[H${"w".repeat(15)}\r\nout\r\n$ `,
    );
    book.record("A");
    const recorded = buffer.cursorLineKey();
    const lines = () => doc.snapshot().lines.map((l) => [l.text, l.osc]);
    // A linefeed on the region's last row scrolls the first w row off.
    await buffer.writeScreen("cmd\r\n");
    const linefeed = { key: buffer.rowKey(2), lines: lines() };
    // A scroll-up takes the rest of that line and nothing more.
    await buffer.writeScreen("\x1b[S");
    const scrollUp = { key: buffer.rowKey(1), lines: lines() };
    buffer.dispose();
    return { recorded, linefeed, scrollUp };
  });
  expect(result.linefeed.key).toBe(result.recorded);
  expect(result.linefeed.lines).toEqual([
    ["wwwww", null],
    ["out", null],
    ["$ cmd", "A"],
  ]);
  expect(result.scrollUp.key).toBe(result.recorded);
  expect(result.scrollUp.lines).toEqual([
    ["out", null],
    ["$ cmd", "A"],
  ]);
});

// Markers recorded while history lags the screen: a command whose output
// scrolls 30 lines past a 6-row screen, then its D and A markers, then a
// sync. tmux scrolls its client with a linefeed at the bottom of a region
// above the status line — or, when it repaints instead, gives no scroll
// signal at all and the sync places the markers by their line's text.
async function markersAfterBurst(page, repaint) {
  await bootTerminal(page);
  return page.evaluate(
    async ({ repaint }) => {
      const m = await import("/static/terminal-buffer.js");
      const { createMarkerBook } = await import("/static/terminal-markers.js");
      const buffer = m.createTerminalBuffer({
        cols: 20,
        rows: 6,
        scrollback: 200,
      });
      const book = createMarkerBook(buffer);
      const stream = [
        "$ run",
        ...Array.from({ length: 30 }, (_, i) => `out ${i}`),
      ];
      await buffer.writeScreen("\x1b[?1049h\x1b[H$ run");
      await buffer.syncWhole([], false);
      book.record("C");
      let left;
      if (repaint) {
        // The last four output lines and a prompt, drawn row by row.
        left = stream.length - 4;
        const rows = [...stream.slice(left), "$ "];
        let out = "";
        rows.forEach((row, r) => {
          out += `\x1b[${r + 1};1H\x1b[2K${row}`;
        });
        await buffer.writeScreen(out);
      } else {
        await buffer.writeScreen("\x1b[1;5r\x1b[2;1H");
        for (const line of stream.slice(1)) {
          await buffer.writeScreen(`${line}\x1b[K\r\n`);
        }
        await buffer.writeScreen("\x1b[1;6r\x1b[5;1H$ ");
        left = buffer.scrolledRows();
      }
      book.record("D;0");
      book.record("A");
      const scrolled = buffer.scrolledRows();
      const moved = await buffer.syncWhole(stream.slice(0, left), false);
      book.place(moved, scrolled);
      const out = {
        left,
        scrolled,
        promptKey: buffer.cursorLineKey(),
        runKey: buffer.historyStart(),
        markers: Object.fromEntries(book.map),
      };
      buffer.dispose();
      return out;
    },
    { repaint },
  );
}

test("markers: a prompt after output that scrolled lands on its own line", async ({
  page,
}) => {
  const result = await markersAfterBurst(page, false);
  expect(result.scrolled).toBeGreaterThan(20);
  expect(result.markers[result.runKey]).toBe("C");
  expect(result.markers[result.promptKey]).toBe("D;0|A");
});

test("markers: a repaint with no scroll signal is placed by the line's text", async ({
  page,
}) => {
  const result = await markersAfterBurst(page, true);
  expect(result.scrolled).toBe(0);
  expect(result.markers[result.runKey]).toBe("C");
  expect(result.markers[result.promptKey]).toBe("D;0|A");
});

// A full-screen app keeps no history in tmux or the display, so a swipe
// scrolls the app: a wheel event through tmux, which forwards it to an app
// that tracks the mouse and enters copy-mode for one that does not. On the
// normal screen a swipe still scrolls the display's scrollback.

const ALT_INPUT_SCRIPT = require("path").join(
  __dirname,
  "assets",
  "alt-screen-input.sh",
);

const fs = require("fs");

// The client position of the middle of a terminal cell, measured from the
// terminal box and the grid tmux was given.
function cellPoint(page, col, row) {
  return page.evaluate(
    ({ col, row }) => {
      const r = document.getElementById("terminal").getBoundingClientRect();
      const t = window.__mobuxView.test;
      return {
        x: r.left + ((col + 0.5) * r.width) / t.cols(),
        y: r.top + ((row + 0.5) * r.height) / t.rows(),
      };
    },
    { col, row },
  );
}

// Finger down from a cell: reveals what is above.
async function swipeDown(page, from = { col: 2, row: 2 }) {
  const { x, y } = await cellPoint(page, from.col, from.row);
  await touch(page, "touchstart", x, y);
  for (let i = 1; i <= 10; i++) await touch(page, "touchmove", x, y + i * 20);
  await touch(page, "touchend", x, y + 200);
}

const paneFlag = (flag) =>
  tmux(`display -p -t ${SESSION} '#{${flag}}'`).toString().trim();

const wheelEvents = (out) =>
  [...fs.readFileSync(out, "utf8").matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)].map(
    (m) => m.slice(1).join(";"),
  );

async function startAltInputApp(page, mode) {
  const out = `${SANDBOX_HOME}/alt-input-${Date.now()}`;
  fs.mkdirSync(SANDBOX_HOME, { recursive: true });
  fs.writeFileSync(out, "");
  tmux(
    `send-keys -t ${SESSION} "bash ${ALT_INPUT_SCRIPT} ${out} ${mode}" Enter`,
  );
  await expect
    .poll(
      async () =>
        (await terminalLines(page)).some((l) => l.trim() === "ALT-INPUT-READY"),
      { timeout: 10000 },
    )
    .toBe(true);
  expect(paneFlag("alternate_on")).toBe("1");
  return out;
}

// The page goes first: a fling keeps sending wheel events after the swipe.
async function stopAltInputApp(page) {
  await page.close();
  if (paneFlag("pane_in_mode") === "1") {
    tmux(`send-keys -t ${SESSION} -X cancel`);
  }
  tmux(`send-keys -t ${SESSION} C-c`);
}

const displayAtBottom = (page) =>
  page.evaluate(() => {
    const t = window.__mobuxView.test;
    return t.viewportY() === t.bufferLength() - t.rows();
  });

test("alt-screen swipe: an app that tracks the mouse gets wheel events at the touched cell and the display stays put", async ({
  page,
}) => {
  await bootTerminal(page);
  const out = await startAltInputApp(page, "mouse");
  try {
    const viewportBefore = await page.evaluate(() =>
      window.__mobuxView.test.viewportY(),
    );
    // The client learns the pane's screen from the panes answer a touch asks
    // for, so the first swipe may still scroll the display.
    await expect
      .poll(
        async () => {
          await swipeDown(page);
          return wheelEvents(out).length;
        },
        { timeout: 10000, intervals: [1000] },
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(new Set(wheelEvents(out))).toEqual(new Set(["64;3;3"]));
    expect(paneFlag("pane_in_mode")).toBe("0");
    expect(await page.evaluate(() => window.__mobuxView.test.viewportY())).toBe(
      viewportBefore,
    );
  } finally {
    await stopAltInputApp(page);
  }
});

test("alt-screen swipe: an answer that arrives mid-swipe hands the rest to the app and pins the display", async ({
  page,
}) => {
  tmux(`send-keys -t ${SESSION} "seq 1 300" Enter`);
  execSync("sleep 0.5");
  await bootTerminal(page);
  await expect
    .poll(async () => numberCounts(await terminalLines(page))["300"], {
      timeout: 10000,
    })
    .toBe(1);
  const held = [];
  const isPanes = (url) => new URL(url).pathname.endsWith("/panes");
  let holding = true;
  await page.route(isPanes, (route) =>
    holding ? held.push(route) : route.continue(),
  );
  const out = await startAltInputApp(page, "mouse");
  try {
    const { x, y } = await cellPoint(page, 2, 2);
    await touch(page, "touchstart", x, y);
    for (let i = 1; i <= 5; i++) await touch(page, "touchmove", x, y + i * 20);
    expect(await displayAtBottom(page), "the swipe starts on the display").toBe(
      false,
    );

    holding = false;
    for (const route of held) await route.continue();
    await page.waitForTimeout(500);
    for (let i = 6; i <= 12; i++) await touch(page, "touchmove", x, y + i * 20);
    await touch(page, "touchend", x, y + 240);

    await expect.poll(() => wheelEvents(out).length).toBeGreaterThan(0);
    expect(new Set(wheelEvents(out))).toEqual(new Set(["64;3;3"]));
    expect(await displayAtBottom(page)).toBe(true);
  } finally {
    await stopAltInputApp(page);
  }
});

test("alt-screen swipe: with the status line on top a swipe from the top row reaches the app", async ({
  page,
}) => {
  tmux(`set-option -t ${SESSION} status-position top`);
  try {
    await bootTerminal(page);
    const out = await startAltInputApp(page, "mouse");
    try {
      await expect
        .poll(
          async () => {
            await swipeDown(page, { col: 2, row: 0 });
            return wheelEvents(out).length;
          },
          { timeout: 10000, intervals: [1000] },
        )
        .toBeGreaterThan(0);
      expect(wheelEvents(out)[0]).toBe("64;3;1");
    } finally {
      await stopAltInputApp(page);
    }
  } finally {
    tmux(`set-option -u -t ${SESSION} status-position`);
  }
});

test("alt-screen swipe: an app that ignores the mouse scrolls in tmux copy-mode", async ({
  page,
}) => {
  await bootTerminal(page);
  const out = await startAltInputApp(page, "plain");
  try {
    expect(paneFlag("pane_in_mode")).toBe("0");
    await expect
      .poll(
        async () => {
          await swipeDown(page);
          return paneFlag("pane_in_mode");
        },
        { timeout: 10000, intervals: [1000] },
      )
      .toBe("1");
    expect(fs.readFileSync(out, "utf8")).toBe("");
  } finally {
    await stopAltInputApp(page);
  }
});

test("alt-screen swipe: on the normal screen a swipe scrolls the display's scrollback", async ({
  page,
}) => {
  tmux(`send-keys -t ${SESSION} "seq 1 300" Enter`);
  execSync("sleep 0.5");
  await bootTerminal(page);
  await expect
    .poll(async () => numberCounts(await terminalLines(page))["300"], {
      timeout: 10000,
    })
    .toBe(1);
  expect(paneFlag("alternate_on")).toBe("0");
  const viewportBefore = await page.evaluate(() =>
    window.__mobuxView.test.viewportY(),
  );
  await swipeDown(page);
  await expect
    .poll(() => page.evaluate(() => window.__mobuxView.test.viewportY()), {
      timeout: 5000,
    })
    .toBeLessThan(viewportBefore);
  expect(paneFlag("pane_in_mode")).toBe("0");
});

// Chunks the stream delivers faster than the screen refreshes are drawn
// together: one app redraw that tmux relays as several frames is painted once,
// not half-done several times.
test("paint: a burst of chunks that arrives within one frame paints once", async ({
  page,
}) => {
  await bootTerminal(page);
  await page.evaluate(() => window.__mobuxView.test.inject(""));
  const painted = await page.evaluate(async () => {
    const t = window.__mobuxView.test;
    const before = t.paintCount();
    const writes = [];
    for (let i = 0; i < 8; i++) writes.push(t.writeData(`burst ${i}\r\n`));
    await Promise.all(writes);
    return t.paintCount() - before;
  });
  expect(painted).toBe(1);
  const lines = await terminalLines(page);
  for (let i = 0; i < 8; i++) expect(lines).toContain(`burst ${i}`);
});

const displayHas = (page, text) =>
  page.evaluate(async (text) => {
    const t = window.__mobuxView.test;
    for (let y = 0; y < t.bufferLength(); y++) {
      if ((t.lineText(y) || "").includes(text)) return true;
    }
    return false;
  }, text);

const frames = (page, n) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, n);

// A hidden tab runs no animation frames: the terminal still connects and a
// history reload still completes.
test("paint: a hidden tab connects and reloads its history", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
    Object.defineProperty(document, "hidden", { get: () => true });
    window.requestAnimationFrame = () => 0;
  });
  await page.goto(`${BASE}/app#/s/${SESSION}`, { waitUntil: "load" });
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    null,
    { timeout: 8000, polling: 100 },
  );
  const reload = await page.evaluate(() =>
    Promise.race([
      window.__mobuxView.test.reloadHistory().then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 5000)),
    ]),
  );
  expect(reload).toBe("done");
});

// A chunk after a quiet frame is painted as it is parsed; chunks that keep
// flowing are painted once per frame.
test("paint: a keypress echo is painted without waiting for a frame", async ({
  page,
}) => {
  await bootTerminal(page);
  const waited = await page.evaluate(async () => {
    const t = window.__mobuxView.test;
    const echoFrames = () =>
      new Promise((resolve) => {
        const before = t.paintCount();
        const off = t.onPtyData(() => {
          off();
          let frames = 0;
          const tick = () => {
            if (t.paintCount() !== before) return resolve(frames);
            frames++;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        window.__mobuxView.send("x");
      });
    const out = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      out.push(await echoFrames());
    }
    return out;
  });
  expect(
    waited.filter((frames) => frames === 0).length,
    `frames each echo waited for its paint: ${waited}`,
  ).toBeGreaterThanOrEqual(4);
});

test("paint: a synchronized update is not painted until it ends", async ({
  page,
}) => {
  await bootTerminal(page);
  await page.evaluate(() => {
    window.__mobuxView.test.setSyncHold(60000);
    return window.__mobuxView.test.inject("");
  });
  const before = await page.evaluate(() =>
    window.__mobuxView.test.paintCount(),
  );
  await page.evaluate(() => {
    window.__syncWrite = window.__mobuxView.test.writeData(
      "\x1b[?2026hSYNC-HELD\r\n",
    );
  });
  await frames(page, 4);
  expect(await displayHas(page, "SYNC-HELD")).toBe(false);
  expect(await page.evaluate(() => window.__mobuxView.test.paintCount())).toBe(
    before,
  );
  await page.evaluate(async () => {
    await window.__mobuxView.test.writeData("SYNC-DONE\r\n\x1b[?2026l");
    await window.__syncWrite;
  });
  expect(await displayHas(page, "SYNC-HELD")).toBe(true);
  expect(await displayHas(page, "SYNC-DONE")).toBe(true);
  expect(await page.evaluate(() => window.__mobuxView.test.paintCount())).toBe(
    before + 1,
  );
});

test("paint: a synchronized update that never ends is painted after a short hold", async ({
  page,
}) => {
  await bootTerminal(page);
  await page.evaluate(() => window.__mobuxView.test.inject(""));
  const held = await page.evaluate(async () => {
    window.__mobuxView.test.setSyncHold(300);
    const started = performance.now();
    await window.__mobuxView.test.writeData("\x1b[?2026hSYNC-LOST\r\n");
    return performance.now() - started;
  });
  expect(await displayHas(page, "SYNC-LOST")).toBe(true);
  expect(held).toBeGreaterThanOrEqual(290);
  expect(held).toBeLessThan(10000);
});

// The finger travel of one wheel notch, in rows (terminal.js).
const WHEEL_NOTCH_LINES = 3;

// A swipe that moves the finger several notches within one frame, the way a
// fast phone swipe does.
function swipeInOneFrame(page, from, travel, moves, { resize = false } = {}) {
  return page.evaluate(
    ({ x, y, travel, moves, resize }) => {
      const overlay = document.getElementById("touchOverlay");
      overlay.style.pointerEvents = "auto";
      const fire = (type, cy) => {
        const t = new Touch({
          identifier: 1,
          target: overlay,
          clientX: x,
          clientY: cy,
          pageX: x + window.scrollX,
          pageY: cy + window.scrollY,
        });
        overlay.dispatchEvent(
          new TouchEvent(type, {
            touches: type === "touchend" ? [] : [t],
            changedTouches: [t],
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire("touchstart", y);
      for (let i = 1; i <= moves; i++) {
        fire("touchmove", y + (i * travel) / moves);
      }
      if (resize) window.__mobuxView.test.resize();
      fire("touchend", y + travel);
    },
    { ...from, travel, moves, resize },
  );
}

test("alt-screen swipe: the wheel steps of one frame go to tmux in one message", async ({
  page,
}) => {
  const sent = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      if (typeof f.payload === "string") sent.push(f.payload);
    }),
  );
  const wheelFrames = () => sent.filter((p) => p.includes("\x1b[<6"));
  await bootTerminal(page);
  const out = await startAltInputApp(page, "mouse");
  try {
    const from = await cellPoint(page, 2, 2);
    await expect
      .poll(
        async () => {
          await swipeInOneFrame(page, from, 200, 10);
          return wheelEvents(out).length;
        },
        { timeout: 10000, intervals: [1000] },
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(500);
    fs.writeFileSync(out, "");
    sent.length = 0;

    await swipeInOneFrame(page, from, 200, 10, { resize: true });
    const cellHeight = await page.evaluate(
      () => window.__mobuxView.test.cellMetrics().height,
    );
    const steps = Math.floor((200 * 2.5) / (cellHeight * WHEEL_NOTCH_LINES));
    expect(steps).toBeGreaterThan(1);
    await expect.poll(() => wheelEvents(out).length).toBe(steps);
    expect(wheelEvents(out)).toEqual(Array(steps).fill("64;3;3"));
    expect(wheelFrames()).toEqual(["\x1b[<64;3;3M".repeat(steps)]);
    const wheelAt = sent.indexOf(wheelFrames()[0]);
    const resizeAt = sent.findIndex((p) => p.includes('"type":"resize"'));
    expect(resizeAt, "the resize of the same frame is sent").toBeGreaterThan(
      -1,
    );
    expect(wheelAt, "the wheel steps go ahead of it").toBeLessThan(resizeAt);
  } finally {
    await stopAltInputApp(page);
  }
});
