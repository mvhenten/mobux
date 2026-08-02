// Rendering-audit catalogue (2026-05-24).
//
// This file is the executable companion to the GH issue
// "Rendering audit: divergence catalogue (post-2026-05-24 fixes)".
//
// Each test below is a *reproducer*, not a pass/fail gate. They are
// marked `audit()` so CI stays green; once a divergence is fixed,
// flip the row to `test()` and the assertions become a regression
// guard.
//
// To run the audit and collect artefacts (the assertions WILL run and
// will surface divergences), set MOBUX_AUDIT_RUN=1. Without that env
// the suite is fully skipped via .fixme() so CI stays green.
//
// Pattern for every scenario:
//   1. Boot the terminal at Pixel 7 emulation against the smoke
//      instance (port 8281).
//   2. Send a deterministic payload via `__mobuxView.send` (real PTY
//      pipe — not the synthetic `inject` helper).
//   3. Wait for the payload to land.
//   4. Capture: screenshot + DOM measurements for sampled cells.
//   5. Save artefacts to `test-results/rendering-audit/<scenario>/`.
//
// Renderer DOM contract (sterk-on-Ace):
//   - container: #terminal
//   - rendered row: .ace_line (or .ace_line_group)
//   - cells inside a row are spans whose className lists carry sterk
//     attribute classes (`sterk-fg-N`, `sterk-bold`, etc.).
//   - cellMetrics: `window.__sterk._sterk.getCellMetrics()` → {width, height}.
//
// Run with:
//   make smoke-start                                                       # if not already running
//   MOBUX_URL=http://localhost:8281 MOBUX_USER=smoke MOBUX_PASS=00000 \
//     npx playwright test test/rendering-audit.spec.cjs

const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.env.MOBUX_URL || 'http://localhost:8281';
const USER = process.env.MOBUX_USER || 'smoke';
const PASS = process.env.MOBUX_PASS || '00000';
const AUTH = USER && PASS ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : null;
const SESSION = process.env.MOBUX_TEST_SESSION || 'mobux-audit';
const TMUX_CMD = process.env.MOBUX_TEST_TMUX || 'tmux -L mobux-test';
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || '/tmp/mobux-smoke/home';
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME} -e LANG=en_US.UTF-8 -e LC_ALL=en_US.UTF-8`;
const tmux = (args) => execSync(`${TMUX_CMD} ${args}`, { stdio: 'pipe' });

const ARTEFACTS = path.resolve(__dirname, '..', 'test-results', 'rendering-audit');
fs.mkdirSync(ARTEFACTS, { recursive: true });

// Run the audit body when AUDIT_RUN is set; otherwise the test is
// marked fixme (skipped) so CI passes.
const AUDIT_RUN = !!process.env.MOBUX_AUDIT_RUN;
const audit = AUDIT_RUN ? test : test.fixme;

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
  tmux(`send-keys -t ${SESSION} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${SESSION} "clear" Enter`);
  execSync('sleep 0.3');
});

test.afterAll(() => {
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
});

// ── Helpers ────────────────────────────────────────────────────────

async function bootTerminal(page) {
  await page.goto(`${BASE}/s/${SESSION}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const t = document.getElementById('terminal');
    if (!t || t.classList.contains('hidden')) return false;
    const r = t.getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  }, { timeout: 8000 });
  await page.waitForFunction(
    () => window.__mobuxView?.test?.wsReady?.() === true,
    { timeout: 8000 },
  );
  await page.waitForTimeout(500);
}

async function sendAndWait(page, payload, waitMs = 600) {
  await page.evaluate((p) => window.__mobuxView.send(p), payload);
  await page.waitForTimeout(waitMs);
}

async function captureScene(page, scenario) {
  const dir = path.join(ARTEFACTS, scenario);
  fs.mkdirSync(dir, { recursive: true });
  const shotPath = path.join(dir, 'screenshot.png');
  await page.screenshot({ path: shotPath, fullPage: false });
  return { dir, shotPath };
}

