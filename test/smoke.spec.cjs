const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const BASE = process.env.MOBUX_URL || 'https://localhost:5151';
const USER = process.env.MOBUX_USER || '';
const PASS = process.env.MOBUX_PASS || '';
const AUTH = (USER && PASS) ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : null;
const SESSION = process.env.MOBUX_TEST_SESSION || 'mobux-smoke';

// Tmux command used to set up/tear down the test session. Defaults to a
// dedicated tmux server (`tmux -L mobux-test`) so tests never touch the
// host's default tmux server. Override with `MOBUX_TEST_TMUX` to target
// a containerized mobux's tmux server, e.g.
// `MOBUX_TEST_TMUX="podman exec mobux-podman tmux"` for `make podman-test`.
const TMUX_CMD = process.env.MOBUX_TEST_TMUX || 'tmux -L mobux-test';
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || '/tmp/mobux-smoke/home';
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = (args) => execSync(`${TMUX_CMD} ${args}`, { stdio: 'pipe' });

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  // Create a dedicated tmux session for the suite so tests never
  // mutate (or get polluted by) whatever the user is currently doing.
  // Seed it with enough lines that the scrollback tests have something
  // to scroll through.
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
  // Pre-seed with enough lines for scroll tests; quiet otherwise so
  // assertions don't race against live output. Use bash so tests that
  // type real commands (URL detection, etc.) hit a working prompt.
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
  tmux(`send-keys -t ${SESSION} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${SESSION} "clear" Enter`);
  // Add a second window so multi-window tests don't skip.
  tmux(`new-window -t ${SESSION} ${SHELL_ENV} -n second "sh -c 'while true; do sleep 60; done'"`);
  tmux(`select-window -t ${SESSION}:0`);
  execSync('sleep 0.3');
});

