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

const { test, expect } = require('./fixtures.cjs');
const { execSync } = require('child_process');

const BASE = process.env.MOBUX_URL || 'https://localhost:5151';
const USER = process.env.MOBUX_USER || '';
const PASS = process.env.MOBUX_PASS || '';
const AUTH = USER && PASS ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : null;
const SESSION = process.env.MOBUX_TEST_SESSION || 'mobux-critical';

const TMUX_CMD = process.env.MOBUX_TEST_TMUX || 'tmux -L mobux-test';
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || '/tmp/mobux-smoke/home';
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = (args) => execSync(`${TMUX_CMD} ${args}`, { stdio: 'pipe' });

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
  // bash --norc --noprofile gives us a clean, predictable prompt.
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
  tmux(`send-keys -t ${SESSION} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${SESSION} "clear" Enter`);
  execSync('sleep 0.3');
});

test.afterAll(() => {
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
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
  page.on('pageerror', (e) => captured.pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') captured.consoleErrors.push(m.text());
  });
  page.on('requestfailed', (r) => {
    const url = r.url();
    // Ignore expected failures (favicon polls, etc.) — but ALL static
    // assets under /static/* are critical and must succeed.
    if (url.includes('/static/')) {
      captured.failedRequests.push(`${url} ${r.failure()?.errorText}`);
    }
  });
  return captured;
}

function assertNoFailures(captured) {
  const tolerable = (s) => TOLERATED_ERROR_PATTERNS.some((re) => re.test(s));
  const realPageErrors = captured.pageErrors.filter((s) => !tolerable(s));
  const realConsole = captured.consoleErrors.filter((s) => !tolerable(s));
  expect(realPageErrors, 'uncaught page errors').toEqual([]);
  expect(realConsole, 'console.error calls').toEqual([]);
  expect(captured.failedRequests, 'failed /static/ requests').toEqual([]);
}

// ── Helpers ────────────────────────────────────────────────────────

async function bootTerminal(page) {
  await page.goto(`${BASE}/s/${SESSION}`, { waitUntil: 'load' });
  // Wait for the renderer to mount AND have visible dimensions —
  // renderer-agnostic.
  await page.waitForFunction(() => {
    const t = document.getElementById('terminal');
    if (!t || t.classList.contains('hidden')) return false;
    const r = t.getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  }, { timeout: 8000 });
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
    const t = document.getElementById('terminal');
    // innerText (unlike textContent) skips elements with display:none,
    // which is what Ace does to its gutter when showGutter is false.
    // Without this, the test sees gutter line numbers as if they were
    // real terminal content.
    return (t?.innerText || '').replace(/\s+/g, ' ').trim();
  });
}

// ── Tests ──────────────────────────────────────────────────────────

test('boot: terminal page loads without JS errors or failed assets', async ({ page }) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  // Give renderer + theme machinery a moment to throw if it's going to.
  await page.waitForTimeout(500);
  assertNoFailures(captured);
});

test('boot: renderer mounts with visible dimensions', async ({ page }) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  const dims = await page.evaluate(() => {
    const t = document.getElementById('terminal');
    const r = t.getBoundingClientRect();
    return { w: r.width, h: r.height, hidden: t.classList.contains('hidden') };
  });
  expect(dims.hidden, '#terminal must be visible').toBe(false);
  expect(dims.w, '#terminal width').toBeGreaterThan(100);
  expect(dims.h, '#terminal height').toBeGreaterThan(100);
  assertNoFailures(captured);
});

test('PTY roundtrip: typing in the browser produces real output in the buffer', async ({ page }) => {
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
  await expect.poll(
    () => visibleTerminalText(page),
    { timeout: 10000, intervals: [200, 400, 800] },
  ).toContain(marker);
  assertNoFailures(captured);
});

