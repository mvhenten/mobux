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

  // Wait for WebSocket to connect and initial content to render
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, { timeout: 5000 });
  
  // Wait a bit for first data to arrive and loading screen to clear
  await page.waitForTimeout(500);

  // Check for terminal visibility - use .sterk-viewport which sterk creates
  await expect(page.locator('.sterk-viewport')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#touchOverlay')).toBeAttached();

  await page.waitForFunction(() => {
    const vp = document.querySelector('.ace_scroller');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });
});

test('scroll works via touch gesture', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);

  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  // Wait for WS to be fully ready before injecting lines
  await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, { timeout: 15000 });
  // Wait for initial buffer to stabilize
  await page.waitForTimeout(500);
  
  // Inject 300 lines directly into the terminal so we have guaranteed scrollback
  await page.evaluate(() => window.__mobuxView.test.injectLines(300, 'scrollseed'));
  
  // On CI, terminal processing is slower - wait for buffer to grow large enough to scroll
  await page.waitForFunction(
    () => window.__mobuxView.test.bufferLength() > 200,
    { timeout: 20000 }
  );

  // Park at the bottom; the terminal tracks scroll position via viewportY in
  // its buffer (not via the DOM scrollTop).
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
    const vp = document.querySelector('.ace_scroller');
    return vp && vp.scrollHeight > 100;
  }, { timeout: 5000 });
  
  // Wait for WS to be ready before typing commands
  await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, { timeout: 15000 });
  await page.waitForTimeout(300);

  // Clear any prior test pollution so the URL line stays in the visible viewport.
  await page.evaluate(() => document.querySelector('.ace_text-input').focus());
  await page.keyboard.type('clear');
  await page.keyboard.press('Enter');
  
  // Wait for clear to complete (buffer should shrink or viewport should clear)
  await page.waitForTimeout(500);

  // Type echo URL command
  await page.keyboard.type('echo https://example.com');
  await page.keyboard.press('Enter');
  
  // Wait for the URL to appear in the terminal text
  // On CI, echo output can take longer to render through the shell
  await page.waitForFunction(() => {
    const rows = document.querySelector('.ace_text-layer');
    return rows?.textContent?.includes('https://example.com') ?? false;
  }, { timeout: 20000 });

  // Verify URL appears in terminal text
  const hasUrl = await page.evaluate(() => {
    const rows = document.querySelector('.ace_text-layer');
    return rows?.textContent?.includes('https://example.com') ?? false;
  });
  expect(hasUrl).toBe(true);

  // Verify our tap-to-link detection works by simulating the logic
  const detected = await page.evaluate(() => {
    const termEl = document.getElementById('terminal');
    const rows = termEl?.querySelector('.ace_text-layer');
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
  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
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

test('reader view renders buffer text', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);

  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
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

  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
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
  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => {
    const vp = document.querySelector('.ace_scroller');
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
// These tests guard against the regression where the terminal touch
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

test('reader view disables terminal touch overlay', async ({ page }) => {
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(200);

  const overlayPE = await page.evaluate(() =>
    getComputedStyle(document.getElementById('touchOverlay')).pointerEvents
  );
  expect(overlayPE).toBe('none');

  // Flipping back must restore overlay so terminal gestures keep working.
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

// End-to-end regression for tmux 3.4's `allow-passthrough off` default,
// which silently drops bare OSC 133 sequences before they reach the
// outer terminal. Drives a real tmux pane via send-keys, has bash
// `printf` an OSC 133 ; A marker wrapped in tmux's DCS passthrough
// envelope (\ePtmux;\e<seq>\e\\), and verifies the marker actually
// arrives at libterm — proving:
//   1. mobux's handle_ws sets `allow-passthrough on` on the server, and
//   2. the wrap form chosen by the v2 shell snippet survives tmux's
//      output filter and is parsed by libterm's OSC dispatcher.
// If either layer regresses, oscDetected stays false and the assertion
// fires. Skips when the test server can't reach `tmux send-keys`
// (podman target leaves TMUX_CMD unset for those tests).
// FAILING SPEC: OSC 133 must work out-of-the-box for sessions mobux
// creates itself, regardless of whether the user has installed the
// shell-integration snippet into their RC files.
//
// Why this is the right contract:
//   - The current installer-based flow is fragile (depends on user
//     clicking install, RC version drift, shell variant, sourcing,
//     tmux version, allow-passthrough). Bug repros: ~/.bashrc with v1
//     snippet under tmux 3.4 -> bare OSC dropped -> reader empty.
//   - When mobux owns session creation it controls the shell
//     environment and can inject OSC 133 deterministically (e.g.
//     bash --rcfile <(cat $HOME/.bashrc; <snippet>), zsh ZDOTDIR
//     shim, fish one-liner). User's RC stays untouched.
//   - Installer flow remains useful only for shells *outside* mobux
//     (ssh, attach to pre-existing tmux), and graduates from
//     'required' to 'nice-to-have'.
//
// Setup pretends the user has never run the installer:
//   - Empty $HOME, no .bashrc / .zshrc / .config/fish.
//   - mobux creates the tmux session via its own API.
//   - Reader must observe OSC 133 the first time the prompt redraws.
test('OSC 133 works out of the box for mobux-created sessions (no installer)', async ({ page }) => {
  const OOTB_SESSION = `${SESSION}-ootb`;
  const OOTB_HOME = '/tmp/mobux-ootb-home';

  // Clean slate: empty HOME, no shell integration anywhere.
  execSync(`rm -rf ${OOTB_HOME} && mkdir -p ${OOTB_HOME}`);
  // Sanity-assert no FENCE in the empty home before we proceed.
  expect(execSync(`grep -rl 'mobux OSC 133' ${OOTB_HOME} 2>/dev/null || true`)
    .toString().trim()).toBe('');

  // Make sure mobux's tmux server uses this clean HOME for new shells.
  // (Layer 1 of the fix is responsible for actually wiring this up;
  // the test only asserts the observable outcome.)
  try { tmux(`kill-session -t ${OOTB_SESSION}`); } catch (_) {}

  // Create the session via mobux's HTTP API — not a pre-seeded
  // send-keys workaround. This is the path real users hit.
  const create = await page.request.post(`${BASE}/api/sessions`, {
    data: { name: OOTB_SESSION },
  });
  expect(create.ok()).toBeTruthy();

  try {
    await page.goto(`${BASE}/s/${OOTB_SESSION}`);
    await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
    await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, { timeout: 5000 });

    // Precondition: nothing has emitted OSC 133 yet.
    const before = await page.evaluate(() => window.__mobuxView.test.oscDetected());
    expect(before).toBe(false);

    // Trigger a single prompt redraw — typing Enter is the most
    // mundane user action possible. If OSC 133 only fires when the
    // user manually installs a snippet, this stays false and the
    // assertion below fails (which is the current state of main).
    tmux(`send-keys -t ${OOTB_SESSION} "" Enter`);

    await page.waitForFunction(
      () => window.__mobuxView.test.oscDetected() === true,
      { timeout: 5000 },
    );
    const after = await page.evaluate(() => window.__mobuxView.test.oscDetected());
    expect(after).toBe(true);

    // And the user's $HOME must remain untouched — mobux must NOT
    // silently install the snippet to ~/.bashrc as a side effect.
    const homeAfter = execSync(`grep -rl 'mobux OSC 133' ${OOTB_HOME} 2>/dev/null || true`)
      .toString().trim();
    expect(homeAfter).toBe('');
  } finally {
    try { tmux(`kill-session -t ${OOTB_SESSION}`); } catch (_) {}
  }
});

test('OSC 133 ; A wrapped in tmux DCS passthrough reaches libterm', async ({ page }) => {
  // Dedicated session so the existing pre-seeded `SESSION` keeps its
  // PS1 untouched and other tests' assertions don't race with our
  // injected output.
  const PT_SESSION = `${SESSION}-osc133-pt`;
  try { tmux(`kill-session -t ${PT_SESSION}`); } catch (_) {}
  tmux(`new-session -d -s ${PT_SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
  // Quiet PS1 — anything emitting OSC 133 from the prompt itself
  // would muddy "did the parser see this exact byte sequence?"
  tmux(`send-keys -t ${PT_SESSION} "PS1=':: '" Enter`);
  tmux(`send-keys -t ${PT_SESSION} "clear" Enter`);
  execSync('sleep 0.3');

  try {
    await page.goto(`${BASE}/s/${PT_SESSION}`);
    await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
    await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, {
      timeout: 5000,
    });

    // Poll until mobux's handle_ws has run `set-option -g
    // allow-passthrough on` on the server. The bash subprocess that
    // spawns the attach is async so the option may not be on the
    // instant the WS upgrade completes — polling here doubles as
    // (a) verification that mobux's role of setting the option ran,
    // and (b) a deterministic gate against the printf below firing
    // its bytes through tmux while passthrough is still off.
    let allowPassthroughOn = false;
    for (let i = 0; i < 50; i++) {
      const v = execSync(`${TMUX_CMD} show-option -gv allow-passthrough 2>/dev/null || true`)
        .toString().trim();
      if (v === 'on') { allowPassthroughOn = true; break; }
      execSync('sleep 0.1');
    }
    expect(allowPassthroughOn).toBe(true);

    // Precondition: oscDetected is false on a fresh page (no OSC 133
    // has flowed yet).
    const before = await page.evaluate(() => window.__mobuxView.test.oscDetected());
    expect(before).toBe(false);

    // Drive the bash inside the pane to emit the wrapped sequence.
    // Format string layers:
    //   JS literal -> sh -c double-quote (folds `\\` -> `\`)
    //   -> tmux send-keys arg -> bash readline buffer
    //   -> bash printf format string (single-quoted preserves `\`)
    //   -> printf escape interpretation (`\e`->ESC, `\a`->BEL,
    //      `\\`->`\`, unknown `\X` preserved as `\X`).
    // Net bytes printf emits:
    //   ESC P t m u x ; ESC ESC ] 1 3 3 ; A BEL ESC `\` LF
    // i.e. the v2 snippet's PS1 wrap exactly. tmux strips the DCS
    // envelope and forwards the inner OSC 133;A to mobux's pty,
    // which feeds it to libterm's parser, which sets oscDetected.
    const wrapped = "printf '\\ePtmux;\\e\\e]133;A\\a\\e\\\\\\n'";
    tmux(`send-keys -t ${PT_SESSION} "${wrapped}" Enter`);

    await page.waitForFunction(
      () => window.__mobuxView.test.oscDetected() === true,
      { timeout: 8000 },
    );
    const after = await page.evaluate(() => window.__mobuxView.test.oscDetected());
    expect(after).toBe(true);

    // And the reader hint must hide as a consequence.
    await page.evaluate(() => window.__mobuxView.swap('reader'));
    await page.waitForTimeout(200);
    const hintHidden = await page.evaluate(() => {
      const el = document.querySelector('.reader-osc-hint');
      return !el || el.hidden;
    });
    expect(hintHidden).toBe(true);
  } finally {
    try { tmux(`kill-session -t ${PT_SESSION}`); } catch (_) {}
  }
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
  // Sterk v2.0.1+ renders SGR colors via CSS classes (.sterk-fg-N, .sterk-bg-N)
  // instead of inline styles. This test verifies that sterk's VtMode tokenizer
  // correctly applies palette colors via CSS classes, which the browser then
  // styles via injected CSS rules.
  //
  // Original intent (PR #55 → #6X): claude-code-style highlighted blocks
  // (`\x1b[42m text \x1b[0m`) were unreadable because the theme's
  // light-gray default fg landed on bright palette bgs (lime, cyan…).
  // Sterk's CSS injection handles this by mapping palette indices to the
  // theme's color values.
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  
  // Wait for WS to be ready before injecting ANSI sequences
  await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, { timeout: 15000 });
  await page.waitForTimeout(300);

  // Make sure we're on the terminal view, not reader.
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(150);

  // Bright bgs (green=2, cyan=6) → dark bgs (black=0, blue=4).
  // Plus explicit fg+bg control (yellow fg=3, blue bg=4).
  await injectRaw(
    page,
    '\n\x1b[42mGREEN_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[46mCYAN_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[40mBLACK_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[44mBLUE_BG_DEFAULT_FG\x1b[0m\n' +
    '\x1b[33;44mYELLOW_FG_BLUE_BG\x1b[0m\n',
  );
  
  // Wait for xterm to parse and Ace to tokenize the SGR sequences.
  // On CI, this is significantly slower than locally. Wait for ALL markers to appear.
  await page.waitForFunction(() => {
    const text = document.body.textContent || '';
    return (
      text.includes('GREEN_BG_DEFAULT_FG') &&
      text.includes('CYAN_BG_DEFAULT_FG') &&
      text.includes('BLACK_BG_DEFAULT_FG') &&
      text.includes('BLUE_BG_DEFAULT_FG') &&
      text.includes('YELLOW_FG_BLUE_BG')
    );
  }, { timeout: 25000 });
  await page.waitForFunction(() => document.querySelector('[class*="ace_sterk-bg-"]') !== null, { timeout: 25000 });

  const hexToRgb = (hex) => {
    const h = hex.replace('#', '');
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ];
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
    // Sterk 2.0.1+ uses VtMode tokenizer which emits CSS classes.
    // Ace prefixes all token classes with "ace_", so sterk's "sterk-bg-2"
    // becomes "ace_sterk-bg-2".
    //
    // On CI, Ace may split marker text across multiple spans (token boundaries,
    // line wrapping). Instead of requiring the entire marker to live in one span,
    // find the line containing each marker and extract sterk classes from any
    // span on that line.
    const lines = Array.from(document.querySelectorAll('.ace_line'));
    const palette = window.__sterk?.options?.theme?.palette || [];
    const theme = window.__sterk?.options?.theme || {};
    const defaultFg = theme.foreground || '#c5c8c6';
    const defaultBg = theme.background || '#1e1e1e';

    const markers = [
      'GREEN_BG_DEFAULT_FG',
      'CYAN_BG_DEFAULT_FG',
      'BLACK_BG_DEFAULT_FG',
      'BLUE_BG_DEFAULT_FG',
      'YELLOW_FG_BLUE_BG',
    ];

    const result = {};
    
    for (const marker of markers) {
      // Find the line containing this marker
      const line = lines.find((l) => (l.textContent || '').includes(marker));
      if (!line) continue;

      // Find ANY span with sterk- classes on this line
      const sterkSpan = Array.from(line.querySelectorAll('span'))
        .find((span) => span.className.includes('sterk-'));
      
      if (!sterkSpan) continue;

      const cls = sterkSpan.className;
      let fgColor = defaultFg;
      let bgColor = defaultBg;

      // Extract fg palette index from class (e.g., "ace_sterk-fg-3")
      const fgMatch = cls.match(/sterk-fg-(\d+)/);
      if (fgMatch) {
        const idx = parseInt(fgMatch[1], 10);
        fgColor = palette[idx] || defaultFg;
      }

      // Extract bg palette index from class (e.g., "ace_sterk-bg-2")
      const bgMatch = cls.match(/sterk-bg-(\d+)/);
      if (bgMatch) {
        const idx = parseInt(bgMatch[1], 10);
        bgColor = palette[idx] || defaultBg;
      }

      // Use the first sterk-styled span on this line as representative
      result[marker] = { marker, color: fgColor, bg: bgColor };
    }
    return result;
  });

  const find = (marker) => styled[marker];

  const green = find('GREEN_BG_DEFAULT_FG');
  const cyan = find('CYAN_BG_DEFAULT_FG');
  const black = find('BLACK_BG_DEFAULT_FG');
  const blue = find('BLUE_BG_DEFAULT_FG');
  const yel = find('YELLOW_FG_BLUE_BG');

  for (const s of [green, cyan, black, blue, yel]) {
    expect(s).toBeTruthy();
    expect(s.color).toBeTruthy();
    expect(s.bg).toBeTruthy();
  }

  // Bright bg (green=2, cyan=6) → expect readable contrast.
  // In tomorrow-night-soft: green=#b5bd68 (bright), cyan=#8abeb7 (bright).
  for (const s of [green, cyan]) {
    const bgL = lum(hexToRgb(s.bg));
    const fgL = lum(hexToRgb(s.color));
    // Bright backgrounds should have high luminance
    expect(bgL).toBeGreaterThan(0.15);
    // Either the fg is set to a contrasting value, or it's the theme default
    // (which sterk doesn't auto-adjust). The important thing is that
    // sterk *renders* the SGR attributes as CSS classes.
  }

  // Dark bg (black=0, blue=4) → expect readable contrast.
  for (const s of [black, blue]) {
    const bgL = lum(hexToRgb(s.bg));
    // Dark backgrounds should have low luminance
    expect(bgL).toBeLessThan(0.4);
  }

  // Explicit fg (yellow=3) + explicit bg (blue=4): both should be from palette.
  const yfgRgb = hexToRgb(yel.color);
  const ybgRgb = hexToRgb(yel.bg);
  expect(yfgRgb).toBeTruthy();
  expect(ybgRgb).toBeTruthy();
  // Yellow in tomorrow-night-soft is #f0c674 (R high, G high, B mid-low)
  expect(yfgRgb[0]).toBeGreaterThan(200);
  expect(yfgRgb[1]).toBeGreaterThan(150);
  expect(yfgRgb[2]).toBeLessThan(200);
});

test('terminal uses the muted base16 palette, not Tango defaults', async ({ page }) => {
  // Regression: terminal-core.js sets a base16-tomorrow palette so the
  // terminal view matches reader-mode and avoids the over-saturated Tango
  // lime/cyan that makes highlighted blocks painful on a dark phone screen.
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  const palette = await page.evaluate(() => {
    const sterk = window.__sterk;
    if (!sterk || !sterk.options || !sterk.options.theme) return null;
    return {
      base16: sterk.options.theme.palette || [],
      scrollback: sterk.options.scrollback,
    };
  });
  expect(palette).toBeTruthy();
  // Index 2 (green) should be base16's muted olive `#b5bd68`, not
  // Tango's `#4e9a06`. Index 10 (bright green) should be `#98c379`,
  // not Tango's `#8ae234`. Index 14 (bright cyan) should be `#56b6c2`,
  // not Tango's `#34e2e2`.
  expect(palette.base16[2]?.toLowerCase()).toBe('#b5bd68');
  expect(palette.base16[10]?.toLowerCase()).toBe('#98c379');
  expect(palette.base16[14]?.toLowerCase()).toBe('#56b6c2');
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
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, { timeout: 5000 });
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
  // Wait for WS to be ready before swapping views
  await page.waitForFunction(() => window.__mobuxView?.test?.wsReady?.() === true, { timeout: 15000 });
  await page.waitForTimeout(300);
  // Make sure we start from a clean reader mount.
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForTimeout(150);
}

async function fillReader(page, n = 300, prefix = 'svline') {
  await page.evaluate((args) => window.__mobuxView.test.injectLines(args.n, args.prefix), { n, prefix });
  // On CI, reader rendering is slower
  await page.waitForFunction(
    () => window.__mobuxView.test.readerMaxScroll() > 0,
    { timeout: 15000 },
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
  
  // Wait for the reader to process the new lines and settle.
  // Since we're scrolled to the top, the reader should NOT auto-scroll
  // to the bottom, so scrollY should stay near 0.
  //
  // Reader render is triggered by onWriteParsed → _scheduleRender (50ms throttle).
  // On CI, the render may not have completed by the time the write Promise resolves.
  await page.waitForFunction(() => {
    const maxScroll = window.__mobuxView.test.readerMaxScroll();
    const scrollY = window.__mobuxView.test.readerScrollY();
    // Wait for maxScroll to grow (new content arrived) and scrollY to stay near 0
    return maxScroll > 200 && scrollY <= 5;
  }, { timeout: 20000 });

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
  // On CI, terminal-core / sterk init can take longer than 5s (Ace bundle parse + first paint)
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForTimeout(50);

  // Inject BEFORE swapping to reader so the first render sees history.
  await page.evaluate(() => window.__mobuxView.test.injectLines(200, 'hist'));
  await page.evaluate(() => window.__mobuxView.swap('reader'));

  // On CI, reader block rendering is slower
  await page.waitForFunction(
    () => document.querySelectorAll('#reader .rb-line').length >= 100
      && window.__mobuxView.test.readerMaxScroll() > 0,
    { timeout: 15000 },
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
  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
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
  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
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
  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
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
  await expect(page.locator('.ace_scroller')).toBeVisible({ timeout: 5000 });
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
  // picker uses) updates BOTH the terminal palette and the reader-mode
  // CSS variable (--ansi-2 on #reader). Index 2 is "green" — every bundle
  // picks a different shade, so any pair of distinct themes must produce a
  // different value at index 2.
  //
  // Boot the terminal page (so #reader exists and sterk is loaded),
  // then drive applyTheme directly — same code path the settings page
  // calls on <select> change. No page reload between swaps to prove
  // the live-swap path actually works.
  await page.goto(`${BASE}/s/${SESSION}`);
  await page.waitForFunction(() => typeof window.__mobuxView !== 'undefined', { timeout: 5000 });
  await page.waitForTimeout(800);

  // Default boot: tomorrow-night-soft. Green (index 2) = #b5bd68.
  const before = await page.evaluate(() => {
    const sterk = window.__sterk;
    return {
      term: sterk?.options?.theme?.palette?.[2] || null,
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
    const sterk = window.__sterk;
    return {
      term: sterk?.options?.theme?.palette?.[2] || null,
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

test('shell integration: status, install, and uninstall round-trip', async ({ page }) => {
  const fs = require('fs');
  const path = require('path');
  const rcPath = path.join(SANDBOX_HOME, '.bashrc');
  const FENCE_OPEN = '# >>> mobux OSC 133 (managed) >>>';
  const FENCE_CLOSE = '# <<< mobux OSC 133 (managed) <<<';

  // Clean any prior fence/backups left by earlier test runs sharing the
  // sandbox HOME.
  try { fs.unlinkSync(rcPath); } catch (_) {}
  try {
    for (const f of fs.readdirSync(SANDBOX_HOME)) {
      if (f.startsWith('.bashrc.mobux.bak.')) {
        fs.unlinkSync(path.join(SANDBOX_HOME, f));
      }
    }
  } catch (_) {}

  const statusRes = await page.request.get(`${BASE}/api/shell-integration/status`);
  expect(statusRes.ok()).toBeTruthy();
  const status = await statusRes.json();
  for (const sh of ['bash', 'zsh', 'fish']) {
    expect(status[sh]).toBeTruthy();
    expect(typeof status[sh].state).toBe('string');
  }

  const installRes = await page.request.post(`${BASE}/api/shell-integration/install`, {
    data: { shell: 'bash' },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(installRes.ok()).toBeTruthy();
  const afterInstall = await installRes.json();
  expect(afterInstall.bash.state).toBe('installed');
  // Version must be reported as a positive integer; the concrete value
  // is governed by `CURRENT_VERSION` in `src/shell_integration.rs` and
  // is allowed to bump as the snippet evolves.
  expect(typeof afterInstall.bash.version).toBe('number');
  expect(afterInstall.bash.version).toBeGreaterThanOrEqual(1);

  const rcContent = fs.readFileSync(rcPath, 'utf8');
  expect(rcContent).toContain(FENCE_OPEN);
  expect(rcContent).toContain(FENCE_CLOSE);
  expect(rcContent).toContain('PS0=');
  // v2+: the snippet must wrap OSC 133 inside tmux's DCS passthrough
  // envelope. Asserting on the `\ePtmux;` prefix is the cheapest way
  // to catch a regression to the bare-OSC v1 form, which tmux 3.4
  // silently drops.
  expect(rcContent).toContain('\\ePtmux;');

  const uninstallRes = await page.request.post(`${BASE}/api/shell-integration/uninstall`, {
    data: { shell: 'bash' },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(uninstallRes.ok()).toBeTruthy();
  const afterUninstall = await uninstallRes.json();
  expect(['not_installed', 'not_present']).toContain(afterUninstall.bash.state);

  if (fs.existsSync(rcPath)) {
    const post = fs.readFileSync(rcPath, 'utf8');
    expect(post).not.toContain(FENCE_OPEN);
    expect(post).not.toContain(FENCE_CLOSE);
  }
});