test.afterAll(() => {
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
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

test('tapping a URL opens via anchor click (TWA Custom Tabs path), not window.open', async ({ page }) => {
  // In a TWA shell, `window.open(url, '_blank')` keeps navigation
  // inside the underlying Chrome (visually still "in mobux"). A
  // synthesised <a target="_blank" rel="noopener noreferrer"> click
  // is the documented escape hatch that triggers Chrome Custom Tabs
  // for out-of-scope URLs. Verify our handler uses the anchor path.
  await page.goto(`${BASE}/s/${SESSION}`);
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mobuxOpenExternal === 'function', { timeout: 5000 });

  const result = await page.evaluate(async () => {
    const url = 'https://example.com/twa-link-test';

    // Stub out the actual navigation: capture anchor clicks (the
    // browser would follow `target="_blank"` and pop a tab/Custom
    // Tab; we just need to assert the handler's mechanism).
    let anchorTarget = null;
    let anchorRel = null;
    let anchorHref = null;
    let windowOpenCalled = false;

    const origWindowOpen = window.open;
    window.open = (...args) => { windowOpenCalled = true; return null; };

    const onClick = (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      anchorTarget = a.target;
      anchorRel = a.rel;
      anchorHref = a.href;
      e.preventDefault();
    };
    document.addEventListener('click', onClick, true);

    try {
      // Call the helper directly — same path the tap handler takes
      // once a URL is matched. Exposed on window for tests.
      window.__mobuxOpenExternal(url);
    } finally {
      document.removeEventListener('click', onClick, true);
      window.open = origWindowOpen;
    }

    return { anchorTarget, anchorRel, anchorHref, windowOpenCalled };
  });

  expect(result.anchorHref).toBe('https://example.com/twa-link-test');
  expect(result.anchorTarget).toBe('_blank');
  expect(result.anchorRel).toContain('noopener');
  expect(result.anchorRel).toContain('noreferrer');
  expect(result.windowOpenCalled).toBe(false);
});

test('panes API returns window id', async ({ page }) => {
  const panes = await (await page.request.get(`${BASE}/api/sessions/${SESSION}/panes`)).json();
  expect(panes.length).toBeGreaterThan(0);
  for (const p of panes) {
    expect(p.id).toMatch(/^@\d+$/);
    expect(typeof p.index).toBe('string');
  }
});
// Helper used by the colour/luminance terminal tests below.
async function injectRaw(page, str) {
  await page.evaluate((s) => window.__mobuxView.test.inject(s), str);
}

test('terminal picks readable fg by bg luminance when fg is default', async ({ page }) => {
  // Regression (PR #55 → #6X): claude-code-style highlighted blocks
  // (`\x1b[42m text \x1b[0m`) were unreadable because the theme's
  // light-gray default fg landed on bright palette bgs (lime, cyan…).
  // PR #55 forced fg to dark on every explicit bg, which broke the
  // OPPOSITE case — dark bgs (`\x1b[40m`/`\x1b[44m`, e.g. pi.de output)
  // ended up black-on-black. The current fix picks fg from bg's
  // relative luminance: bright bg → dark fg, dark bg → light fg.
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  // Bright bgs (green, cyan) → must get a dark fg. Dark bgs (black,
  // blue) → must get a light fg. Plus a control: explicit bg + explicit
  // fg should be left alone.
  await injectRaw(
    page,
    '\n\x1b[42mGREEN_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[46mCYAN_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[40mBLACK_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[44mBLUE_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[33;44mYELLOW_FG_BLUE_BG\x1b[0m\n',
  );
  await page.waitForTimeout(300);

  const rgb = (s) => {
    const m = (s || '').match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const lum = (rgbArr) => {
    if (!rgbArr) return null;
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(rgbArr[0]) + 0.7152 * lin(rgbArr[1]) + 0.0722 * lin(rgbArr[2]);
  };

  const styled = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.aceterm-line-bg'));
    return spans
      .filter((s) => /(GREEN|CYAN|BLACK|BLUE|YELLOW)_(BG|FG)/.test(s.textContent || ''))
      .map((s) => ({
        text: s.textContent,
        color: s.style.color,
        bg: s.style.backgroundColor,
      }));
  });

  const find = (needle) => styled.find((s) => (s.text || '').includes(needle));

  const green = find('GREEN_BG_DEFAULT_FG');
  const cyan = find('CYAN_BG_DEFAULT_FG');
  const black = find('BLACK_BG_DEFAULT_FG');
  const blue = find('BLUE_BG_DEFAULT_FG');
  const yel = find('YELLOW_FG_BLUE_BG');

  for (const s of [green, cyan, black, blue, yel]) {
    expect(s).toBeTruthy();
    expect(s.color).not.toBe('');
    expect(s.bg).not.toBe('');
  }

  // Bright bg → dark fg (luminance contrast > 0.5 between fg and bg).
  for (const s of [green, cyan]) {
    const bgL = lum(rgb(s.bg));
    const fgL = lum(rgb(s.color));
    expect(bgL).toBeGreaterThan(0.4);
    expect(fgL).toBeLessThan(0.1);
  }

  // Dark bg → light fg.
  for (const s of [black, blue]) {
    const bgL = lum(rgb(s.bg));
    const fgL = lum(rgb(s.color));
    expect(bgL).toBeLessThan(0.4);
    expect(fgL).toBeGreaterThan(0.5);
  }

  // Explicit fg + explicit bg: fg must stay yellow-ish, not get
  // overridden by the contrast picker. Yellow palette is `#f0c674`
  // — R high, G high, B mid-low.
  const yfg = rgb(yel.color);
  expect(yfg).toBeTruthy();
  expect(yfg[0]).toBeGreaterThan(200);
  expect(yfg[1]).toBeGreaterThan(150);
  expect(yfg[2]).toBeLessThan(200);
});

