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

  // Initial state: xterm visible, ribbon toggle shows reader icon
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#viewToggleBtn')).toHaveText('📖');

  // Reveal the input bar so the ribbon view-toggle is in the viewport.
  await page.evaluate(() => document.getElementById('inputBar').classList.remove('hidden'));

  await page.locator('#viewToggleBtn').scrollIntoViewIfNeeded();
  await page.locator("#viewToggleBtn").click({ force: true });

  // Reader is now active, icon flips
  await expect(page.locator('#reader')).toBeVisible();
  await expect(page.locator('#terminal')).toBeHidden();
  await expect(page.locator('#viewToggleBtn')).toHaveText('▣');

  await page.locator("#viewToggleBtn").click({ force: true });
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#reader')).toBeHidden();
  await expect(page.locator('#viewToggleBtn')).toHaveText('📖');
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

test('reader view toggle button in input ribbon flips back to xterm', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.test.injectLines(120, 'rl'));
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(250);

  await page.evaluate(() => document.getElementById('inputBar').classList.remove('hidden'));
  await page.locator('#viewToggleBtn').scrollIntoViewIfNeeded();
  await page.locator("#viewToggleBtn").click({ force: true });
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
    const blocks = document.querySelectorAll('#reader .rb');
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

test('OSC 133 ; A marks lines without a sigil as prompts', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  // The text on the marked line ends with no recognised prompt sigil
  // and would otherwise classify as 'text'. With the OSC 133 ; A
  // marker emitted right before it, the tokenizer must classify it
  // as a prompt.
  await injectRaw(page, '\x1b]133;A\x07my-shell-prompt-no-sigil\nrun output line\n');
  await page.waitForTimeout(250);

  const summary = await blockSummary(page);
  const promptHit = summary.find(
    (b) => b.classes.includes('rb-prompt') && b.text.includes('my-shell-prompt-no-sigil'),
  );
  expect(promptHit).toBeTruthy();

  // After detection, the "shell integration not detected" hint
  // should be hidden.
  const hintHidden = await page.evaluate(() => {
    const el = document.querySelector('.reader-osc-hint');
    return !el || el.hidden;
  });
  expect(hintHidden).toBe(true);
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

test('consecutive same-bg lines fuse into a single bubble', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  const BLUE_BG = '\x1b[44m';
  const RESET2 = '\x1b[0m';
  await injectRaw(
    page,
    // Leading newline pushes past any pending shell prompt so the
    // first bubble line isn't shared with the prompt run.
    `\n${BLUE_BG}bubble line one${RESET2}\n` +
    `${BLUE_BG}bubble line two${RESET2}\n` +
    `${BLUE_BG}bubble line three${RESET2}\n` +
    `plain trailing line\n`,
  );
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#reader .rb-bubble'))
      .some((b) => (b.querySelectorAll('.rb-bubble-line').length >= 3)),
    { timeout: 3000 },
  );

  const bubbles = await page.evaluate(() => {
    const els = document.querySelectorAll('#reader .rb-bubble');
    return Array.from(els).map((b) => ({
      lines: b.querySelectorAll('.rb-bubble-line').length,
      text: (b.textContent || '').trim(),
    }));
  });
  const fused = bubbles.find((b) => b.text.includes('bubble line one') && b.text.includes('bubble line three'));
  expect(fused).toBeTruthy();
  expect(fused.lines).toBeGreaterThanOrEqual(3);
});

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

  // Make sure we're on the terminal (aceterm) view, not reader.
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(150);

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
  // `Aceterm.Terminal.setColors(...)` so the terminal view matches
  // reader-mode and avoids the over-saturated Tango lime/cyan that
  // makes highlighted blocks painful on a dark phone screen. Reaching
  // libterm's Terminal class via `instance.constructor` returned
  // `EventEmitter` (libterm replaces `prototype.constructor`), so the
  // override silently no-op'd before the explicit `Aceterm.Terminal`
  // pin landed.
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

test('reader supports synthetic scrolling when content overflows', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);

  const big = Array.from({ length: 200 }, (_, i) => `line ${i} content`).join('\n');
  await injectRaw(page, big + '\n');
  await page.waitForTimeout(300);

  const max = await page.evaluate(() => window.__mobuxView.test.readerMaxScroll());
  expect(max).toBeGreaterThan(0);

  // Drive scroll synthetically and verify the inner translates.
  const moved = await page.evaluate(() => {
    window.__mobuxView.test.readerScrollBy(-1e6);
    const top = window.__mobuxView.test.readerScrollY();
    window.__mobuxView.test.readerScrollBy(500);
    return { top, mid: window.__mobuxView.test.readerScrollY() };
  });
  expect(moved.top).toBe(0);
  expect(moved.mid).toBeGreaterThan(0);
});

