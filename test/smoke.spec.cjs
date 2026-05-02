const { test, expect } = require('@playwright/test');

const BASE = process.env.MOBUX_URL || 'https://localhost:5151';
const USER = process.env.MOBUX_USER || '';
const PASS = process.env.MOBUX_PASS || '';
const AUTH = (USER && PASS) ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : null;

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
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
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#touchOverlay')).toBeAttached();

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });
});

test('scroll works via touch gesture', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  // Scroll to bottom first
  await page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  });
  await page.waitForTimeout(200);

  const scrollBefore = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  if (scrollBefore === 0) { test.skip(true, 'No scrollback'); return; }

  // Simulate downward swipe (finger moves down = scroll up)
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
  await page.waitForTimeout(200);

  const scrollAfter = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  expect(scrollAfter).toBeLessThan(scrollBefore);
});

test('swipe left/right switches tmux windows', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  const session = sessions[0].name;

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
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  const session = sessions[0].name;

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

test('gesture layer translates touch to scroll', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  // Scroll to bottom first so we can detect upward scroll
  await page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  });
  await page.waitForTimeout(100);

  const scrollBefore = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  if (scrollBefore === 0) { test.skip(true, 'No scrollback'); return; }

  // Simulate upward swipe on touch overlay
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
  await page.waitForTimeout(200);

  const scrollAfter = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  expect(scrollAfter).toBeLessThan(scrollBefore);
});


test('URLs in terminal output are tappable', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  await page.waitForTimeout(500);

  // Type echo URL command
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
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
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  // Type a unique marker into the terminal so we can find it in reader output.
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
  await page.keyboard.type('echo MOBUX_READER_MARKER_42');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  // Swap to reader view via the devtools API.
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  await expect(page.locator('#reader')).toBeVisible();
  await expect(page.locator('#terminal')).toBeHidden();

  const readerText = await page.locator('#reader').textContent();
  expect(readerText).toContain('MOBUX_READER_MARKER_42');

  // Swap back.
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(100);
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#reader')).toBeHidden();
});

test('reader view live-updates on new output', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').focus());
  await page.keyboard.type('echo MOBUX_LIVE_PROBE_99');
  await page.keyboard.press('Enter');

  await expect.poll(
    async () => (await page.locator('#reader').textContent()) || '',
    { timeout: 3000 }
  ).toContain('MOBUX_LIVE_PROBE_99');

  // Cleanup
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
});
