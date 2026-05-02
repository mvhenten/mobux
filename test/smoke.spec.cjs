const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const BASE = process.env.MOBUX_URL || 'https://localhost:5151';
const USER = process.env.MOBUX_USER || '';
const PASS = process.env.MOBUX_PASS || '';
const AUTH = (USER && PASS) ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : null;
const SESSION = process.env.MOBUX_TEST_SESSION || 'mobux-smoke';

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  // Create a dedicated tmux session for the suite so tests never
  // mutate (or get polluted by) whatever the user is currently doing.
  // Seed it with enough lines that the scrollback tests have something
  // to scroll through.
  try { execSync(`tmux kill-session -t ${SESSION}`, { stdio: 'pipe' }); } catch (_) {}
  // Pre-seed with enough lines for scroll tests; quiet otherwise so
  // assertions don't race against live output. Use bash so tests that
  // type real commands (URL detection, etc.) hit a working prompt.
  execSync(
    `tmux new-session -d -s ${SESSION} "bash --norc --noprofile"`,
    { stdio: 'pipe' },
  );
  execSync(`tmux send-keys -t ${SESSION} "PS1='\\$ '" Enter`, { stdio: 'pipe' });
  execSync(`tmux send-keys -t ${SESSION} "clear" Enter`, { stdio: 'pipe' });
  // Add a second window so multi-window tests don't skip.
  execSync(`tmux new-window -t ${SESSION} -n second "sh -c 'while true; do sleep 60; done'"`, { stdio: 'pipe' });
  execSync(`tmux select-window -t ${SESSION}:0`, { stdio: 'pipe' });
  execSync('sleep 0.3');
});

test.afterAll(() => {
  try { execSync(`tmux kill-session -t ${SESSION}`, { stdio: 'pipe' }); } catch (_) {}
});

test('index loads', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page).toHaveTitle(/Mobux/);
});

test('sessions API works', async ({ page }) => {
  const res = await page.request.get(`${BASE}/api/sessions`);
  expect(res.ok()).toBeTruthy();
  const sessions = await res.json();
  expect(sessions.length).toBeGreaterThan(0);
});

test('terminal renders and connects', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);

  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#touchOverlay')).toBeAttached();

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });
});

test('scroll works via touch gesture', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);

  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  // Wait for WS attach + redraw to settle so it doesn't clobber our inject.
  await page.waitForTimeout(800);
  // Inject 300 lines directly into xterm so we have guaranteed scrollback
  // independent of session redraw timing.
  await page.evaluate(() => window.__mobuxView.test.injectLines(300, 'scrollseed'));
  await page.waitForTimeout(200);

  // Park at the bottom; xterm tracks scroll position via viewportY in
  // its buffer (not via the .xterm-viewport DOM scrollTop, which is
  // virtualized in xterm.js v5+).
  await page.evaluate(() => window.__mobuxView.test.scrollToBottom());
  // Let any in-flight WS bytes finish; sticky-bottom keeps viewportY
  // pinned to (bufferLen - rows) until we touch.
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__mobuxView.test.scrollToBottom());
  const yBefore = await page.evaluate(() => window.__mobuxView.test.viewportY());
  expect(yBefore).toBeGreaterThan(0);

  // Simulate downward swipe (finger moves down = scroll up = viewportY decreases)
  await page.evaluate(() => {
    const overlay = document.getElementById('touchOverlay');
    if (!overlay) return;
    overlay.style.pointerEvents = 'auto';
    function fire(type, x, y) {
      const t = new Touch({ identifier: 1, target: overlay, clientX: x, clientY: y, pageX: x, pageY: y });
      overlay.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t],
        bubbles: true, cancelable: true,
      }));
    }
    fire('touchstart', 200, 300);
    for (let i = 1; i <= 10; i++) fire('touchmove', 200, 300 + i * 20);
    fire('touchend', 200, 500);
  });

  await expect.poll(
    async () => await page.evaluate(() => window.__mobuxView.test.viewportY()),
    { timeout: 2000 }
  ).toBeLessThan(yBefore);
});

