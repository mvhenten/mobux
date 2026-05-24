// Visual regression suite — locks pixel-level rendering on the Pixel 7
// emulated viewport. Headless tests (jsdom/happy-dom) silently passed
// through the incident at #81 because their ResizeObserver/visualViewport
// stubs don't match real Android Chrome semantics. These tests run in
// the real Playwright Chromium with the Pixel 7 device descriptor and
// take screenshot baselines that lock the user-visible outcomes V1-V3,
// V5-V7. (V4 lives in sterk; V8 is being fixed in parallel.)
//
// First run: `npx playwright test test/visual.spec.cjs --update-snapshots`
// to generate baselines; commit the resulting `*.png` files. Subsequent
// runs compare against the committed baselines.
//
// Run via: `make test-visual`.

const { test, expect, devices } = require('@playwright/test');
const { execSync } = require('child_process');

const BASE = process.env.MOBUX_URL || 'https://localhost:5151';
const USER = process.env.MOBUX_USER || '';
const PASS = process.env.MOBUX_PASS || '';
const AUTH = USER && PASS ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : null;
const SESSION = process.env.MOBUX_TEST_SESSION || 'mobux-visual';

const TMUX_CMD = process.env.MOBUX_TEST_TMUX || 'tmux -L mobux-test';
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || '/tmp/mobux-smoke/home';
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = (args) => execSync(`${TMUX_CMD} ${args}`, { stdio: 'pipe' });

// Pixel-diff threshold. Tight enough to catch real regressions
// (text rendering offsets, missing rows, off-by-one rebuilds) but
// loose enough to absorb subpixel font hinting jitter that Chromium
// sometimes produces on different host machines.
const DIFF = { maxDiffPixelRatio: 0.02 };

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
  // Pixel 7 is the design target; lock the device descriptor here so
  // these tests behave the same regardless of which project the runner
  // launches them under. (playwright.config.cjs already sets Pixel 7
  // for the `mobile` project — this is belt-and-braces against config
  // drift.)
  ...devices['Pixel 7'],
});

test.beforeAll(() => {
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
  // Deterministic prompt.
  tmux(`send-keys -t ${SESSION} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${SESSION} "clear" Enter`);
  execSync('sleep 0.3');
});

test.afterAll(() => {
  try { tmux(`kill-session -t ${SESSION}`); } catch (_) {}
});

// ── Boot helper ────────────────────────────────────────────────────
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
  // Let the initial resize() round-trip settle so the first paint
  // reflects the agreed-upon cols/rows.
  await page.waitForTimeout(500);
}

// Drive a deterministic command sequence through the real PTY pipe,
// then wait for its output to appear in the visible buffer. We use
// `clear` + a controlled printf so the baseline isn't polluted by
// whatever the shell wrote on connect.
async function seedSteadyTerminal(page) {
  const marker = 'VISUAL_STEADY_OK';
  await page.evaluate(() => window.__mobuxView.send('clear\r'));
  await page.waitForTimeout(200);
  await page.evaluate((m) => window.__mobuxView.send(`printf 'hello\\nworld\\n${m}\\n'\r`), marker);
  await page.waitForFunction((m) => {
    const t = document.getElementById('terminal');
    return (t?.innerText || '').includes(m);
  }, marker, { timeout: 8000 });
  // One extra beat so the last-line cursor settles in the same column
  // each run (avoids a 1-px cursor blink diff in the baseline).
  await page.waitForTimeout(300);
}

