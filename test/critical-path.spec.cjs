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

const { test, expect } = require('@playwright/test');
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
}

async function visibleTerminalText(page) {
  return page.evaluate(() => {
    const t = document.getElementById('terminal');
    return (t?.textContent || '').replace(/\s+/g, ' ').trim();
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