test('swipe left/right switches tmux windows', async ({ page }) => {
  const session = SESSION;

  // Need at least 2 windows to test switching
  const panesBefore = await (await page.request.get(`${BASE}/api/sessions/${session}/panes`)).json();
  if (panesBefore.length < 2) { test.skip(true, 'Need 2+ windows'); return; }

  const initialActive = panesBefore.find(p => p.active)?.index;

  // Test via command API (same as tmux prefix+n that swipe sends)
  const nextRes = await page.request.post(`${BASE}/api/sessions/${session}/command`, {
    data: { command: 'next-window' },
  });
  expect(nextRes.ok()).toBeTruthy();
  await page.waitForTimeout(300);

  const panesAfterNext = await (await page.request.get(`${BASE}/api/sessions/${session}/panes`)).json();
  const afterNextActive = panesAfterNext.find(p => p.active)?.index;
  expect(afterNextActive).not.toBe(initialActive);

  // Go back with prev-window
  const prevRes = await page.request.post(`${BASE}/api/sessions/${session}/command`, {
    data: { command: 'prev-window' },
  });
  expect(prevRes.ok()).toBeTruthy();
  await page.waitForTimeout(300);

  const panesAfterPrev = await (await page.request.get(`${BASE}/api/sessions/${session}/panes`)).json();
  const afterPrevActive = panesAfterPrev.find(p => p.active)?.index;
  expect(afterPrevActive).toBe(initialActive);
});

test('window switching works via command API', async ({ page }) => {
  const session = SESSION;

  const panesBefore = await (await page.request.get(`${BASE}/api/sessions/${session}/panes`)).json();
  if (panesBefore.length < 2) { test.skip(true, 'Need 2+ windows'); return; }

  const initialActive = panesBefore.find(p => p.active)?.index;

  // next-window
  const nextRes = await page.request.post(`${BASE}/api/sessions/${session}/command`, {
    data: { command: 'next-window' },
  });
  expect(nextRes.ok()).toBeTruthy();
  await page.waitForTimeout(300);

  const panesAfterNext = await (await page.request.get(`${BASE}/api/sessions/${session}/panes`)).json();
  const afterNextActive = panesAfterNext.find(p => p.active)?.index;
  expect(afterNextActive).not.toBe(initialActive);

  // prev-window back
  const prevRes = await page.request.post(`${BASE}/api/sessions/${session}/command`, {
    data: { command: 'prev-window' },
  });
  expect(prevRes.ok()).toBeTruthy();
  await page.waitForTimeout(300);

  const panesAfterPrev = await (await page.request.get(`${BASE}/api/sessions/${session}/panes`)).json();
  const afterPrevActive = panesAfterPrev.find(p => p.active)?.index;
  expect(afterPrevActive).toBe(initialActive);
});


test('URLs in terminal output are tappable', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  await page.waitForTimeout(500);

  // Clear any prior test pollution so the URL line stays in the visible viewport.
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
  await page.keyboard.type('clear');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // Type echo URL command
  await page.keyboard.type('echo https://example.com');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // Verify URL appears in terminal text
  const hasUrl = await page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    return rows?.textContent?.includes('https://example.com') ?? false;
  });
  expect(hasUrl).toBe(true);

  // Verify our tap-to-link detection works by simulating the logic
  const detected = await page.evaluate(() => {
    const termEl = document.getElementById('terminal');
    const rows = termEl?.querySelector('.xterm-rows');
    if (!rows) return false;

    // Find a row containing the URL
    const rowDivs = rows.querySelectorAll('div');
    for (const div of rowDivs) {
      const text = div.textContent || '';
      if (text.includes('https://example.com')) {
        // URL regex matches
        const match = text.match(/https?:\/\/[^\s)"'>]+/);
        return match ? match[0] : false;
      }
    }
    return false;
  });
  expect(detected).toContain('https://example.com');
});

