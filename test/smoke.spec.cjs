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

test('scroll works via wheel events', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  // Scroll to bottom
  await page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  });
  await page.waitForTimeout(200);

  const scrollBefore = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  if (scrollBefore === 0) { test.skip(true, 'No scrollback'); return; }

  // Dispatch wheel event on .xterm (same path our gesture layer uses)
  await page.evaluate(() => {
    const xt = document.querySelector('.xterm');
    xt.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -500, deltaMode: 0, bubbles: true, cancelable: true,
    }));
  });
  await page.waitForTimeout(200);

  const scrollAfter = await page.evaluate(() =>
    document.querySelector('.xterm-viewport')?.scrollTop ?? 0
  );
  expect(scrollAfter).toBeLessThan(scrollBefore);
});

test('gesture layer translates touch to wheel', async ({ page }) => {
  const sessions = await (await page.request.get(`${BASE}/api/sessions`)).json();
  await page.goto(`${BASE}/s/${sessions[0].name}`);

  await page.waitForFunction(() => {
    const vp = document.querySelector('.xterm-viewport');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });

  // Verify gesture handler exists and fires wheel events
  const gestureWorks = await page.evaluate(() => {
    const overlay = document.getElementById('touchOverlay');
    if (!overlay) return { error: 'no overlay' };
    overlay.style.pointerEvents = 'auto';

    let wheelFired = false;
    const xt = document.querySelector('.xterm');
    xt.addEventListener('wheel', () => { wheelFired = true; }, { once: true });

    // Simulate touch gesture
    function fire(type, x, y) {
      const t = new Touch({ identifier: 1, target: overlay, clientX: x, clientY: y, pageX: x, pageY: y });
      overlay.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t],
        bubbles: true, cancelable: true,
      }));
    }

    fire('touchstart', 200, 500);
    // Move enough to pass TAP_PX threshold (8px)
    for (let i = 1; i <= 10; i++) fire('touchmove', 200, 500 - i * 20);
    fire('touchend', 200, 300);

    return { wheelFired };
  });

  expect(gestureWorks.wheelFired).toBe(true);
});