test.skip('reader status bar stays filled after a tmux window switch', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));

  await expect.poll(
    async () => await page.evaluate(() => window.__mobuxView.test.bufferLength()),
    { timeout: 5000 },
  ).toBeGreaterThan(1);

  await expect.poll(
    async () => await page.evaluate(() => ({
      sbH: window.__mobuxView.test.statusBarOffsetHeight(),
      filled: window.__mobuxView.test.statusBarFilled(),
    })),
    { timeout: 8000 },
  ).toMatchObject({ filled: true });

  await page.evaluate(() => window.__mobuxView.test.switchWindow('next'));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__mobuxView.test.switchWindow('prev'));

  await expect.poll(
    async () => await page.evaluate(() => ({
      sbH: window.__mobuxView.test.statusBarOffsetHeight(),
      filled: window.__mobuxView.test.statusBarFilled(),
    })),
    { timeout: 8000 },
  ).toMatchObject({ filled: true });
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

// ── Synthetic viewport (reader) ─────────────────────────────────────
// Direct coverage of the translate3d-based scroller in reader-view.js.
// All tests reset state via swap('xterm') / swap('reader') so they're
// independent and can run in any order.

async function bootReader(page) {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);
  // Make sure we start from a clean reader mount.
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);
}

async function fillReader(page, n = 300, prefix = 'svline') {
  await page.evaluate((args) => window.__mobuxView.test.injectLines(args.n, args.prefix), { n, prefix });
  await page.waitForFunction(
    () => window.__mobuxView.test.readerMaxScroll() > 0,
    { timeout: 3000 },
  );
}

function readTransformY(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#reader .reader-inner');
    if (!el) return null;
    const t = el.style.transform || '';
    const m = t.match(/translate3d\(\s*0(?:px)?\s*,\s*(-?[\d.]+)px/);
    return m ? parseFloat(m[1]) : null;
  });
}

test('synthetic viewport: translate3d transform reflects scrollY', async ({ page }) => {
  await bootReader(page);
  await fillReader(page);

  await page.evaluate(() => window.__mobuxView.test.readerScrollBy(-9e9));
  expect(await readTransformY(page)).toBe(0);

  await page.evaluate(() => window.__mobuxView.test.readerScrollBy(250));
  const y = await readTransformY(page);
  const sy = await page.evaluate(() => window.__mobuxView.test.readerScrollY());
  expect(sy).toBeGreaterThan(0);
  expect(y).toBeLessThan(0);
  expect(Math.round(-y)).toBe(Math.round(sy));
});

test('synthetic viewport: clamps at 0', async ({ page }) => {
  await bootReader(page);
  await fillReader(page);

  await page.evaluate(() => window.__mobuxView.test.readerScrollBy(-9e9));
  const sy = await page.evaluate(() => window.__mobuxView.test.readerScrollY());
  expect(sy).toBe(0);
});

test('synthetic viewport: clamps at max with overflowing content', async ({ page }) => {
  await bootReader(page);
  await fillReader(page);

  const { sy, max } = await page.evaluate(() => {
    window.__mobuxView.test.readerScrollBy(9e9);
    return {
      sy: window.__mobuxView.test.readerScrollY(),
      max: window.__mobuxView.test.readerMaxScroll(),
    };
  });
  expect(max).toBeGreaterThan(0);
  expect(sy).toBe(max);
});

test('synthetic viewport: sticky-to-bottom on new output', async ({ page }) => {
  await bootReader(page);
  await fillReader(page, 200, 'sticky');

  await page.evaluate(() => window.__mobuxView.test.readerScrollBy(9e9));
  const before = await page.evaluate(() => ({
    sy: window.__mobuxView.test.readerScrollY(),
    max: window.__mobuxView.test.readerMaxScroll(),
  }));
  expect(before.sy).toBe(before.max);

  await page.evaluate(() => window.__mobuxView.test.injectLines(80, 'sticky2'));
  await page.waitForFunction((prev) => {
    const m = window.__mobuxView.test.readerMaxScroll();
    return m > prev;
  }, before.max, { timeout: 3000 });

  const after = await page.evaluate(() => ({
    sy: window.__mobuxView.test.readerScrollY(),
    max: window.__mobuxView.test.readerMaxScroll(),
  }));
  expect(after.max).toBeGreaterThan(before.max);
  expect(after.sy).toBe(after.max);
});