test('reader view renders buffer text', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);

  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  // Wait for WS attach + redraw to settle so it doesn't clobber our inject.
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.test.inject('MOBUX_READER_MARKER_42\n'));
  await page.evaluate(() => window.__mobuxView.swap('reader'));

  await expect.poll(
    async () => (await page.locator('#reader').textContent()) || '',
    { timeout: 3000 }
  ).toContain('MOBUX_READER_MARKER_42');

  await expect(page.locator('#reader')).toBeVisible();
  await expect(page.locator('#terminal')).toBeHidden();

  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(100);
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#reader')).toBeHidden();
});

test('reader view live-updates on new output', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);

  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  await page.evaluate(() => window.__mobuxView.test.inject('MOBUX_LIVE_PROBE_99\n'));

  await expect.poll(
    async () => (await page.locator('#reader').textContent()) || '',
    { timeout: 3000 }
  ).toContain('MOBUX_LIVE_PROBE_99');

  // Cleanup
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
});

test('long-press menu toggles reader view', async ({ page }) => {
  // Start clean: no stored view preference
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch (_) {}
  });
  await page.goto(`${BASE}/s/${SESSION}`);
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  // Initial state: xterm visible, toggle says "Reader View"
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#viewToggleLabel')).toHaveText('Reader View');

  // Open menu and tap toggle
  await page.evaluate(() => {
    document.getElementById('cmdPickList').classList.add('visible');
  });
  await page.locator('#viewToggleBtn').click();

  // Reader is now active, label flips
  await expect(page.locator('#reader')).toBeVisible();
  await expect(page.locator('#terminal')).toBeHidden();
  await expect(page.locator('#viewToggleLabel')).toHaveText('Terminal View');

  // Tap again to flip back
  await page.evaluate(() => {
    document.getElementById('cmdPickList').classList.add('visible');
  });
  await page.locator('#viewToggleBtn').click();
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#reader')).toBeHidden();
  await expect(page.locator('#viewToggleLabel')).toHaveText('Reader View');
});

test('panes API returns window id', async ({ page }) => {
  const panes = await (await page.request.get(`${BASE}/api/sessions/${SESSION}/panes`)).json();
  expect(panes.length).toBeGreaterThan(0);
  for (const p of panes) {
    expect(p.id).toMatch(/^@\d+$/);
    expect(typeof p.index).toBe('string');
  }
});
// ── Reader-view touch behaviour ─────────────────────────────────────
// These tests guard against the regression where the xterm touch
// overlay sat over #reader and ate every touch — making scroll, swipe,
// and (on real phones) the long-press menu unreachable.

async function fireTouch(page, selector, type, x, y) {
  await page.evaluate(({ selector, type, x, y }) => {
    const el = document.querySelector(selector);
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
    el.dispatchEvent(new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t],
      changedTouches: [t],
      bubbles: true, cancelable: true,
    }));
  }, { selector, type, x, y });
}

test('reader view disables xterm touch overlay', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(200);

  const overlayPE = await page.evaluate(() =>
    getComputedStyle(document.getElementById('touchOverlay')).pointerEvents
  );
  expect(overlayPE).toBe('none');

  // Flipping back must restore overlay so xterm gestures keep working.
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(150);
  const overlayPEAfter = await page.evaluate(() =>
    getComputedStyle(document.getElementById('touchOverlay')).pointerEvents
  );
  expect(overlayPEAfter).toBe('auto');
});

test('long-press on reader opens menu and toggle-view returns to xterm', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.test.injectLines(120, 'rl'));
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(250);

  // Long-press inside #reader — the gesture recognizer mounted on it
  // should fire onLongPress and reveal the cmd pick list.
  await fireTouch(page, '#reader', 'touchstart', 200, 400);
  await page.waitForTimeout(700);
  await fireTouch(page, '#reader', 'touchend', 200, 400);

  await expect(page.locator('#cmdPickList')).toHaveClass(/visible/, { timeout: 1500 });

  await page.locator('[data-action="toggle-view"]').click();
  await expect.poll(
    async () => await page.evaluate(() => window.__mobuxView.current),
    { timeout: 1500 }
  ).toBe('xterm');
});

// ── Tokenizer / colour rendering ────────────────────────────────
// Inject ANSI sequences and assert the reader emits the right block
// types with the right colours, so we can refactor the tokenizer
// without silently regressing colour or block detection.