// ── Android soft-keyboard simulation ───────────────────────────────
//
// Real Android Chrome behaviour: when the OSK opens, `window.innerHeight`
// stays at the full layout viewport, but `visualViewport.height` shrinks
// (and `visualViewport.offsetTop` may move). mobux's input-bar.js reads
// those two values directly to size .term-body.
//
// In Playwright/Chromium we don't have a soft keyboard, but we DO have a
// real `visualViewport`. Approach:
//   1. Stub `visualViewport.height` getter to return a shrunken value
//      (55% of the layout height).
//   2. Dispatch the `resize` event on visualViewport so input-bar.js
//      and terminal-core.js pick up the change through their normal
//      listeners — no test-only code path in production.
//   3. Wait a frame for the rAF-coalesced layout to settle.
//
// CAVEAT [needs confirmation]: this approximates real-device behaviour
// because we don't simulate the offsetTop change Android sometimes
// emits (the "scroll into view" path Chrome takes for input focus).
// If V2 ever fails on a real device but passes here, the stub is the
// first place to look.
async function simulateKeyboardUp(page) {
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Stash the prototype's true accessors once. Restoring later means
    // re-installing them as own-property accessors that delegate to the
    // prototype — `delete vv.height` would otherwise unmask the
    // prototype property which Chromium reports as the *layout* height
    // (not the current visual height) after our perturbation.
    if (!window.__vvOriginal) {
      const proto = Object.getPrototypeOf(vv);
      const hDesc = Object.getOwnPropertyDescriptor(proto, 'height');
      const oDesc = Object.getOwnPropertyDescriptor(proto, 'offsetTop');
      window.__vvOriginal = {
        h: hDesc && hDesc.get ? hDesc.get.bind(vv) : null,
        o: oDesc && oDesc.get ? oDesc.get.bind(vv) : null,
      };
    }
    const layoutH = window.innerHeight;
    const newH = Math.floor(layoutH * 0.55);
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () => newH,
    });
    Object.defineProperty(vv, 'offsetTop', {
      configurable: true,
      get: () => 0,
    });
    vv.dispatchEvent(new Event('resize'));
  });
  // Let input-bar.js dispatch its synchronous `resize`, then let the
  // rAF-coalesced ResizeObserver in sterk settle.
  await page.waitForTimeout(50);
}

async function simulateKeyboardDown(page) {
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const orig = window.__vvOriginal;
    // Re-install accessors that delegate to the saved prototype
    // getters. This is the only safe way to restore — `delete` on a
    // configurable own getter unmasks the prototype but in some
    // Chromium versions the prototype getter returns a stale cached
    // height after a perturbation.
    if (orig && orig.h) {
      Object.defineProperty(vv, 'height', { configurable: true, get: orig.h });
    }
    if (orig && orig.o) {
      Object.defineProperty(vv, 'offsetTop', { configurable: true, get: orig.o });
    }
    // Sync body height back so the post-restore frame matches the
    // pre-keyboard layout exactly.
    document.body.style.height = '';
    vv.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(50);
}

// Ensure input bar is visible (for V2/V3 we want the ribbon on-screen
// because that's the part the keyboard usually pushes against).
async function showInputBar(page) {
  await page.evaluate(() => {
    const bar = document.getElementById('inputBar');
    if (bar) bar.classList.remove('hidden');
  });
}

// ── V1: steady terminal ────────────────────────────────────────────
test('V1 — steady terminal renders fixed PTY output', async ({ page }) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);
  await expect(page).toHaveScreenshot('v1-steady.png', DIFF);
});

// ── V2: keyboard up ────────────────────────────────────────────────
test('V2 — soft keyboard up: last row visible above input ribbon', async ({ page }) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);
  await showInputBar(page);
  await simulateKeyboardUp(page);

  // After the shrink, the renderer drops rows to fit the new viewport
  // and may scroll the last marker out of the rendered window. Drive
  // a scroll-to-bottom so the latest output sits just above the ribbon
  // — that's the user-visible contract (you tap the input, the cursor
  // line stays put).
  await page.evaluate(() => window.__mobuxView?.test?.scrollToBottom?.());
  await page.waitForTimeout(100);

  // Contract: the input ribbon does not cover the last terminal row.
  // Compare DOM rects rather than the renderer's text content (sterk's
  // Ace renderer virtualizes rows out of the DOM once they leave the
  // visible window).
  const layout = await page.evaluate(() => {
    const bar = document.getElementById('inputBar');
    const term = document.getElementById('terminal');
    const termRect = term.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    return {
      termBottom: termRect.bottom,
      barTop: barRect.top,
      termHeight: termRect.height,
      barHidden: bar.classList.contains('hidden'),
    };
  });
  expect(layout.barHidden, 'input bar must be visible').toBe(false);
  expect(layout.termHeight, 'terminal must retain non-trivial height').toBeGreaterThan(40);
  // Terminal area must end at-or-above the input ribbon (no overlap).
  expect(layout.termBottom, 'terminal must not overlap the input ribbon').toBeLessThanOrEqual(layout.barTop + 1);

  await expect(page).toHaveScreenshot('v2-keyboard-up.png', DIFF);
});