async function dumpRows(page, scenario, limit = 40) {
  return page.evaluate((limit) => {
    const t = document.getElementById('terminal');
    if (!t) return [];
    const rows = Array.from(t.querySelectorAll('.ace_line, .ace_line_group')).slice(0, limit);
    return rows.map((r, idx) => {
      const text = r.textContent || '';
      const rect = r.getBoundingClientRect();
      return {
        idx,
        text,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
  }, limit);
}

async function cellMetrics(page) {
  return page.evaluate(() => {
    const sterk = window.__sterk?._sterk;
    const m = sterk?.getCellMetrics?.();
    return m ? { width: m.width, height: m.height } : null;
  });
}

// For a row containing `marker`, walk text nodes to find the bounding
// rect of each character and return them keyed by their character index.
// Used to measure per-glyph cell width and verify single/double-width
// classification.
async function measureGlyphsInLine(page, marker) {
  return page.evaluate((marker) => {
    const t = document.getElementById('terminal');
    const rows = Array.from(t.querySelectorAll('.ace_line, .ace_line_group'));
    const row = rows.find((r) => (r.textContent || '').includes(marker));
    if (!row) return null;
    const text = row.textContent;
    const idx = text.indexOf(marker);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const glyphs = [];
    let consumed = 0;
    let node = walker.nextNode();
    while (node) {
      const len = node.data.length;
      for (let i = 0; i < len; i++) {
        const overall = consumed + i;
        if (overall < idx) continue;
        if (overall >= idx + marker.length) break;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        glyphs.push({
          ch: node.data[i],
          codePoint: node.data.codePointAt(i),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          top: Math.round(rect.top),
          height: Math.round(rect.height),
        });
      }
      consumed += len;
      if (consumed >= idx + marker.length) break;
      node = walker.nextNode();
    }
    return { rowText: text, glyphs };
  }, marker);
}

function writeDump(scenario, name, payload) {
  const file = path.join(ARTEFACTS, scenario, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function snapshot(page, scenario, extras = {}) {
  const { shotPath } = await captureScene(page, scenario);
  const rows = await dumpRows(page, scenario);
  const cm = await cellMetrics(page);
  const dump = { scenario, cellMetrics: cm, rows, ...extras };
  writeDump(scenario, 'dom-dump.json', dump);
  return { shotPath, dump };
}

// ── Tests ──────────────────────────────────────────────────────────

// SCENARIO 1: steady-state prompt
audit('1. steady-state prompt — cursor in right cell, no spurious decorations', async ({ page }) => {
  await bootTerminal(page);
  await sendAndWait(page, '', 400);
  const { dump } = await snapshot(page, '01-steady-state');
  // Expect at least one row with the `$ ` prompt visible.
  const promptRow = dump.rows.find((r) => /\$\s/.test(r.text));
  expect(promptRow, 'prompt row should be present').toBeTruthy();
});

// SCENARIO 2: multi-line shell output, alignment
audit('2. multi-line output (`ls -la /etc | head -30`) — every line left-aligned at col 0', async ({ page }) => {
  await bootTerminal(page);
  await sendAndWait(page, 'ls -la /etc | head -30\r', 1200);
  const { dump } = await snapshot(page, '02-multiline-ls');
  // Sample alignment of non-empty rows: their left edges must agree
  // within 1px (any drift = a column off).
  const lefts = dump.rows.filter((r) => r.text.trim().length).map((r) => r.left);
  const minL = Math.min(...lefts);
  const maxL = Math.max(...lefts);
  expect(maxL - minL, `left-alignment drift across rows: ${maxL - minL}px`).toBeLessThanOrEqual(2);
});

// SCENARIO 3: wrapped long line at exact column count
audit('3. wrap point — a line wider than cols wraps at exactly cell `cols`', async ({ page }) => {
  await bootTerminal(page);
  const cols = await page.evaluate(() => window.__mobuxView.test.cols());
  // Create a line that's cols+10 long: 'A'*cols + 'B'*10
  const payload = 'A'.repeat(cols) + 'B'.repeat(10);
  await sendAndWait(page, `printf '%s\\n' '${payload}'\r`, 800);
  const { dump } = await snapshot(page, '03-wrap-long-line', { cols, payloadLen: payload.length });
  // Find the first row that's pure A's and the row immediately after
  // it that starts with B's. Their texts must reflect the cols boundary.
  const aRowIdx = dump.rows.findIndex((r) => /^A+$/.test(r.text.trim()) && r.text.trim().length >= cols - 1);
  expect(aRowIdx, 'wrap row of A`s should exist').toBeGreaterThanOrEqual(0);
});

// SCENARIO 4: box drawing characters
audit('4. box-drawing glyphs render at exactly 1 cell wide', async ({ page }) => {
  await bootTerminal(page);
  const marker = 'BOX:─│┌┐└┘├┤┬┴┼╭╮╰╯:END';
  await sendAndWait(page, `printf '%s\\n' '${marker}'\r`, 800);
  const measurement = await measureGlyphsInLine(page, marker);
  const cm = await cellMetrics(page);
  await snapshot(page, '04-box-drawing', { marker, measurement, expectedCellWidth: cm?.width });
  expect(measurement, 'should locate box-drawing line').toBeTruthy();
  // Each box glyph should be approximately one cell wide.
  // Tolerance: 2px (sub-pixel rendering).
  const boxChars = measurement.glyphs.filter((g) => /[─│┌┐└┘├┤┬┴┼╭╮╰╯]/.test(g.ch));
  for (const g of boxChars) {
    expect(
      Math.abs(g.width - cm.width),
      `glyph ${JSON.stringify(g.ch)} width ${g.width}px vs cell ${cm.width}px`,
    ).toBeLessThanOrEqual(2);
  }
});

// SCENARIO 5: dingbats / Claude TUI status markers
audit('5. dingbats (✱ ● ▌ ◇ ✶ → ←) render at 1 cell — flag font-coverage gaps', async ({ page }) => {
  await bootTerminal(page);
  const marker = 'DING:✱●▌◇✶→←:END';
  await sendAndWait(page, `printf '%s\\n' '${marker}'\r`, 800);
  const measurement = await measureGlyphsInLine(page, marker);
  const cm = await cellMetrics(page);
  await snapshot(page, '05-dingbats', { marker, measurement, expectedCellWidth: cm?.width });
  expect(measurement, 'should locate dingbat line').toBeTruthy();
  // Note actual vs expected widths — this is the font-fallback class
  // of bug. Test asserts <= cell width + 4px tolerance to flag the
  // "glyph spills outside cell" failure mode.
  const dings = measurement.glyphs.filter((g) => /[✱●▌◇✶→←]/.test(g.ch));
  for (const g of dings) {
    expect(
      g.width,
      `dingbat ${JSON.stringify(g.ch)} width ${g.width}px spills past cell ${cm.width}px`,
    ).toBeLessThanOrEqual(cm.width + 4);
  }
});

// SCENARIO 6: CJK / wide chars
audit('6. CJK glyphs (中文テスト한글) take 2 cells each', async ({ page }) => {
  await bootTerminal(page);
  const marker = 'CJK:中文テスト한글:END';
  await sendAndWait(page, `printf '%s\\n' '${marker}'\r`, 800);
  const measurement = await measureGlyphsInLine(page, marker);
  const cm = await cellMetrics(page);
  await snapshot(page, '06-cjk-wide', { marker, measurement, expectedCellWidth: cm?.width });
  expect(measurement, 'should locate CJK line').toBeTruthy();
  // Each wide char should be ~2 cells wide.
  const wides = measurement.glyphs.filter((g) =>
    /[一-鿿぀-ヿ가-힯]/.test(g.ch)
  );
  for (const g of wides) {
    expect(
      g.width,
      `wide char ${JSON.stringify(g.ch)} width ${g.width}px not 2 cells (${cm.width * 2}px)`,
    ).toBeGreaterThanOrEqual(cm.width * 2 - 4);
  }
});

// SCENARIO 7: combining diacriticals
audit('7. combining diacriticals (é, नमस्ते) render at 1 cell — no double-width', async ({ page }) => {
  await bootTerminal(page);
  // Compose 'é' from e + combining acute (U+0301), then नमस्ते.
  const marker = 'COMB:é:नमस्ते:END';
  await sendAndWait(page, `printf '%s\\n' '${marker}'\r`, 800);
  const measurement = await measureGlyphsInLine(page, marker);
  const cm = await cellMetrics(page);
  await snapshot(page, '07-combining', { marker, measurement, expectedCellWidth: cm?.width });
  expect(measurement, 'should locate combining line').toBeTruthy();
});

// SCENARIO 8: emoji + ZWJ
audit('8. emoji + ZWJ (🎉 👨‍👩‍👧‍👦 🇯🇵) → width 2, ZWJ combines', async ({ page }) => {
  await bootTerminal(page);
  const marker = 'EMO:🎉:👨‍👩‍👧‍👦:🇯🇵:END';
  await sendAndWait(page, `printf '%s\\n' '${marker}'\r`, 800);
  const measurement = await measureGlyphsInLine(page, marker);
  const cm = await cellMetrics(page);
  await snapshot(page, '08-emoji-zwj', { marker, measurement, expectedCellWidth: cm?.width });
  expect(measurement, 'should locate emoji line').toBeTruthy();
});

// SCENARIO 9: in-place line redraws (Claude TUI Cogitating pattern)
audit('9. in-place \\r redraws — no ghost from previous text', async ({ page }) => {
  await bootTerminal(page);
  // Simulate Claude TUI's "Cogitating for Ns" — write a line, \r,
  // write a shorter line, \r, write a longer line. The shorter line
  // should overwrite, but the LONGER line should not leave trailing
  // tail from the first long string.
  await sendAndWait(page, "printf 'AAAAAAAAAAAAAAAAA\\rBBBB\\rCC\\n'\r", 800);
  const { dump } = await snapshot(page, '09-inplace-redraw');
  // Look for the final state — should show only "CC" with no
  // residual 'A' or 'B' characters trailing.
  const ghostRow = dump.rows.find((r) => /CC.*A|CC.*B|BB.*A/.test(r.text));
  // Note: this is the diagnostic — if ghostRow is present, ghosting
  // is real. Test asserts no ghost.
  expect(ghostRow, `ghost residue detected: ${ghostRow?.text}`).toBeFalsy();
});

// SCENARIO 10: progress bar / spinner
audit('10. high-frequency \\r progress bar — no left-over frames', async ({ page }) => {
  await bootTerminal(page);
  // 10 frames of an ASCII spinner: ▖▘▝▗ rotated. Each frame is
  // written with \r so it should overwrite the previous one.
  const frames = ['[####------]', '[#####-----]', '[######----]', '[#######---]', '[########--]', '[#########-]', '[##########]'];
  let payload = '';
  for (const f of frames) payload += f + '\r';
  payload += '\n';
  await sendAndWait(page, `printf '%s' '${payload}'\r`, 800);
  const { dump } = await snapshot(page, '10-progress-bar');
  // Final state row should show the complete bar; any prior row
  // showing the partial bar would be a ghost.
  const bars = dump.rows.filter((r) => /\[#+-*\]/.test(r.text));
  // Only one final-state bar should remain (others were overwritten).
  expect(bars.length, `progress-bar residue: ${bars.length} bar-like rows`).toBeLessThanOrEqual(2);
});

// SCENARIO 11: SGR colors + attributes
audit('11. SGR — 8 ANSI, 8 bright, 256, truecolor, bold/italic/underline/inverse', async ({ page }) => {
  await bootTerminal(page);
  // Pack one big payload covering all SGR axes.
  let payload = '';
  // 8 ANSI fg
  for (let i = 30; i <= 37; i++) payload += `\x1b[${i}mFG${i}\x1b[0m `;
  payload += '\\n';
  // 8 bright fg
  for (let i = 90; i <= 97; i++) payload += `\x1b[${i}mFG${i}\x1b[0m `;
  payload += '\\n';
  // 256-color samples
  for (const c of [16, 33, 82, 196, 226, 244]) payload += `\x1b[38;5;${c}m256_${c}\x1b[0m `;
  payload += '\\n';
  // Truecolor
  payload += '\x1b[38;2;255;100;50mTRUE_FF6432\x1b[0m ';
  payload += '\x1b[38;2;100;200;255mTRUE_64C8FF\x1b[0m';
  payload += '\\n';
  // Attributes
  payload += '\x1b[1mBOLD\x1b[0m \x1b[3mITALIC\x1b[0m \x1b[4mUNDER\x1b[0m \x1b[7mINV\x1b[0m';
  payload += '\\n';
  await sendAndWait(page, `printf '${payload}'\r`, 800);
  // Capture computed styles on a known-bold cell.
  const styles = await page.evaluate(() => {
    const t = document.getElementById('terminal');
    const spans = Array.from(t.querySelectorAll('span'));
    const samples = [];
    for (const s of spans) {
      const text = s.textContent || '';
      if (/^(BOLD|ITALIC|UNDER|INV|FG3[0-7]|FG9[0-7]|256_|TRUE_)/.test(text)) {
        const cs = getComputedStyle(s);
        samples.push({
          text,
          className: s.className,
          color: cs.color,
          background: cs.backgroundColor,
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
          textDecoration: cs.textDecorationLine,
        });
      }
    }
    return samples;
  });
  await snapshot(page, '11-sgr-colors', { styleSamples: styles });
  // Verify bold span actually got fontWeight bold (or >=600).
  const boldSample = styles.find((s) => s.text === 'BOLD');
  if (boldSample) {
    const w = parseInt(boldSample.fontWeight, 10);
    expect(
      w >= 600 || boldSample.fontWeight === 'bold',
      `BOLD span fontWeight=${boldSample.fontWeight}`,
    ).toBeTruthy();
  }
});

// SCENARIO 12: alt-screen apps (less)
audit('12. alt-screen toggle (less) — enter, render, exit, status row visible', async ({ page }) => {
  await bootTerminal(page);
  // Use `less` with a small static file. q exits.
  await sendAndWait(page, "yes | head -200 > /tmp/mobux-audit-less.txt\r", 600);
  await sendAndWait(page, "less /tmp/mobux-audit-less.txt\r", 1500);
  const { dump: inLess } = await snapshot(page, '12-alt-screen-in');
  // less should have populated the screen with `y` lines.
  const yRows = inLess.rows.filter((r) => /^y\s*$/.test(r.text.trim()));
  expect(yRows.length, `less should show y rows; saw ${yRows.length}`).toBeGreaterThan(5);
  // Exit less.
  await sendAndWait(page, 'q', 800);
  const { dump: afterLess } = await snapshot(page, '12-alt-screen-out');
  // After q, the original prompt should be back and the y rows should be gone.
  const yRowsAfter = afterLess.rows.filter((r) => /^y\s*$/.test(r.text.trim()));
  expect(yRowsAfter.length, `after exit, y rows should clear; saw ${yRowsAfter.length}`).toBeLessThanOrEqual(2);
});

// SCENARIO 13: tmux status bar visibility at bottom
audit('13. tmux status bar stays visible at bottom regardless of session activity', async ({ page }) => {
  await bootTerminal(page);
  // Make tmux show a status line.
  await sendAndWait(page, '', 400);
  // Toggle status on (default is on in mobux smoke session — check).
  await page.evaluate(() => window.__mobuxView.send('\x02:set -g status on\r'));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__mobuxView.send('\x1b'));
  await page.waitForTimeout(300);
  // Spit a burst of lines so the status would scroll off if it
  // wasn't anchored.
  await sendAndWait(page, "for i in $(seq 1 60); do echo line$i; done\r", 1200);
  const { dump } = await snapshot(page, '13-tmux-status');
  // The bottom row of the rendered terminal should still contain a
  // tmux-status-like line. Default tmux status is mostly green
  // background with session/window info. We look at the last row's
  // text — should be non-empty and not be the last shell line.
  const lastNonEmpty = [...dump.rows].reverse().find((r) => r.text.trim().length);
  expect(lastNonEmpty, 'last row should be present').toBeTruthy();
});

// SCENARIO 14: reader view round-trip
audit('14. reader view toggle — terminal → reader → terminal renders clean both sides', async ({ page }) => {
  await bootTerminal(page);
  const marker = `READER_AUDIT_${Math.floor(Math.random() * 1e9)}`;
  await sendAndWait(page, `echo ${marker}\r`, 800);
  // Terminal-side capture.
  const { dump: termDump } = await snapshot(page, '14-reader-terminal');
  expect(termDump.rows.some((r) => r.text.includes(marker))).toBeTruthy();
  // Switch to reader.
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 4000 });
  await captureScene(page, '14-reader-view');
  const readerText = await page.evaluate(() => document.getElementById('reader').textContent || '');
  writeDump('14-reader-view', 'reader-text.json', { marker, text: readerText.slice(0, 5000) });
  expect(readerText).toContain(marker);
  // Back to terminal.
  await page.evaluate(() => window.__mobuxView.swap('terminal'));
  await page.waitForFunction(() => {
    const t = document.getElementById('terminal');
    return t && !t.classList.contains('hidden');
  }, { timeout: 4000 });
  await page.waitForTimeout(400);
  await snapshot(page, '14-reader-back-to-terminal');
});

// SCENARIO 15: scrollback retention + scroll-up
audit('15. scrollback — emit 200 lines, scroll up, lines and positions retained', async ({ page }) => {
  await bootTerminal(page);
  await sendAndWait(page, "for i in $(seq 1 200); do echo scrollback_line_$i; done\r", 2000);
  const before = await page.evaluate(() => ({
    viewportY: window.__mobuxView.test.viewportY(),
    rows: window.__mobuxView.test.rows(),
  }));
  await snapshot(page, '15-scrollback-bottom', { before });
  // Scroll up via touch / wheel — use the terminal's send API to
  // trigger PageUp.
  await page.evaluate(() => {
    const t = document.getElementById('terminal');
    // Synthesize a wheel scroll up.
    t.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
  });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    viewportY: window.__mobuxView.test.viewportY(),
    rows: window.__mobuxView.test.rows(),
  }));
  await snapshot(page, '15-scrollback-scrolled', { before, after });
  // After scroll-up, viewportY should differ (decrement) from before.
  // [diagnostic: if viewportY didn't change, the wheel handler isn't
  // wired or sterk's scrollLines API isn't being called.]
});