test('PTY roundtrip: tmux split-window produces a second pane', async ({ page }) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  // Snapshot pane count from tmux directly (source of truth).
  const before = parseInt(
    execSync(`${TMUX_CMD} list-panes -t ${SESSION} | wc -l`).toString().trim(),
    10,
  );
  // Send tmux prefix (Ctrl-B) then '|' to split-window -h.
  // Default mobux tmux config uses 'C-b' as prefix.
  await page.evaluate(() => window.__mobuxView.send('\x02'));   // Ctrl-B
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__mobuxView.send('"'));      // default split-window vertical
  await page.waitForTimeout(500);
  const after = parseInt(
    execSync(`${TMUX_CMD} list-panes -t ${SESSION} | wc -l`).toString().trim(),
    10,
  );
  expect(after, 'tmux pane count should increase after split').toBeGreaterThan(before);
  // Send Ctrl-B x then y to close the new pane so we don't leave litter.
  await page.evaluate(() => window.__mobuxView.send('\x02xy'));
  await page.waitForTimeout(400);
  assertNoFailures(captured);
});

test('PTY roundtrip: tmux new-window appears in the /panes API and is selectable', async ({ page }) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  const sessionsBefore = await page.request.get(`${BASE}/api/sessions`).then((r) => r.json());
  const winsBefore = sessionsBefore.find((s) => s.name === SESSION)?.windows ?? 0;

  // Ctrl-B c — new-window
  await page.evaluate(() => window.__mobuxView.send('\x02c'));
  await page.waitForTimeout(800);

  const sessionsAfter = await page.request.get(`${BASE}/api/sessions`).then((r) => r.json());
  const winsAfter = sessionsAfter.find((s) => s.name === SESSION)?.windows ?? 0;
  expect(winsAfter, 'tmux window count should increase').toBeGreaterThan(winsBefore);

  // Clean up — Ctrl-B & then y to confirm kill-window.
  await page.evaluate(() => window.__mobuxView.send('\x02&y'));
  await page.waitForTimeout(400);
  assertNoFailures(captured);
});