// ── V3: keyboard cycle ─────────────────────────────────────────────
test('V3 — keyboard up → type → keyboard down restores layout', async ({ page }) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);
  await showInputBar(page);

  await simulateKeyboardUp(page);
  // Type 3 chars into the visible input field — exercises the path
  // the user takes (focused input, keys arriving while OSK up).
  await page.evaluate(() => {
    const input = document.getElementById('mobileInput');
    if (input) {
      input.value = 'abc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.waitForTimeout(50);

  await simulateKeyboardDown(page);
  // Clear the input we just typed so the baseline is comparable to V1.
  await page.evaluate(() => {
    const input = document.getElementById('mobileInput');
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  // After restore, drive a `scrollToBottom` so the renderer parks at
  // the same y as a fresh boot. Without this the post-cycle baseline
  // can land on an intermediate scroll y from the keyboard-up shrink.
  await page.evaluate(() => window.__mobuxView?.test?.scrollToBottom?.());
  // Two extra frames for the rAF-coalesced ResizeObserver in sterk to
  // settle, then one more for the next paint.
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot('v3-keyboard-cycle.png', DIFF);
});

// ── V5: reader-view toggle ─────────────────────────────────────────
test('V5 — reader-view toggle: on then off leaves no ghost', async ({ page }) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);

  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 4000 });
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot('v5-reader-on.png', DIFF);

  await page.evaluate(() => window.__mobuxView.swap('xterm'));
  await page.waitForFunction(() => {
    const t = document.getElementById('terminal');
    return t && !t.classList.contains('hidden');
  }, { timeout: 4000 });
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot('v5-reader-off.png', DIFF);
});

// ── V6: theme swap (4 baselines) ───────────────────────────────────
// Each theme reloads with `localStorage['mobux:theme']` pre-seeded
// so sterk picks up the matching palette at construction time. We
// assert two things:
//   1. DOM-level — sterk injects a CSS rule with the theme's palette
//      colour for `.sterk-fg-2` (the canonical green slot). This proves
//      the localStorage → terminal-core.js wiring works and is the
//      thing that would break if a future refactor moved theme reads
//      somewhere new.
//   2. Visual — a screenshot baseline of the seeded ANSI rainbow strip.
//      Today these baselines may all look identical because sterk's
//      injected `.ace_editor .sterk-fg-N` selectors don't match Ace's
//      `ace_sterk-fg-N` class form (Ace prepends `ace_` to user class
//      names). The DOM assertion above guards the wiring; the
//      screenshot will start diverging the moment sterk fixes the
//      selector. [needs confirmation]: this is a known sterk gap to
//      flag back to @kattebak/sterk maintainers.
const THEMES = [
  { id: 'tomorrow-night-soft', greenHex: '#b5bd68' },
  { id: 'gruvbox-dark-soft',  greenHex: '#98971a' },
  { id: 'nord',               greenHex: '#a3be8c' },
  { id: 'solarized-dark',     greenHex: '#859900' },
];

async function seedThemedTerminal(page) {
  await page.evaluate(() => window.__mobuxView.send('clear\r'));
  await page.waitForTimeout(150);
  // Direct injection into the renderer keeps the content byte-stable
  // regardless of shell quoting — the baseline only diffs on palette
  // colour, not on shell-escape rendering.
  const seq =
    '\x1b[31m█ red\x1b[0m \x1b[32m█ green\x1b[0m \x1b[33m█ yellow\x1b[0m \x1b[34m█ blue\x1b[0m\n' +
    '\x1b[35m█ magenta\x1b[0m \x1b[36m█ cyan\x1b[0m \x1b[37m█ white\x1b[0m\n' +
    '\x1b[91m█ br-red\x1b[0m \x1b[92m█ br-green\x1b[0m \x1b[94m█ br-blue\x1b[0m\n' +
    'plain default-attr line\n';
  await page.evaluate((s) => window.__mobuxView.test.inject(s), seq);
  await page.waitForFunction(
    () => (document.getElementById('terminal')?.innerText || '').includes('br-blue'),
    { timeout: 4000 },
  );
  await page.waitForTimeout(200);
}

