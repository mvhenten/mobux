// Visual regression suite — locks pixel-level rendering on the Pixel 7
// emulated viewport. Headless tests (jsdom/happy-dom) silently passed
// through the incident at #81 because their ResizeObserver/visualViewport
// stubs don't match real Android Chrome semantics. These tests run in
// the real Playwright Chromium with the Pixel 7 device descriptor and
// take screenshot baselines that lock the user-visible outcomes.
//
// Revived from #84 against the current SPA-only UI: `/s/<name>` (the
// classic Rust-rendered terminal page) now 307s to `/app#/s/<name>` —
// `page.goto` follows the redirect transparently, so V1/V2/V3/V5 keep
// exercising the real boot path unchanged, but now render the Preact
// TerminalIsland (which mirrors the old markup, plus the reload/bug-report
// ribbon buttons from #189/#191). V8-V10 cover the surfaces that shipped
// since #84 went stale: the native-mobile settings redesign (#192), the
// ribbon's new controls, and the fail-hard error page (#190).
//
// V6 (theme x4) and V7 (reader speaker) stay `test.skip` — CI-only
// "Clipped area is either empty or outside the resulting image" failure,
// tracked separately in #113. Not this suite's job to fix.
//
// First run / after a deliberate visual change:
//   make test-visual-update
// to regenerate baselines; commit the resulting `*.png` files. Subsequent
// runs (`make test-visual`, CI's default) compare against the committed
// baselines in strict mode.
//
// Run via: `make test-visual`.

const { test, expect } = require("./fixtures.cjs");
const { devices } = require("@playwright/test");
const { createTmuxRunner } = require("./lib/tmux.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const APP = `${BASE}/app`;
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const SESSION = process.env.MOBUX_TEST_SESSION || "mobux-visual";

// Same tmux-safety helper the rest of the suite uses (issue #183/#184) —
// strips inherited $TMUX/$TMUX_PANE and refuses to run against anything
// that isn't provably the isolated smoke socket.
const tmux = createTmuxRunner("mobux-test");
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";

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
  // for every project — this is belt-and-braces against config drift.)
  ...devices["Pixel 7"],
});

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(
    `new-session -d -s ${SESSION} -e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME} "bash --norc --noprofile"`,
  );
  // Deterministic prompt.
  tmux(`send-keys -t ${SESSION} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${SESSION} "clear" Enter`);
});

test.afterAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
});

// ── Boot helper ────────────────────────────────────────────────────
async function bootTerminal(page) {
  await page.goto(`${BASE}/s/${SESSION}`, { waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      if (!t || t.classList.contains("hidden")) return false;
      const r = t.getBoundingClientRect();
      return r.width > 50 && r.height > 50;
    },
    { timeout: 8000 },
  );
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
  const marker = "VISUAL_STEADY_OK";
  await page.evaluate(() => window.__mobuxView.send("clear\r"));
  await page.waitForTimeout(200);
  await page.evaluate(
    (m) => window.__mobuxView.send(`printf 'hello\\nworld\\n${m}\\n'\r`),
    marker,
  );
  await page.waitForFunction(
    (m) => {
      const t = document.getElementById("terminal");
      return (t?.innerText || "").includes(m);
    },
    marker,
    { timeout: 8000 },
  );
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
      const hDesc = Object.getOwnPropertyDescriptor(proto, "height");
      const oDesc = Object.getOwnPropertyDescriptor(proto, "offsetTop");
      window.__vvOriginal = {
        h: hDesc && hDesc.get ? hDesc.get.bind(vv) : null,
        o: oDesc && oDesc.get ? oDesc.get.bind(vv) : null,
      };
    }
    const layoutH = window.innerHeight;
    const newH = Math.floor(layoutH * 0.55);
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () => newH,
    });
    Object.defineProperty(vv, "offsetTop", {
      configurable: true,
      get: () => 0,
    });
    vv.dispatchEvent(new Event("resize"));
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
      Object.defineProperty(vv, "height", { configurable: true, get: orig.h });
    }
    if (orig && orig.o) {
      Object.defineProperty(vv, "offsetTop", {
        configurable: true,
        get: orig.o,
      });
    }
    // Sync body height back so the post-restore frame matches the
    // pre-keyboard layout exactly.
    document.body.style.height = "";
    vv.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(50);
}

// Ensure input bar is visible (for V2/V3/V9 we want the ribbon on-screen
// because that's the part the keyboard usually pushes against).
async function showInputBar(page) {
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    if (bar) bar.classList.remove("hidden");
  });
}