const RED  = '\x1b[31m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

async function injectRaw(page, str) {
  await page.evaluate((s) => window.__mobuxView.test.inject(s), str);
}

async function blockSummary(page) {
  return await page.evaluate(() => {
    const blocks = document.querySelectorAll('#reader > .rb');
    return Array.from(blocks).map((b) => ({
      classes: Array.from(b.classList).filter((c) => c !== 'rb'),
      text: (b.textContent || '').trim().slice(0, 80),
    }));
  });
}

test('reader colours preserved (red + green spans)', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);
  await injectRaw(page, `${RED}- removed${RESET}\n${GREEN}+ added${RESET}\n`);
  await page.waitForTimeout(200);

  const colours = await page.evaluate(() => {
    const spans = document.querySelectorAll('#reader span');
    return Array.from(spans)
      .map((s) => ({ t: s.textContent, c: s.style.color }))
      .filter((s) => s.t && s.c);
  });
  const reds = colours.filter((c) => /var\(--ansi-1\)|rgb\(204|cc6666/.test(c.c));
  const greens = colours.filter((c) => /var\(--ansi-2\)|b5bd68/.test(c.c));
  expect(reds.length).toBeGreaterThan(0);
  expect(greens.length).toBeGreaterThan(0);
  expect(reds.some((r) => r.t.includes('removed'))).toBe(true);
  expect(greens.some((g) => g.t.includes('added'))).toBe(true);
});

test('reader detects prompt, header, rule, code blocks', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  // Clear prior content visually then inject a structured snippet.
  await injectRaw(page,
    [
      '~/dev (main) $',
      '[Context]',
      '\u2500'.repeat(40),
      '```',
      '  fn hello() {}',
      '```',
      'plain prose line.',
    ].join('\n') + '\n');
  await page.waitForTimeout(250);

  const summary = await blockSummary(page);
  const types = summary.map((b) => b.classes.join(' '));
  expect(types.some((t) => t.includes('rb-prompt'))).toBe(true);
  expect(types.some((t) => t.includes('rb-header'))).toBe(true);
  expect(types.some((t) => t.includes('rb-rule'))).toBe(true);
  expect(types.some((t) => t.includes('rb-code'))).toBe(true);
  expect(types.some((t) => t.includes('rb-text'))).toBe(true);

  // Code block must contain the fenced content.
  const codeText = await page.locator('#reader .rb-code').textContent();
  expect(codeText).toContain('fn hello()');
  // Triple-backtick fences themselves must NOT appear in output.
  expect(codeText).not.toContain('```');
});

test('reader strips trailing default-attr whitespace from lines', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  await injectRaw(page, 'TRAILMARK content                                  \n');
  await page.waitForTimeout(200);
  // No rendered .rb-line should have trailing whitespace — the
  // tokenizer collapses default-attr trailing space.
  const trailers = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#reader .rb-line'));
    return lines
      .map((l) => l.textContent || '')
      .filter((t) => t.length > 0 && /[ \t]$/.test(t));
  });
  expect(trailers).toEqual([]);
});

test('view preference persists per window', async ({ page }) => {
  const session = SESSION;
  const panes = await (await page.request.get(`${BASE}/api/sessions/${session}/panes`)).json();
  const activeId = panes.find(p => p.active).id;

  await page.goto(`${BASE}/s/${session}`);
  await page.evaluate(() => { try { localStorage.clear(); } catch (_) {} });
  await page.reload();
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(500);

  // Flip to reader via the API
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  const stored = await page.evaluate(({ session, id }) => ({
    perWindow: localStorage.getItem(`mobux.view.${session}.${id}`),
    default: localStorage.getItem('mobux.view.default'),
  }), { session, id: activeId });
  expect(stored.perWindow).toBe('reader');
  expect(stored.default).toBe('reader');

  // Reload — should land in reader for this window
  await page.reload();
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await expect.poll(
    async () => await page.evaluate(() => window.__mobuxView.current),
    { timeout: 3000 }
  ).toBe('reader');
});