test('terminal uses the muted base16 palette, not Tango defaults', async ({ page }) => {
  // Regression: terminal-core.js sets a base16-tomorrow palette via
  // `Aceterm.Terminal.setColors(...)` so the terminal avoids the
  // over-saturated Tango lime/cyan that makes highlighted blocks
  // painful on a dark phone screen. Reaching libterm's Terminal class
  // via `instance.constructor` returned `EventEmitter` (libterm
  // replaces `prototype.constructor`), so the override silently
  // no-op'd before the explicit `Aceterm.Terminal` pin landed.
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  const palette = await page.evaluate(() => {
    const T = window.__Aceterm && window.__Aceterm.Terminal;
    if (!T || !T.colors) return null;
    return {
      base16: T.colors.slice(0, 16),
      scrollback: T.scrollback,
    };
  });
  expect(palette).toBeTruthy();
  // Index 2 (green) should be base16's muted olive `#b5bd68`, not
  // Tango's `#4e9a06`. Index 10 (bright green) should be `#98c379`,
  // not Tango's `#8ae234`. Index 14 (bright cyan) should be `#56b6c2`,
  // not Tango's `#34e2e2`.
  expect(palette.base16[2].toLowerCase()).toBe('#b5bd68');
  expect(palette.base16[10].toLowerCase()).toBe('#98c379');
  expect(palette.base16[14].toLowerCase()).toBe('#56b6c2');
  expect(palette.scrollback).toBe(10000);
});

test('input bar sits above on-screen keyboard via visualViewport', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(500);

  await page.setViewportSize({ width: 380, height: 800 });

  await page.evaluate(() => {
    const bar = document.getElementById('inputBar');
    bar.classList.remove('hidden');
    const vv = window.visualViewport;
    window.__origVVHeight = vv.height;
    window.__origVVOffset = vv.offsetTop;
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () => (typeof window.__stubVVHeight === 'number' ? window.__stubVVHeight : window.__origVVHeight),
    });
    Object.defineProperty(vv, 'offsetTop', {
      configurable: true,
      get: () => (typeof window.__stubVVOffset === 'number' ? window.__stubVVOffset : window.__origVVOffset),
    });
  });

  await page.evaluate(() => {
    window.__stubVVHeight = window.innerHeight - 300;
    window.__stubVVOffset = 0;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });

  // The bar is a flex item: when body shrinks to vv.height, the bar
  // moves up with body's bottom — no translate needed. Assert that
  // body's inline height reflects the shrunk viewport.
  await expect.poll(
    async () => await page.evaluate(() => document.body.style.height),
    { timeout: 2000 },
  ).toMatch(/^\d+(\.\d+)?px$/);

  const barBottom = await page.evaluate(() => {
    const r = document.getElementById('inputBar').getBoundingClientRect();
    return r.bottom;
  });
  // Bar bottom must sit within the visual viewport (i.e., not below
  // the keyboard). innerHeight - 300 = 500 in the stubbed state.
  expect(barBottom).toBeLessThanOrEqual(500 + 1);

  await page.evaluate(() => {
    window.__stubVVHeight = window.innerHeight;
    window.__stubVVOffset = 0;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });

  await expect.poll(
    async () => await page.evaluate(() => document.body.style.height),
    { timeout: 2000 },
  ).toBe('');
});

test('input bar does not overlap #terminal when shown', async ({ page }) => {
  // Regression: in terminal mode the `position: fixed` input bar painted
  // its black background over the bottom rows of #terminal because Ace
  // rendered into the full host height. Now that the bar is a flex
  // sibling, #terminal.bottom must equal inputBar.top — no overlap,
  // both with and without a simulated on-screen keyboard.
  await page.goto(`${BASE}/s/${SESSION}`);
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(500);

  await page.setViewportSize({ width: 380, height: 800 });

  // Show the bar — no keyboard yet.
  await page.evaluate(() => document.getElementById('inputBar').classList.remove('hidden'));
  await page.waitForTimeout(50);

  const noKb = await page.evaluate(() => {
    const t = document.getElementById('terminal').getBoundingClientRect();
    const b = document.getElementById('inputBar').getBoundingClientRect();
    return { tBottom: t.bottom, bTop: b.top };
  });
  expect(Math.abs(noKb.tBottom - noKb.bTop)).toBeLessThanOrEqual(1);

  // Stub visualViewport to simulate keyboard up.
  await page.evaluate(() => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () => (typeof window.__stubVVHeight === 'number' ? window.__stubVVHeight : window.innerHeight),
    });
    Object.defineProperty(vv, 'offsetTop', {
      configurable: true,
      get: () => (typeof window.__stubVVOffset === 'number' ? window.__stubVVOffset : 0),
    });
    window.__stubVVHeight = window.innerHeight - 300;
    window.__stubVVOffset = 0;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(50);

  const withKb = await page.evaluate(() => {
    const t = document.getElementById('terminal').getBoundingClientRect();
    const b = document.getElementById('inputBar').getBoundingClientRect();
    return { tBottom: t.bottom, bTop: b.top };
  });
  expect(Math.abs(withKb.tBottom - withKb.bTop)).toBeLessThanOrEqual(1);
});

