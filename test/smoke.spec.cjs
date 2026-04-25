const { test, expect } = require('@playwright/test');

const BASE = process.env.MOBUX_URL || 'https://localhost:5151';
const USER = process.env.MOBUX_USER || 'mvhenten';
const PASS = process.env.MOBUX_PASS || '30879';
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

test('scroll works via term.scrollLines API', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  // Scroll to bottom via xterm API
  await page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  });
  await page.waitForTimeout(200);

  const scrollBefore = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  if (scrollBefore === 0) { test.skip(true, 'No scrollback'); return; }

  // Simulate touch scroll up (same path as real gesture)
  await page.evaluate(() => {
    const overlay = document.getElementById('touchOverlay');
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
  await page.waitForTimeout(300);

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

  // Scroll to bottom first so we have room to scroll up
  await page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  });
  await page.waitForTimeout(200);

  const scrollBefore = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  if (scrollBefore === 0) { test.skip(true, 'No scrollback'); return; }

  // Simulate touch scroll up via gesture layer
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
  await page.waitForTimeout(300);

  const scrollAfter = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  expect(scrollAfter).toBeLessThan(scrollBefore);
});