// ── V1: steady terminal ────────────────────────────────────────────
test("V1 — steady terminal renders fixed PTY output", async ({ page }) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);
  await expect(page).toHaveScreenshot("v1-steady.png", DIFF);
});

// ── V2: keyboard up ────────────────────────────────────────────────
test("V2 — soft keyboard up: last row visible above input ribbon", async ({
  page,
}) => {
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
    const bar = document.getElementById("inputBar");
    const term = document.getElementById("terminal");
    const termRect = term.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    return {
      termBottom: termRect.bottom,
      barTop: barRect.top,
      termHeight: termRect.height,
      barHidden: bar.classList.contains("hidden"),
    };
  });
  expect(layout.barHidden, "input bar must be visible").toBe(false);
  expect(
    layout.termHeight,
    "terminal must retain non-trivial height",
  ).toBeGreaterThan(40);
  // Terminal area must end at-or-above the input ribbon (no overlap).
  expect(
    layout.termBottom,
    "terminal must not overlap the input ribbon",
  ).toBeLessThanOrEqual(layout.barTop + 1);

  await expect(page).toHaveScreenshot("v2-keyboard-up.png", DIFF);
});

// ── V3: keyboard cycle ─────────────────────────────────────────────
test("V3 — keyboard up → type → keyboard down restores layout", async ({
  page,
}) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);
  await showInputBar(page);

  await simulateKeyboardUp(page);
  // Type 3 chars into the visible input field — exercises the path
  // the user takes (focused input, keys arriving while OSK up).
  await page.evaluate(() => {
    const input = document.getElementById("inputText");
    if (input) {
      input.value = "abc";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.waitForTimeout(50);

  await simulateKeyboardDown(page);
  // Clear the input we just typed so the baseline is comparable to V1.
  await page.evaluate(() => {
    const input = document.getElementById("inputText");
    if (input) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  // After restore, drive a `scrollToBottom` so the renderer parks at
  // the same y as a fresh boot. Without this the post-cycle baseline
  // can land on an intermediate scroll y from the keyboard-up shrink.
  await page.evaluate(() => window.__mobuxView?.test?.scrollToBottom?.());
  // Two extra frames for the rAF-coalesced ResizeObserver in sterk to
  // settle, then one more for the next paint.
  await page.waitForTimeout(300);

  await expect(page).toHaveScreenshot("v3-keyboard-cycle.png", DIFF);
});

// ── V5: reader-view toggle ─────────────────────────────────────────
test("V5 — reader-view toggle: on then off leaves no ghost", async ({
  page,
}) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);

  await page.evaluate(() => window.__mobuxView.swap("reader"));
  await page.waitForFunction(
    () => {
      const r = document.getElementById("reader");
      return r && !r.classList.contains("hidden");
    },
    { timeout: 4000 },
  );
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot("v5-reader-on.png", DIFF);

  await page.evaluate(() => window.__mobuxView.swap("xterm"));
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && !t.classList.contains("hidden");
    },
    { timeout: 4000 },
  );
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot("v5-reader-off.png", DIFF);
});

// ── V6: theme swap (4 baselines) ───────────────────────────────────
// Each theme reloads with `localStorage['mobux:theme']` pre-seeded
// so the renderer picks up the matching palette at construction time.
// We assert two things:
//   1. DOM-level — the renderer must carry this theme's palette[2]
//      (the green slot). Both backends expose it differently:
//        - sterk: emits a `<style id="sterk-theme">` block that defines
//          `--sterk-palette-2: <hex>` on the `.sterk` root.
//        - xterm: applyTheme() (themes.js) writes the resolved palette
//          onto `window.__xterm.options.theme.green`.
//      Both prove the localStorage → terminal-core.js wiring works and
//      would break if a future refactor moved theme reads somewhere new.
//   2. Visual — a screenshot baseline of the seeded ANSI rainbow strip
//      per theme per renderer.
const THEMES = [
  { id: "tomorrow-night-soft", greenHex: "#b5bd68" },
  { id: "gruvbox-dark-soft", greenHex: "#98971a" },
  { id: "nord", greenHex: "#a3be8c" },
  { id: "solarized-dark", greenHex: "#859900" },
];