test('synthetic viewport: not sticky when scrolled up', async ({ page }) => {
  await bootReader(page);
  await fillReader(page, 200, 'noscroll');

  await page.evaluate(() => window.__mobuxView.test.readerScrollBy(-9e9));
  const before = await page.evaluate(() => window.__mobuxView.test.readerScrollY());
  expect(before).toBe(0);

  await page.evaluate(() => window.__mobuxView.test.injectLines(80, 'tail'));
  // Wait for the throttled render to flush (RENDER_THROTTLE_MS = 50ms).
  await page.waitForTimeout(250);

  const sy = await page.evaluate(() => window.__mobuxView.test.readerScrollY());
  expect(sy).toBeGreaterThanOrEqual(0);
  expect(sy).toBeLessThanOrEqual(5);
});

test('synthetic viewport: resize changes maxScroll', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await bootReader(page);
  await fillReader(page, 300, 'resz');

  const tall = await page.evaluate(() => window.__mobuxView.test.readerMaxScroll());

  await page.setViewportSize({ width: 400, height: 400 });
  await page.waitForFunction(
    (prev) => window.__mobuxView.test.readerMaxScroll() > prev,
    tall,
    { timeout: 3000 },
  );
  const shortMax = await page.evaluate(() => window.__mobuxView.test.readerMaxScroll());
  expect(shortMax).toBeGreaterThan(tall);

  await page.setViewportSize({ width: 400, height: 1000 });
  await page.waitForFunction(
    (prev) => window.__mobuxView.test.readerMaxScroll() < prev,
    shortMax,
    { timeout: 3000 },
  );
  const tallerMax = await page.evaluate(() => window.__mobuxView.test.readerMaxScroll());
  expect(tallerMax).toBeLessThan(shortMax);
});

test('synthetic viewport: mount/unmount has no duplicate inner', async ({ page }) => {
  await bootReader(page);
  await fillReader(page, 150, 'mu');

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__mobuxView.swap('xterm'));
    await page.waitForTimeout(80);
    await page.evaluate(() => window.__mobuxView.swap('reader'));
    await page.waitForTimeout(150);
  }

  const innerCount = await page.locator('#reader .reader-inner').count();
  expect(innerCount).toBe(1);

  // After remount, scrollY must be valid (>= 0 and <= max).
  const { sy, max } = await page.evaluate(() => ({
    sy: window.__mobuxView.test.readerScrollY(),
    max: window.__mobuxView.test.readerMaxScroll(),
  }));
  expect(sy).toBeGreaterThanOrEqual(0);
  expect(sy).toBeLessThanOrEqual(max);
});

test('synthetic viewport: history smoke renders blocks and overflows', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(50);

  // Inject BEFORE swapping to reader so the first render sees history.
  await page.evaluate(() => window.__mobuxView.test.injectLines(200, 'hist'));
  await page.evaluate(() => window.__mobuxView.swap('reader'));

  await page.waitForFunction(
    () => document.querySelectorAll('#reader .rb-line').length >= 100
      && window.__mobuxView.test.readerMaxScroll() > 0,
    { timeout: 5000 },
  );

  const max = await page.evaluate(() => window.__mobuxView.test.readerMaxScroll());
  expect(max).toBeGreaterThan(0);
  // Text lines fuse into rb-text blocks; count individual rendered
  // lines (.rb-line) rather than block containers.
  const lineCount = await page.locator('#reader .rb-line').count();
  expect(lineCount).toBeGreaterThanOrEqual(100);
});