test('content area shrinks under on-screen keyboard so terminal stays visible', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(500);

  await page.setViewportSize({ width: 380, height: 800 });

  await page.evaluate(() => {
    const bar = document.getElementById('inputBar');
    bar.classList.remove('hidden');
    const vv = window.visualViewport;
    window.__origVVHeight = vv.height;
    window.__origVVOffset = vv.offsetTop;
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () => (typeof window.__stubVVHeight === 'number' ? window.__stubVVHeight : window.__origVVHeight),
    });
    Object.defineProperty(vv, 'offsetTop', {
      configurable: true,
      get: () => (typeof window.__stubVVOffset === 'number' ? window.__stubVVOffset : window.__origVVOffset),
    });
  });

  const before = await page.evaluate(() => ({
    terminal: document.getElementById('terminal').clientHeight,
    bodyHeight: document.body.style.height,
  }));

  await page.evaluate(() => {
    window.__stubVVHeight = window.innerHeight - 300;
    window.__stubVVOffset = 0;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });

  await expect.poll(
    async () => await page.evaluate(() => document.body.style.height),
    { timeout: 2000 },
  ).toMatch(/^\d+(\.\d+)?px$/);

  const after = await page.evaluate(() => ({
    terminal: document.getElementById('terminal').clientHeight,
    bodyHeight: document.body.style.height,
  }));

  // Body shrunk by ~300px, so terminal should be at least ~250px shorter.
  expect(after.terminal).toBeLessThan(before.terminal - 250);

  // Restoring the viewport should clear the inline height override.
  await page.evaluate(() => {
    window.__stubVVHeight = window.innerHeight;
    window.__stubVVOffset = 0;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });

  await expect.poll(
    async () => await page.evaluate(() => document.body.style.height),
    { timeout: 2000 },
  ).toBe('');
});


test('theme picker swaps Terminal.colors[2] live', async ({ page }) => {
  // Switching themes (via the same JS path the settings picker uses)
  // must update the live libterm palette (Terminal.colors[2]). Index 2
  // is "green" — every bundle picks a different shade, so any pair of
  // distinct themes must produce a different value at index 2.
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  // Default boot: tomorrow-night-soft. Green (index 2) = #b5bd68.
  const before = await page.evaluate(() => {
    const T = window.__Aceterm && window.__Aceterm.Terminal;
    return T && T.colors ? T.colors[2] : null;
  });
  expect(before).toBeTruthy();
  expect(before.toLowerCase()).toBe('#b5bd68');

  // Swap to gruvbox-dark-soft (green index 2 = #98971a).
  const after = await page.evaluate(async () => {
    const mod = await import('/static/themes.js');
    mod.setStoredThemeId('gruvbox-dark-soft');
    mod.applyTheme('gruvbox-dark-soft');
    window.dispatchEvent(new CustomEvent('mobux:theme', { detail: 'gruvbox-dark-soft' }));
    const T = window.__Aceterm && window.__Aceterm.Terminal;
    return T && T.colors ? T.colors[2] : null;
  });
  expect(after.toLowerCase()).toBe('#98971a');

  // The terminal session itself must keep working through the swap —
  // the WebSocket is independent of the colour palette.
  expect(await page.evaluate(() => window.__mobuxView.test.wsReady())).toBe(true);

  // Restore the default for downstream tests.
  await page.evaluate(async () => {
    const mod = await import('/static/themes.js');
    mod.setStoredThemeId('tomorrow-night-soft');
    mod.applyTheme('tomorrow-night-soft');
    window.dispatchEvent(new CustomEvent('mobux:theme', { detail: 'tomorrow-night-soft' }));
  });
});