async function seedThemedTerminal(page) {
  await page.evaluate(() => window.__mobuxView.send("clear\r"));
  await page.waitForTimeout(150);
  // Direct injection into the renderer keeps the content byte-stable
  // regardless of shell quoting — the baseline only diffs on palette
  // colour, not on shell-escape rendering.
  const seq =
    "\x1b[31m█ red\x1b[0m \x1b[32m█ green\x1b[0m \x1b[33m█ yellow\x1b[0m \x1b[34m█ blue\x1b[0m\n" +
    "\x1b[35m█ magenta\x1b[0m \x1b[36m█ cyan\x1b[0m \x1b[37m█ white\x1b[0m\n" +
    "\x1b[91m█ br-red\x1b[0m \x1b[92m█ br-green\x1b[0m \x1b[94m█ br-blue\x1b[0m\n" +
    "plain default-attr line\n";
  await page.evaluate((s) => window.__mobuxView.test.inject(s), seq);
  await page.waitForFunction(
    () =>
      (document.getElementById("terminal")?.innerText || "").includes(
        "br-blue",
      ),
    { timeout: 4000 },
  );
  await page.waitForTimeout(200);
}

for (const { id: themeId, greenHex } of THEMES) {
  // TODO(mvhenten/mobux#113): V6 fails on CI with
  // "Clipped area is either empty or outside the resulting image" —
  // the bounding box for the screenshot clip is empty/off-screen on
  // CI but renders fine locally. Skipped until that race is fixed.
  test.skip(`V6 — theme ${themeId}`, async ({ page }, testInfo) => {
    // Seed the theme BEFORE the bundle reads localStorage at boot —
    // sterk picks its palette at construction time (terminal-core.js),
    // xterm picks it up via applyTheme() called synchronously from
    // terminal.js after construction.
    await page.addInitScript((id) => {
      try {
        localStorage.setItem("mobux:theme", id);
      } catch (_) {}
    }, themeId);
    await bootTerminal(page);
    await seedThemedTerminal(page);

    // DOM: assert palette[2] (green slot) made it into the active
    // renderer. Each backend exposes it differently — see the comment
    // block above the THEMES list.
    const renderer = testInfo.project.use.renderer;
    const ruleColor = await page.evaluate((r) => {
      if (r === "sterk") {
        // sterk's injected <style id="sterk-theme"> sets CSS variables
        // on the `.sterk` root. Match `--sterk-palette-2: #rrggbb`.
        for (const style of document.querySelectorAll("style")) {
          const m = style.textContent.match(
            /--sterk-palette-2:\s*(#[0-9a-fA-F]{6})/,
          );
          if (m) return m[1].toLowerCase();
        }
        return null;
      }
      // xterm: themes.js writes the green slot onto __xterm.options.theme.green.
      const c = window.__xterm?.options?.theme?.green;
      return typeof c === "string" ? c.toLowerCase() : null;
    }, renderer);
    expect(
      ruleColor,
      `${renderer} must carry palette[2] for the selected theme`,
    ).toBe(greenHex.toLowerCase());

    await expect(page).toHaveScreenshot(`v6-theme-${themeId}.png`, DIFF);
  });
}

// ── V7: speaker icon ───────────────────────────────────────────────
// TODO(mvhenten/mobux#113): V7 hits the same clipped-area-empty error
// as V6 on CI (passes locally). Skipped until #113 is fixed.
test.skip("V7 — reader speaker icon toggles rb-speaking on click", async ({
  page,
}) => {
  await bootTerminal(page);

  // Switch to reader first, then inject text directly into sterk. The
  // smoke spec proves the reader picks up `__mobuxView.test.inject`
  // bytes deterministically; going through the real PTY adds shell
  // prompt noise that the reader tokenizer groups into separate
  // prompt blocks (which don't get speaker icons).
  await page.evaluate(() => window.__mobuxView.swap("reader"));
  await page.waitForFunction(
    () => {
      const r = document.getElementById("reader");
      return r && !r.classList.contains("hidden");
    },
    { timeout: 4000 },
  );
  await page.waitForTimeout(200);

  await page.evaluate(() =>
    window.__mobuxView.test.inject(
      "reader speaker line one\nreader speaker line two\nreader speaker line three\n",
    ),
  );
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
  await page.waitForFunction(
    () => {
      return document.querySelector(
        "#reader .rb-text .rb-speaker, #reader .rb-text .rb-bubble .rb-speaker",
      );
    },
    { timeout: 4000 },
  );

  const result = await page.evaluate(() => {
    // Prefer a bubble-attached speaker (matches the typical case where
    // consecutive text lines fuse). Fall back to a naked-line speaker.
    const icon =
      document.querySelector("#reader .rb-text .rb-bubble .rb-speaker") ||
      document.querySelector("#reader .rb-text .rb-speaker");
    if (!icon) return { found: false };
    icon.click();
    const bubble = icon.closest(".rb-bubble") || icon.closest(".rb-text");
    return {
      found: true,
      iconSpeaking: icon.classList.contains("rb-speaking"),
      bubbleRect: bubble ? bubble.getBoundingClientRect().toJSON() : null,
    };
  });

  expect(result.found, "rb-speaker icon must exist on a text bubble").toBe(
    true,
  );
  expect(result.iconSpeaking, "icon gains rb-speaking class on click").toBe(
    true,
  );

  // Visual lock on the speaking bubble.
  expect(result.bubbleRect).toBeTruthy();
  const clip = {
    x: Math.max(0, Math.floor(result.bubbleRect.x)),
    y: Math.max(0, Math.floor(result.bubbleRect.y)),
    width: Math.ceil(result.bubbleRect.width),
    height: Math.ceil(result.bubbleRect.height),
  };
  await expect(page).toHaveScreenshot("v7-speaker-bubble.png", {
    ...DIFF,
    clip,
  });
});

// ── V8: settings redesign (#192) ────────────────────────────────────
//
// Native-mobile row list: edge-to-edge `.settings-row`s, no card chrome,
// plus the Build card's app version / server hash / frontend hash. The
// three build-identity values change on every build, so they're masked
// rather than pixel-locked — this baseline is about row layout, not the
// literal hash text.
test("V8 — settings page renders the native-mobile row layout", async ({
  page,
}) => {
  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });

  await expect(page.locator("#update h2")).toHaveText("Software update");
  await expect(page.locator("#build-info h2")).toHaveText("Build");
  await expect(page.locator("section#install-app")).toBeVisible();

  // Let async card content resolve so the baseline never captures a
  // transient "…" placeholder frame.
  await page.waitForFunction(
    () => document.querySelectorAll("#theme-picker option").length > 0,
    { timeout: 6000 },
  );
  await expect(
    page.locator(
      '#shell-integration .shell-card[data-shell="bash"] [data-role="state"]',
    ),
  ).not.toHaveText("…", { timeout: 6000 });
  await expect(page.locator("#update .settings-value").first()).not.toHaveText(
    "…",
    { timeout: 8000 },
  );
  await expect(page.locator("#buildServerHash")).not.toHaveText("…", {
    timeout: 6000,
  });
  await expect(page.locator("#buildFeHash")).not.toHaveText("…", {
    timeout: 6000,
  });
  await page.waitForTimeout(200);

  await expect(page).toHaveScreenshot("v8-settings-rows.png", {
    ...DIFF,
    fullPage: true,
    mask: [
      page.locator("#updateCurrent"),
      page.locator("#updateLatest"),
      page.locator("#buildVersion"),
      page.locator("#buildServerHash"),
      page.locator("#buildFeHash"),
    ],
  });
});