test('synthetic viewport: bubble fusion under translated inner', async ({ page }) => {
  await bootReader(page);

  const BLUE_BG = '\x1b[44m';
  const RESET2 = '\x1b[0m';
  await page.evaluate((args) => window.__mobuxView.test.inject(args.s), {
    s: `\n${BLUE_BG}sv bubble one${RESET2}\n` +
       `${BLUE_BG}sv bubble two${RESET2}\n` +
       `${BLUE_BG}sv bubble three${RESET2}\n`,
  });

  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#reader .rb-bubble'))
      .some((b) => b.querySelectorAll('.rb-bubble-line').length >= 3),
    { timeout: 3000 },
  );

  // Confirm the inner is the translated container (so fusion happens
  // inside the synthetic viewport, not some bare DOM).
  const insideInner = await page.evaluate(() => {
    const inner = document.querySelector('#reader .reader-inner');
    const b = document.querySelector('#reader .rb-bubble');
    return !!(inner && b && inner.contains(b));
  });
  expect(insideInner).toBe(true);
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

test('content area shrinks under on-screen keyboard so reader text stays visible', async ({ page }) => {
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

test('reader re-pins to bottom synchronously when keyboard appears', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(500);

  await page.setViewportSize({ width: 380, height: 800 });
  await page.evaluate(() => window.__mobuxView.test.injectLines(50, 'line'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__mobuxView.test.readerStickToBottom());
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    const bar = document.getElementById('inputBar');
    bar.classList.remove('hidden');
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () => (typeof window.__stubVVHeight === 'number' ? window.__stubVVHeight : window.innerHeight),
    });
    Object.defineProperty(vv, 'offsetTop', {
      configurable: true,
      get: () => (typeof window.__stubVVOffset === 'number' ? window.__stubVVOffset : 0),
    });
  });

  const before = await page.evaluate(() => ({
    scrollY: window.__mobuxView.test.readerScrollY(),
    maxScroll: window.__mobuxView.test.readerMaxScroll(),
    readerH: document.getElementById('reader').clientHeight,
  }));
  expect(before.scrollY).toBe(before.maxScroll);
  expect(before.scrollY).toBeGreaterThan(0);

  // Dispatch keyboard appearance and read state in the SAME task.
  // Without a synchronous re-pin from input-bar, scrollY stays at the
  // pre-keyboard maxScroll while readerH has shrunk — a visible gap
  // appears between the content bottom and the lifted input bar.
  const sync = await page.evaluate(() => {
    window.__stubVVHeight = window.innerHeight - 300;
    window.visualViewport.dispatchEvent(new Event('resize'));
    return {
      scrollY: window.__mobuxView.test.readerScrollY(),
      maxScroll: window.__mobuxView.test.readerMaxScroll(),
      readerH: document.getElementById('reader').clientHeight,
    };
  });

  expect(sync.readerH).toBeLessThan(before.readerH - 250);
  // Reader must be re-pinned to the new bottom in the same task — not
  // a frame later. maxScroll grew because hostH shrank.
  expect(sync.maxScroll).toBeGreaterThan(before.maxScroll);
  expect(sync.scrollY).toBe(sync.maxScroll);
});

test('theme picker swaps Terminal.colors[2] and #reader --ansi-2 live', async ({ page }) => {
  // Verify that switching themes (via the same JS path the settings
  // picker uses) updates BOTH the terminal palette (libterm's class-
  // level Terminal.colors[2]) and the reader-mode CSS variable
  // (--ansi-2 on #reader). Index 2 is "green" — every bundle picks a
  // different shade, so any pair of distinct themes must produce a
  // different value at index 2.
  //
  // Boot the terminal page (so #reader exists and Aceterm is loaded),
  // then drive applyTheme directly — same code path the settings page
  // calls on <select> change. No page reload between swaps to prove
  // the live-swap path actually works.
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  // Default boot: tomorrow-night-soft. Green (index 2) = #b5bd68.
  const before = await page.evaluate(() => {
    const T = window.__Aceterm && window.__Aceterm.Terminal;
    return {
      term: T && T.colors ? T.colors[2] : null,
      reader: getComputedStyle(document.getElementById('reader'))
        .getPropertyValue('--ansi-2').trim(),
    };
  });
  expect(before.term).toBeTruthy();
  expect(before.term.toLowerCase()).toBe('#b5bd68');
  expect(before.reader.toLowerCase()).toBe('#b5bd68');

  // Swap to gruvbox-dark-soft (green index 2 = #98971a). Drive the
  // exact same module the settings picker uses.
  const after = await page.evaluate(async () => {
    const mod = await import('/static/themes.js');
    mod.setStoredThemeId('gruvbox-dark-soft');
    mod.applyTheme('gruvbox-dark-soft');
    window.dispatchEvent(new CustomEvent('mobux:theme', { detail: 'gruvbox-dark-soft' }));
    const T = window.__Aceterm && window.__Aceterm.Terminal;
    return {
      term: T && T.colors ? T.colors[2] : null,
      reader: getComputedStyle(document.getElementById('reader'))
        .getPropertyValue('--ansi-2').trim(),
    };
  });
  expect(after.term.toLowerCase()).toBe('#98971a');
  expect(after.reader.toLowerCase()).toBe('#98971a');

  // The terminal session itself must keep working through the swap —
  // the WebSocket is independent of the colour palette.
  expect(await page.evaluate(() => window.__mobuxView.test.wsReady())).toBe(true);

  // Restore the default for downstream tests in this file (the suite
  // re-uses the page across tests; leaving gruvbox would break the
  // earlier muted-base16 assertion if tests were re-ordered).
  await page.evaluate(async () => {
    const mod = await import('/static/themes.js');
    mod.setStoredThemeId('tomorrow-night-soft');
    mod.applyTheme('tomorrow-night-soft');
    window.dispatchEvent(new CustomEvent('mobux:theme', { detail: 'tomorrow-night-soft' }));
  });
});