test('cell-width parity: no left padding gutter and right-most cell hugs the right edge', async ({ page }) => {
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
  expect(cols, 'sterk should report a sane column count').toBeGreaterThan(20);
  // Build a string of exactly `cols` `#` characters and echo it. Doing
  // the expansion locally instead of inside the shell avoids tmux's
  // tab-completion / prompt-echo confusing the output (the shell would
  // echo back the full command line including the `printf $(seq ...)`
  // which our regex would then false-match on).
  const hashes = '#'.repeat(cols);
  await page.evaluate((s) => window.__mobuxView.send(`printf '%s\\n' '${s}'\r`), hashes);
  // Wait until we see a line that is JUST `#` characters of the expected
  // length (no prompt prefix, no other text). Anchor with a non-`#`
  // boundary on each side to defeat the cmdline echo above it.
  await expect.poll(
    async () => {
      const t = await visibleTerminalText(page);
      return new RegExp(`(^|[^#])#{${cols}}([^#]|$)`).test(t);
    },
    { timeout: 10000, intervals: [200, 400, 800] },
  ).toBe(true);

  // Now measure: find the leftmost and rightmost `#` characters in the
  // rendered DOM and assert their positions vs. the #terminal box.
  const geom = await page.evaluate((expectedCols) => {
    const t = document.getElementById('terminal');
    const tRect = t.getBoundingClientRect();
    // Ace renders each line as one or more spans inside .ace_line.
    // We want the row whose content is JUST `#` characters — the
    // printf output, not the cmdline echo above it. Match on lines
    // that are mostly `#` with no leading prompt (`$` etc.).
    let bestRange = null;
    let bestLen = 0;
    const lines = t.querySelectorAll('.ace_line, .ace_line_group');
    for (const line of lines) {
      const text = line.textContent || '';
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
      let firstNode = null, firstOff = -1;
      let lastNode = null, lastOff = -1;
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

  expect(geom.range, 'should have found a long run of # in the DOM').toBeTruthy();
  // Left edge: first `#` should be within 8px of the container's left edge.
  const leftGap = geom.range.firstRect.left - geom.terminal.left;
  expect(leftGap, `left-edge gap (px): ${leftGap}`).toBeLessThanOrEqual(8);
  expect(leftGap, `left-edge gap (px): ${leftGap}`).toBeGreaterThanOrEqual(0);
  // Right edge: last `#` should be within 12px of the container's right
  // edge (the cell itself is ~9px wide so up to one cell of slack is
  // allowed if the column count isn't an exact divisor).
  const rightGap = geom.terminal.right - geom.range.lastRect.right;
  expect(rightGap, `right-edge gap (px): ${rightGap}`).toBeLessThanOrEqual(12);
  expect(rightGap, `right-edge gap (px): ${rightGap}`).toBeGreaterThanOrEqual(0);
  // Symmetry: left and right gaps should be within one cell of each other.
  expect(
    Math.abs(leftGap - rightGap),
    `asymmetry (left ${leftGap} vs right ${rightGap})`,
  ).toBeLessThanOrEqual(12);

  // Final invariant: the number of # characters actually rendered must
  // match (within ±1) what mobux sent to the PTY — i.e. no characters
  // were clipped past the right edge. ±1 tolerance covers the case
  // where the row exactly fills cols and tmux wraps the final cell.
  expect(geom.range.len, `rendered #s (${geom.range.len}) vs sent (${cols})`).toBeGreaterThanOrEqual(cols - 1);

  assertNoFailures(captured);
});

test('row-height parity: PTY rows match what actually fits, including after the input bar appears', async ({ page }) => {
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

  // Snapshot the initial (bar hidden) invariant first, so a baseline
  // failure tells us the host geometry is busted before we even
  // toggle the bar.
  const initial = await page.evaluate(() => {
    const t = document.getElementById('terminal');
    const sterk = window.__sterk?._sterk;
    const cell = sterk?.getCellMetrics?.();
    return {
      hostH: t.clientHeight,
      rows: window.__mobuxView.test.rows(),
      cellH: cell?.height ?? 0,
    };
  });
  expect(initial.cellH, 'initial cell height should be > 0').toBeGreaterThan(0);
  // rows * cellH must be <= hostH (the PTY isn't promised rows that
  // don't fit). One cell of slack on the high side handles non-integer
  // host heights divided by integer cell heights.
  expect(
    initial.rows * initial.cellH,
    `initial: rows(${initial.rows})*cellH(${initial.cellH})=${initial.rows*initial.cellH} > hostH(${initial.hostH})`,
  ).toBeLessThanOrEqual(initial.hostH);

  // Show the input bar — the same mobux code path that fires on a
  // real-device tap. Then re-measure: the new term.rows must still
  // fit in the (now-shrunk) host.
  await page.evaluate(() => {
    const bar = document.getElementById('inputBar');
    bar.classList.remove('hidden');
    window.dispatchEvent(new Event('resize'));
  });
  // Give the resize round-trip a beat to land (mobux sends to PTY,
  // PTY sends fresh redraw back).
  await page.waitForTimeout(500);

  const afterBar = await page.evaluate(() => {
    const t = document.getElementById('terminal');
    const bar = document.getElementById('inputBar');
    const sterk = window.__sterk?._sterk;
    const cell = sterk?.getCellMetrics?.();
    return {
      hostH: t.clientHeight,
      rows: window.__mobuxView.test.rows(),
      cellH: cell?.height ?? 0,
      barH: bar.getBoundingClientRect().height,
      barHidden: bar.classList.contains('hidden'),
    };
  });
  expect(afterBar.barHidden, 'input bar must be visible for this scenario').toBe(false);
  expect(afterBar.barH, 'input bar must occupy vertical space').toBeGreaterThan(10);
  // The host must have shrunk (flex sibling took its bite).
  expect(
    afterBar.hostH,
    `host should be smaller after bar show: was ${initial.hostH}, now ${afterBar.hostH}`,
  ).toBeLessThan(initial.hostH);
  // The key invariant: rows*cellH stays within hostH.
  expect(
    afterBar.rows * afterBar.cellH,
    `after-bar: rows(${afterBar.rows})*cellH(${afterBar.cellH})=${afterBar.rows*afterBar.cellH} > hostH(${afterBar.hostH})`,
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

test('reader view: real PTY output reaches the reader pane', async ({ page }) => {
  const captured = seedErrorCapture(page);
  await bootTerminal(page);
  const marker = `READER_CRIT_${Math.floor(Math.random() * 1e9)}`;
  await page.evaluate((m) => window.__mobuxView.send(`echo ${m}\r`), marker);
  // First confirm it landed in the terminal.
  await expect.poll(() => visibleTerminalText(page), { timeout: 10000 }).toContain(marker);
  // Then switch to reader and assert the same marker is rendered there.
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 4000 });
  const readerText = await page.evaluate(() => document.getElementById('reader').textContent || '');
  expect(readerText).toContain(marker);
  assertNoFailures(captured);
});