// ── V9: ribbon reload + bug-report controls (#189, #191) ─────────────
test("V9 — ribbon exposes reload and bug-report controls", async ({ page }) => {
  await bootTerminal(page);
  await seedSteadyTerminal(page);
  await showInputBar(page);

  const ribbon = page.locator("#inputRibbon");
  await expect(ribbon).toBeVisible();
  await expect(page.locator("#reloadBtn")).toBeVisible();
  await expect(page.locator("#reportBugBtn")).toBeVisible();

  const box = await ribbon.boundingBox();
  expect(box).toBeTruthy();
  const clip = {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
  };
  await expect(page).toHaveScreenshot("v9-ribbon-controls.png", {
    ...DIFF,
    clip,
  });
});

// ── V10: fail-hard error page (#190) ──────────────────────────────────
//
// Drives the same uncaught-`ApiError`-shaped-rejection path spa.spec.cjs
// verifies functionally, and locks the full-screen takeover's layout.
// The stack trace is real (JS-engine generated) and not fully
// deterministic across environments, so it's masked; the error summary
// and body are test-authored strings and stay pixel-locked.
test("V10 — uncaught API error fails hard with the full-screen error page", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await expect(page.locator("#sessionList .session-item").first()).toBeVisible({
    timeout: 8000,
  });

  await page.evaluate(() => {
    const err = new Error("GET /api/whatever -> 500");
    err.name = "ApiError";
    err.method = "GET";
    err.url = "/api/whatever";
    err.status = 500;
    err.statusText = "Internal Server Error";
    err.body = "boom: something exploded server-side";
    Promise.reject(err);
  });

  const errorPage = page.locator(".fatal-error-page");
  await expect(errorPage).toBeVisible({ timeout: 5000 });
  await expect(errorPage.locator("h1")).toHaveText("Something broke");
  await page.waitForTimeout(200);

  await expect(page).toHaveScreenshot("v10-fatal-error-page.png", {
    ...DIFF,
    fullPage: true,
    // The Stack <details> is open by default and its content is a real
    // captured JS stack trace — mask it, everything else on the page is
    // test-authored and deterministic.
    mask: [page.locator(".fatal-error-block").nth(1)],
  });
});