for (const { id: themeId, greenHex } of THEMES) {
  test(`V6 — theme ${themeId}`, async ({ page }) => {
    // Seed the theme BEFORE the bundle reads localStorage at boot —
    // sterk picks its palette at construction time (terminal-core.js).
    await page.addInitScript((id) => {
      try { localStorage.setItem('mobux:theme', id); } catch (_) {}
    }, themeId);
    await bootTerminal(page);
    await seedThemedTerminal(page);

    // DOM: the injected sterk stylesheet must carry this theme's
    // palette[2] (green slot) on the `.sterk-fg-2` rule.
    const ruleColor = await page.evaluate(() => {
      for (const style of document.querySelectorAll('style')) {
        const m = style.textContent.match(/\.sterk-fg-2 \{ color: (#[0-9a-fA-F]{6})/);
        if (m) return m[1].toLowerCase();
      }
      return null;
    });
    expect(ruleColor, 'sterk must inject palette[2] for the selected theme').toBe(greenHex.toLowerCase());

    await expect(page).toHaveScreenshot(`v6-theme-${themeId}.png`, DIFF);
  });
}

// ── V7: speaker icon ───────────────────────────────────────────────
test('V7 — reader speaker icon toggles rb-speaking on click', async ({ page }) => {
  await bootTerminal(page);

  // Switch to reader first, then inject text directly into sterk. The
  // smoke spec proves the reader picks up `__mobuxView.test.inject`
  // bytes deterministically; going through the real PTY adds shell
  // prompt noise that the reader tokenizer groups into separate
  // prompt blocks (which don't get speaker icons).
  await page.evaluate(() => window.__mobuxView.swap('reader'));
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r && !r.classList.contains('hidden');
  }, { timeout: 4000 });
  await page.waitForTimeout(200);

  await page.evaluate(() => window.__mobuxView.test.inject(
    'reader speaker line one\nreader speaker line two\nreader speaker line three\n',
  ));
  // Reader auto-sticky-to-bottom would park the inner transform at
  // the trailing blank lines (post-prompt fill). Force scroll to top
  // so the freshly-injected rb-text bubble lands at a known viewport
  // position regardless of buffer trailing-state.
  await page.evaluate(() => window.__mobuxView.test.readerForceScrollTop?.());
  await page.waitForTimeout(150);

  // Stub speechSynthesis so the test doesn't actually talk and so the
  // utterance doesn't auto-end before we can assert on the class.
  await page.evaluate(() => {
    window.speechSynthesis.speak = () => {};
    window.speechSynthesis.cancel = () => {};
  });

  // Find a text-bubble with a speaker icon, click it, assert the class.
  await page.waitForFunction(() => {
    return document.querySelector('#reader .rb-text .rb-speaker, #reader .rb-text .rb-bubble .rb-speaker');
  }, { timeout: 4000 });

  const result = await page.evaluate(() => {
    // Prefer a bubble-attached speaker (matches the typical case where
    // consecutive text lines fuse). Fall back to a naked-line speaker.
    const icon =
      document.querySelector('#reader .rb-text .rb-bubble .rb-speaker') ||
      document.querySelector('#reader .rb-text .rb-speaker');
    if (!icon) return { found: false };
    icon.click();
    const bubble = icon.closest('.rb-bubble') || icon.closest('.rb-text');
    return {
      found: true,
      iconSpeaking: icon.classList.contains('rb-speaking'),
      bubbleRect: bubble ? bubble.getBoundingClientRect().toJSON() : null,
    };
  });

  expect(result.found, 'rb-speaker icon must exist on a text bubble').toBe(true);
  expect(result.iconSpeaking, 'icon gains rb-speaking class on click').toBe(true);

  // Visual lock on the speaking bubble.
  expect(result.bubbleRect).toBeTruthy();
  const clip = {
    x: Math.max(0, Math.floor(result.bubbleRect.x)),
    y: Math.max(0, Math.floor(result.bubbleRect.y)),
    width: Math.ceil(result.bubbleRect.width),
    height: Math.ceil(result.bubbleRect.height),
  };
  await expect(page).toHaveScreenshot('v7-speaker-bubble.png', { ...DIFF, clip });
});
