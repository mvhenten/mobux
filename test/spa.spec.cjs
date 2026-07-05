// SPA coverage — the modern Preact/Wouter UI served by the Rust binary at
// `/app` (web/spa → web/static/spa, embedded via RustEmbed, served by
// serve_spa_index + serve_static). The old Rust-rendered UI at `/` is covered
// by smoke.spec.cjs / critical-path.spec.cjs; this spec is the SPA's own
// CI safety net so `/app` can never silently regress to feature parity gaps.
//
// Runs against the SAME isolated smoke instance as the rest of the suite
// (MOBUX_URL, basic auth from MOBUX_USER/MOBUX_PASS), so it never touches the
// live :5151 server or the live sqlite DB. The smoke harness builds the SPA
// via `make build` before it starts, so `/app` is live.
//
// Routing: the SPA uses hash locations under the /app route
// (`/app#/`, `/app#/settings`, `/app#/install`, `/app#/s/<name>`), parallel to
// the Rust pages. Modeled on web/spa/verify.prod.spec.mjs, adapted to the
// standard fixtures + smoke harness and extended with the full session
// create → terminal → rename → kill lifecycle.

const { test, expect } = require("./fixtures.cjs");
const { execSync } = require("child_process");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const APP = `${BASE}/app`;
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;

// Dedicated tmux server/session, identical convention to smoke.spec.cjs, so
// SPA session ops drive the smoke instance's tmux without colliding with the
// host's default tmux server.
const TMUX_CMD = process.env.MOBUX_TEST_TMUX || "tmux -L mobux-test";
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = (args) => execSync(`${TMUX_CMD} ${args}`, { stdio: "pipe" });

// Unique session names per run so the create/rename/kill lifecycle never
// collides with a leftover from a previous run or the smoke seed session.
const SEED = `spa-seed-${process.pid}`;

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  // A guaranteed session so Home always has a row to render even on a fresh
  // smoke instance, and so the terminal-island test has something to attach to
  // if the in-test create races tmux startup.
  try {
    tmux(`kill-session -t ${SEED}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SEED} ${SHELL_ENV} "bash --norc --noprofile"`);
  tmux(`send-keys -t ${SEED} "PS1='\\$ '" Enter`);
  tmux(`send-keys -t ${SEED} "clear" Enter`);
  execSync("sleep 0.3");
});

test.afterAll(() => {
  try {
    tmux(`kill-session -t ${SEED}`);
  } catch (_) {}
});

// ── app shell + home ────────────────────────────────────────────────────────

test("app route serves the SPA shell and Home lists sessions", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await expect(page.locator("#app")).toHaveCount(1);

  // Current header: `mobux` wordmark (home link), native host-select, gear button.
  // No old-style text tabs (.spa-nav / Home / Install tabs).
  await expect(page.locator(".app-wordmark")).toBeVisible();
  await expect(page.locator("select.host-select")).toBeVisible();
  await expect(
    page.locator('button.header-icon-btn[aria-label="Settings"]'),
  ).toBeVisible();

  // Explicitly assert old nav tabs are gone (regression guard).
  await expect(page.locator(".spa-nav")).toHaveCount(0);
  await expect(page.locator(".spa-nav a", { hasText: "Home" })).toHaveCount(0);
  await expect(page.locator(".spa-nav a", { hasText: "Install" })).toHaveCount(
    0,
  );

  // The seed session renders a row.
  await expect(page.locator("#sessionList .session-item").first()).toBeVisible({
    timeout: 8000,
  });
  const names = await page
    .locator("#sessionList .session-name")
    .allTextContents();
  expect(names.some((n) => n.trim() === SEED)).toBeTruthy();

  // Create FAB present.
  await expect(page.locator("#fabNew")).toBeVisible();
});

// ── session lifecycle: create → rename → kill, all via the SPA UI ───────────

// Reveal a row's hidden swipe action (rename/kill sit behind .session-item).
// Drives the same touch gesture a user would: swipe right (dir=1) to reveal
// rename, left (dir=-1) to reveal kill. Mirrors Home.jsx's swipe handler.
async function swipeReveal(page, rowName, dir) {
  await page.evaluate(
    ({ rowName, dir }) => {
      const row = document.querySelector(
        `#sessionList .swipe-row[data-name="${rowName}"]`,
      );
      const item = row.querySelector(".session-item");
      const rect = item.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x0 = rect.left + rect.width / 2;
      const mkTouch = (clientX) =>
        new Touch({ identifier: 0, target: item, clientX, clientY: y });
      const fire = (type, touches) =>
        item.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches }),
        );
      fire("touchstart", [mkTouch(x0)]);
      fire("touchmove", [mkTouch(x0 + dir * 90)]);
      // touchend reads currentX from the last move; touches list is empty.
      fire("touchend", []);
    },
    { rowName, dir },
  );
}

test("session lifecycle: create, rename, and kill through the SPA", async ({
  page,
}) => {
  const name = `spa-life-${process.pid}-${Date.now() % 100000}`;
  const renamed = `${name}-r`;

  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  // CREATE via the FAB dialog.
  await page.locator("#fabNew").click();
  await expect(page.locator("#newSessionDialog")).toBeVisible();
  await page.locator("#sessionName").fill(name);
  await page.locator("#newSessionForm .btn-create").click();
  const row = page.locator(`#sessionList .swipe-row[data-name="${name}"]`);
  await expect(row).toBeVisible({ timeout: 8000 });
  // Confirm the backend actually has it.
  let api = await page.evaluate(async () =>
    (await fetch("/api/sessions")).json(),
  );
  let list = (Array.isArray(api) ? api : api.sessions || []).map((s) =>
    typeof s === "string" ? s : s.name,
  );
  expect(list).toContain(name);

  // RENAME (prompt-driven) — swipe right to reveal, then accept the prompt.
  page.once("dialog", (d) => d.accept(renamed));
  await swipeReveal(page, name, 1);
  await row.locator(".rename-btn").click();
  await expect(
    page.locator(`#sessionList .swipe-row[data-name="${renamed}"]`),
  ).toBeVisible({ timeout: 8000 });
  api = await page.evaluate(async () => (await fetch("/api/sessions")).json());
  list = (Array.isArray(api) ? api : api.sessions || []).map((s) =>
    typeof s === "string" ? s : s.name,
  );
  expect(list).toContain(renamed);
  expect(list).not.toContain(name);

  // KILL (confirm-driven) — swipe left to reveal, then accept the confirm.
  page.once("dialog", (d) => d.accept());
  await swipeReveal(page, renamed, -1);
  await page
    .locator(`#sessionList .swipe-row[data-name="${renamed}"] .kill-btn`)
    .click();
  await expect(
    page.locator(`#sessionList .swipe-row[data-name="${renamed}"]`),
  ).toHaveCount(0, { timeout: 8000 });
  api = await page.evaluate(async () => (await fetch("/api/sessions")).json());
  list = (Array.isArray(api) ? api : api.sessions || []).map((s) =>
    typeof s === "string" ? s : s.name,
  );
  expect(list).not.toContain(renamed);
});

// ── terminal island: mounts + PTY WebSocket connects ───────────────────────

test("terminal island mounts and the PTY websocket connects", async ({
  page,
}) => {
  // Attach to the guaranteed seed session.
  const wsConnected = new Promise((resolve) => {
    page.on("websocket", (ws) => {
      if (ws.url().includes(`/ws/${encodeURIComponent(SEED)}`))
        resolve(ws.url());
    });
  });

  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  // Island scaffold present (the engine binds to #terminal).
  await expect(page.locator("#terminal")).toHaveCount(1);

  const wsUrl = await Promise.race([
    wsConnected,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("ws timeout")), 15000),
    ),
  ]);
  expect(wsUrl).toContain(`/ws/${encodeURIComponent(SEED)}`);

  // Engine actually rendered into the host (xterm/sterk attaches a child).
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );
});

// ── terminal island: fills the viewport on mount (no too-short PTY) ─────────
//
// Regression guard for the "terminal mounts too short" bug: the SPA wraps the
// engine in `.term-body-spa` under `#app`, and if that wrapper doesn't extend
// the old `body.term-body` full-height flex column all the way down, `#terminal`
// (flex:1; min-height:0) collapses to ~0 on mount. The backend sizes the PTY
// from the host clientHeight, so it ends up with ~13 rows: terminal + tmux
// status bar occupy only the top third and the bottom is dead black. Assert the
// host fills the viewport AND the PTY row count matches the available height, so
// a too-short initial terminal FAILS here.
test("terminal island fills the viewport on mount (correct PTY rows)", async ({
  page,
}) => {
  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  // Engine attached into the host.
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );

  // Give the post-mount resize (double-rAF + ResizeObserver) a beat to settle
  // the row count against the painted layout.
  await page.waitForTimeout(500);

  const geo = await page.evaluate(() => {
    const t = document.getElementById("terminal");
    const bar = document.getElementById("inputBar");
    const r = t.getBoundingClientRect();
    // On mobile the input bar (mic/ribbon) is revealed eagerly on mount
    // (see terminal.js's `ensureInputBar().reveal()`) and sits below the
    // terminal as a flex sibling, so it legitimately claims its own height
    // at the bottom of the viewport instead of the terminal.
    const barHeight =
      bar && !bar.classList.contains("hidden")
        ? bar.getBoundingClientRect().height
        : 0;
    return {
      hostTop: r.top,
      hostBottom: r.bottom,
      hostHeight: r.height,
      viewportHeight: window.innerHeight,
      barHeight,
      rows: window.__mobuxView?.test?.rows?.() ?? null,
    };
  });

  // The terminal host fills essentially the whole viewport above the (now
  // eagerly visible) input bar: it starts at the top (no SPA chrome on this
  // route) and its bottom reaches the input bar's top within a few px. A
  // too-short host (status bar stranded mid-screen) leaves a large gap and
  // fails this.
  expect(geo.hostTop).toBeLessThan(8);
  expect(geo.hostHeight).toBeGreaterThan(geo.viewportHeight * 0.85);
  expect(
    Math.abs(geo.viewportHeight - geo.barHeight - geo.hostBottom),
  ).toBeLessThan(8);

  // And the PTY actually got enough rows for that height. Derive an expected
  // minimum from the host height; the ~13-row bug (top third only) fails this.
  const minRows = Math.floor((geo.hostHeight / geo.viewportHeight) * 30);
  expect(geo.rows).toBeGreaterThanOrEqual(Math.max(20, minRows));
});

// ── loading splash: reveal-on-data vs the no-output fallback ────────────────
//
// Regression guard: #loadquote was removed ONLY by the first `data` event on
// the terminal core, so a session that's already sitting quietly at its
// prompt (no output on attach) left the splash up forever. terminal.js now
// also arms a fallback timer on the core's `open` event that calls the same
// (idempotent) scheduleReveal(), so a silent session still reveals promptly.
//
// Both tests stub `window.WebSocket` before navigation so the terminal
// core's `open`/`data` timing is deterministic instead of depending on real
// tmux/PTY redraw behaviour. Only the terminal cores construct a WebSocket
// (panes/history go over fetch), so this is otherwise transparent to the
// rest of the boot sequence.

function loadquoteGone(page) {
  return page.evaluate(() => {
    const el = document.getElementById("loadquote");
    if (!el || !el.parentNode) return true;
    return getComputedStyle(el).opacity === "0";
  });
}

function installFakeSocket(page, { emitDataAfterMs = null } = {}) {
  return page.addInitScript((emitDataAfterMs) => {
    class FakeSocket extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        this.binaryType = "blob";
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          if (emitDataAfterMs != null) {
            setTimeout(() => this.onmessage?.({ data: "$ " }), emitDataAfterMs);
          }
        }, 10);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.(new Event("close"));
      }
    }
    FakeSocket.CONNECTING = 0;
    FakeSocket.OPEN = 1;
    FakeSocket.CLOSING = 2;
    FakeSocket.CLOSED = 3;
    window.WebSocket = FakeSocket;
  }, emitDataAfterMs);
}

test("loading splash reveals on first data (unchanged data-triggered path)", async ({
  page,
}) => {
  await installFakeSocket(page, { emitDataAfterMs: 50 });

  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  await expect(page.locator("#loadquote")).toHaveCount(1);
  expect(await loadquoteGone(page)).toBe(false);

  // Data arrives ~60ms after connect — reveals almost immediately, long
  // before the no-output fallback (armed at 1.5s) could ever fire.
  await expect.poll(() => loadquoteGone(page), { timeout: 1000 }).toBe(true);
});

test("loading splash still clears via the fallback timer when a session emits no output on attach", async ({
  page,
}) => {
  // No `data` ever arrives on this fake socket — the quiet-shell-at-prompt
  // scenario the fallback exists for.
  await installFakeSocket(page);

  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  await expect(page.locator("#loadquote")).toHaveCount(1);
  // Still up right after "open" — the fallback hasn't fired yet, so a
  // chatty session's data-path reveal isn't being pre-empted.
  expect(await loadquoteGone(page)).toBe(false);

  // Only the fallback timer (armed on "open") can clear the splash now.
  await expect.poll(() => loadquoteGone(page), { timeout: 4000 }).toBe(true);
});

// ── control-key ribbon: horizontally scrollable by touch ────────────────────
//
// Regression guard for the "ribbon won't scroll sideways" bug. The control-key
// ribbon (^C, arrows, Tab, Esc, …) is wider than the viewport and must scroll
// horizontally by touch without wrapping. Assert it overflows (scrollWidth >
// clientWidth), is not wrapped (single row of buttons), is overflow-x:auto, and
// that programmatic scrollLeft actually moves it.
test("control-key ribbon is horizontally scrollable (not wrapped/clipped)", async ({
  page,
}) => {
  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator("#inputRibbon")).toHaveCount(1);

  // The mobile input bar is revealed automatically on boot (fix for the
  // "mic button completely gone on mobile" regression). Guard against the
  // bar still being hidden in the test environment by removing the class
  // explicitly so the geometry checks below are always reliable.
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    if (bar) bar.classList.remove("hidden");
  });
  await page.waitForTimeout(100);

  const ribbon = page.locator("#inputRibbon");
  const m = await ribbon.evaluate((el) => {
    const cs = getComputedStyle(el);
    // Single row of buttons → all buttons share the same offsetTop (not wrapped).
    const btns = [...el.querySelectorAll("button")];
    const tops = new Set(btns.map((b) => b.offsetTop));
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: cs.overflowX,
      flexWrap: cs.flexWrap,
      rowCount: tops.size,
      buttonCount: btns.length,
    };
  });

  // Overflows horizontally and the browser treats it as scrollable.
  expect(m.buttonCount).toBeGreaterThan(5);
  expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
  expect(["auto", "scroll"]).toContain(m.overflowX);
  expect(m.flexWrap).toBe("nowrap");
  // Not wrapped — every button sits on the same row.
  expect(m.rowCount).toBe(1);

  // Programmatic scrollLeft actually moves it (it's a real scroll container).
  const moved = await ribbon.evaluate((el) => {
    el.scrollLeft = 0;
    el.scrollLeft = 80;
    return el.scrollLeft;
  });
  expect(moved).toBeGreaterThan(0);
});

// ── regression: mic button is wired and opens the overlay ──────────────────
//
// After the SPA migration, input-bar.js imported input-actions.js via the
// absolute path /static/input-actions.js (likewise for telemetry.js and
// mic-overlay.js). Under Vite's dev proxy and certain static-file scenarios
// the absolute path resolution breaks the ES module import chain, leaving
// createDictateAction undefined and the mic button unwired — clicking it did
// nothing and the overlay never appeared. Fix: use relative paths (./…) so
// the imports resolve correctly in every context.
test("mic button opens the dictation overlay", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  // Wait for the engine to attach.
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );

  // Reveal the input bar exactly as a double-tap would.
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    if (bar) bar.classList.remove("hidden");
  });

  // Mic button must be visible (computed, not just present in DOM).
  const micBtn = page.locator("#micBtn");
  await expect(micBtn).toBeVisible({ timeout: 5000 });
  const bb = await micBtn.boundingBox();
  expect(bb).not.toBeNull();
  expect(bb.width).toBeGreaterThan(0);
  expect(bb.height).toBeGreaterThan(0);

  // Click the mic button — the overlay must appear regardless of whether
  // getUserMedia succeeds (headless has no mic, so it shows a fault overlay).
  await micBtn.click();
  await expect(page.locator("#mobux-mic-overlay")).toBeAttached({
    timeout: 5000,
  });

  // No JS module errors: a broken import chain leaves createDictateAction
  // undefined and throws a TypeError when the button is clicked.
  const moduleErrors = pageErrors.filter(
    (m) =>
      m.toLowerCase().includes("typeerror") ||
      m.toLowerCase().includes("is not a function") ||
      m.toLowerCase().includes("cannot read"),
  );
  expect(
    moduleErrors,
    `JS errors on mic click: ${moduleErrors.join("; ")}`,
  ).toHaveLength(0);
});

// ── regression: mic tap is observable even if the flow never starts ────────
//
// The dictation flow's first telemetry line used to fire deep inside
// startRecording(), so a tap that never reached the click handler (bad
// wiring, a dead listener) looked identical to a silent flow failure — no
// way to tell them apart from telemetry alone. mic.tap now logs at the very
// top of the click handler, before dictate.toggle() runs, closing that gap.
//
// Telemetry is a built-in, always-on channel (no MOBUX_DEV gate, no dev_mode
// mock needed here) — this smoke instance runs in normal mode and the POST
// still lands.
test("mic button click posts a mic.tap telemetry line", async ({ page }) => {
  const telemetryLines = [];
  await page.route(/\/api\/telemetry$/, async (route) => {
    telemetryLines.push(route.request().postData() || "");
    await route.fulfill({ status: 204, body: "" });
  });

  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    if (bar) bar.classList.remove("hidden");
  });

  await page.locator("#micBtn").click();

  await expect
    .poll(() => telemetryLines.some((line) => line.includes("mic.tap")), {
      timeout: 5000,
    })
    .toBe(true);
});

// ── regression: /api/telemetry must not 404 in normal (non-dev) mode ───────
//
// Telemetry used to be hard-gated behind MOBUX_DEV: the route 404'd unless
// dev mode was on. It's now an always-on diagnostic channel, so a POST must
// be accepted (204) against this smoke instance, which never sets MOBUX_DEV.
test("POST /api/telemetry is live without MOBUX_DEV", async ({ page }) => {
  const res = await page.request.post(`${BASE}/api/telemetry`, {
    data: "spa-spec-check",
    headers: { "content-type": "text/plain" },
  });
  expect(res.status()).toBe(204);
});

// ── telemetry overlay stays on-demand ───────────────────────────────────────
//
// Data collection (the POSTs above) is always on, but the on-screen overlay
// is still opt-in: only `?telemetry=1` (or the persisted localStorage
// toggle) renders it. A plain page load must not show it.
test("telemetry overlay only renders with ?telemetry=1", async ({ page }) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await expect(page.locator("#mobux-telemetry-overlay")).toHaveCount(0);

  await page.goto(`${APP}?telemetry=1#/`, { waitUntil: "networkidle" });
  await expect(page.locator("#mobux-telemetry-overlay")).toBeAttached({
    timeout: 5000,
  });
});

// ── mobile mic button: visible on mount + wired to dictation ────────────────
//
// Regression guard for the "mobile microphone button completely gone" bug
// introduced in v0.6.0 (SPA cutover). Before the fix, #micBtn lived inside
// #inputBar which started with class `hidden` (display:none), giving it a zero
// bounding rect — effectively invisible with no discoverable way to activate it.
//
// The fix: terminal.js calls ensureInputBar().reveal() on mobile so the bar (and
// the mic button) are visible the moment the terminal boots, without triggering
// keyboard focus. This test FAILS on the broken state (bounding rect = 0) and
// PASSES after the fix (bounding rect > 0, click triggers dictation overlay).
test("mobile #micBtn is visible on mount and wired to the dictation flow", async ({
  page,
}) => {
  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  // Wait for the terminal engine to boot — engine attaches child elements to
  // #terminal when it initialises the PTY backend.
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );
  // Allow the post-mount resize + input-bar wiring to settle.
  await page.waitForTimeout(300);

  // 1. #micBtn must exist in the DOM (rendered by TerminalIsland scaffold).
  await expect(page.locator("#micBtn")).toHaveCount(1);

  // 2. #micBtn must be computed-visible — NOT inside a display:none container.
  //    getBoundingClientRect() returns all-zeros for hidden elements.
  const rect = await page.locator("#micBtn").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  expect(rect.width, "#micBtn width must be > 0 (not hidden)").toBeGreaterThan(
    0,
  );
  expect(
    rect.height,
    "#micBtn height must be > 0 (not hidden)",
  ).toBeGreaterThan(0);

  // 3. #micBtn must be wired to the dictation flow: clicking it must launch the
  //    mic overlay. In the test environment getUserMedia may be blocked/denied,
  //    but createDictateAction still surfaces a fault state via the overlay.
  await page.locator("#micBtn").click();
  await expect(page.locator("#mobux-mic-overlay")).toBeVisible({
    timeout: 5000,
  });
});

// ── mic: fast-submit button + retry-preserves-audio regression ─────────────
//
// Live-tested feedback on the dictation flow:
//   1. Submitting always needed three taps (stop → preview → confirm). Fixed
//      by adding a primary one-tap Submit button in the RECORDING overlay
//      (stop + transcribe + submit, no preview) alongside the existing
//      Stop→preview path.
//   2. A transcription failure discarded the just-captured audio and forced
//      a full re-record via the FAULT screen's Retry button. Fixed: Retry on
//      a post-record fault now resends the same captured audio instead of
//      calling getUserMedia again.
//
// Headless Chromium has no real mic and this suite runs with workers: 1 (no
// per-file launchOptions override, see playwright.config.cjs), so these tests
// replace navigator.mediaDevices.getUserMedia with a real, spec-compliant
// MediaStream synthesized in-page (an AudioContext oscillator routed into a
// MediaStreamAudioDestinationNode) — genuine PCM flows through the exact same
// analyser/ScriptProcessor graph input-actions.js builds, no browser launch
// flags or OS permission prompts required. /transcribe + /api/stt/status are
// mocked to control outcomes deterministically.
test.describe("mic dictation: fast submit + retry preserves audio", () => {
  async function installFakeMic(page) {
    await page.addInitScript(() => {
      window.__gumCalls = 0;
      const fakeGetUserMedia = () => {
        window.__gumCalls++;
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC();
        const osc = ctx.createOscillator();
        osc.frequency.value = 220;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        return Promise.resolve(dest.stream);
      };
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = fakeGetUserMedia;
      } else {
        Object.defineProperty(navigator, "mediaDevices", {
          value: { getUserMedia: fakeGetUserMedia },
          configurable: true,
        });
      }
    });
  }

  async function openRecording(page) {
    // Backend probe (added alongside these fixes) must see a reachable
    // provider or it raises a pre-record FAULT instead of opening the mic —
    // that's its own behavior, tested separately; here we want RECORDING.
    await page.route(/\/api\/stt\/status$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "local",
          reachable: true,
          installed: true,
          local_process_running: true,
        }),
      }),
    );
    await installFakeMic(page);
    await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(
      () => {
        const t = document.getElementById("terminal");
        return t && t.childElementCount > 0;
      },
      { timeout: 15000 },
    );
    await page.evaluate(() => {
      const bar = document.getElementById("inputBar");
      if (bar) bar.classList.remove("hidden");
    });
    await page.locator("#micBtn").click();
    await expect(page.locator("#mobux-mic-overlay.recording")).toBeVisible({
      timeout: 5000,
    });
  }

  // Renderer-agnostic text search, same technique as critical-path.spec.cjs's
  // keyboard-up marker check: walk #terminal's text nodes for a substring.
  function waitForTerminalMarker(page, marker) {
    return page.waitForFunction(
      (m) => {
        const t = document.getElementById("terminal");
        if (!t) return false;
        const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.data && node.data.includes(m)) return true;
        }
        return false;
      },
      marker,
      { timeout: 10000 },
    );
  }

  test("RECORDING shows a primary Submit button, visually distinct from Stop/Cancel", async ({
    page,
  }) => {
    await openRecording(page);

    const submitBtn = page.locator("#mobux-mic-overlay .mo-btn-primary");
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toHaveText("✓ Submit");
    const box = await submitBtn.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);

    const stopBtn = page.locator("#mobux-mic-overlay .mo-btn", {
      hasText: "Stop",
    });
    await expect(stopBtn).toBeVisible();

    // "Obvious primary affordance": computed styling must set it apart from
    // the plain secondary buttons, not just be a same-looking extra button.
    const [primaryBg, secondaryBg] = await Promise.all([
      submitBtn.evaluate((el) => getComputedStyle(el).backgroundColor),
      stopBtn.evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    expect(
      primaryBg,
      "primary Submit must be visually distinct from the secondary row",
    ).not.toBe(secondaryBg);
  });

  test("fast-submit stops + transcribes + submits in one tap, skipping the preview", async ({
    page,
  }) => {
    let transcribeCalls = 0;
    await page.route(/\/transcribe$/, async (route) => {
      transcribeCalls++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "mobux fast submit marker" }),
      });
    });

    await openRecording(page);
    await page.locator("#mobux-mic-overlay .mo-btn-primary").click();

    // Overlay closes on its own once the submit resolves — REVIEW never
    // shows for the fast path.
    await expect(page.locator("#mobux-mic-overlay")).toHaveCount(0, {
      timeout: 10000,
    });
    expect(transcribeCalls).toBe(1);

    // The transcript was sent straight through (typed + Enter), not held
    // back for a confirm tap.
    await waitForTerminalMarker(page, "mobux fast submit marker");
  });

  test("a transcription failure after Stop keeps the recording — Retry resends it instead of re-recording", async ({
    page,
  }) => {
    let transcribeCalls = 0;
    await page.route(/\/transcribe$/, async (route) => {
      transcribeCalls++;
      if (transcribeCalls === 1) {
        await route.fulfill({ status: 500, body: "boom" });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "mobux retry marker" }),
      });
    });

    await openRecording(page);
    const gumAfterOpen = await page.evaluate(() => window.__gumCalls);
    expect(gumAfterOpen).toBe(1);

    // Stop → preview path (kept for editing) — the failure must hit here.
    await page
      .locator("#mobux-mic-overlay .mo-btn", { hasText: "Stop" })
      .click();

    await expect(page.locator("#mobux-mic-overlay.fault")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#mobux-mic-overlay .mo-title")).toContainText(
      "Transcription failed",
    );

    // The bug: FAULT's Retry used to call getUserMedia again, discarding the
    // just-captured audio and forcing a full re-record.
    const gumAtFault = await page.evaluate(() => window.__gumCalls);
    expect(
      gumAtFault,
      "a transcription fault must not itself trigger a new recording",
    ).toBe(1);

    await page
      .locator("#mobux-mic-overlay .mo-btn", { hasText: "Retry" })
      .click();

    await expect(page.locator("#mobux-mic-overlay.review")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#mobux-mic-overlay .mo-review-text")).toHaveText(
      "mobux retry marker",
    );

    expect(
      transcribeCalls,
      "Retry must resend the captured audio, not silently give up",
    ).toBe(2);
    const gumAfterRetry = await page.evaluate(() => window.__gumCalls);
    expect(
      gumAfterRetry,
      "Retry must reuse the captured audio — no second getUserMedia call",
    ).toBe(1);
  });

  // ── regression: no fault is ever silent — every kind gets a report link ──
  //
  // The mic button used to fail silently on a denied Android permission: the
  // overlay rendered (or didn't, depending on state) but there was no way to
  // tell "the server is fine, the mic permission is the problem" and nothing
  // actionable to do about it. Every fault now carries a GitHub report link
  // prefilled with the fault kind, so a dead mic is never a dead end.
  test("a denied getUserMedia renders a loud, computed-visible fault with a GitHub report link", async ({
    page,
  }) => {
    await page.route(/\/api\/stt\/status$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "local",
          reachable: true,
          installed: true,
          local_process_running: true,
        }),
      }),
    );
    await page.addInitScript(() => {
      const denyGetUserMedia = () =>
        Promise.reject(
          new DOMException("Permission denied", "NotAllowedError"),
        );
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = denyGetUserMedia;
      } else {
        Object.defineProperty(navigator, "mediaDevices", {
          value: { getUserMedia: denyGetUserMedia },
          configurable: true,
        });
      }
    });

    await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(
      () => {
        const t = document.getElementById("terminal");
        return t && t.childElementCount > 0;
      },
      { timeout: 15000 },
    );
    await page.evaluate(() => {
      const bar = document.getElementById("inputBar");
      if (bar) bar.classList.remove("hidden");
    });
    await page.locator("#micBtn").click();

    const overlay = page.locator("#mobux-mic-overlay.fault");
    await expect(overlay).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#mobux-mic-overlay .mo-title")).toContainText(
      "Microphone permission is blocked",
    );

    // Computed visibility, not `.hidden` — a real box on screen, not display:none.
    const box = await overlay.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    const display = await overlay.evaluate(
      (el) => getComputedStyle(el).display,
    );
    expect(display).not.toBe("none");

    const reportLink = page.locator("#mobux-mic-overlay .mo-report-link");
    await expect(reportLink).toBeVisible();
    const href = await reportLink.getAttribute("href");
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/mvhenten/mobux/issues/new",
    );
    expect(url.searchParams.get("title")).toContain("[dictation] denied");
    expect(url.searchParams.get("body")).toContain("Fault kind: denied");
  });

  // ── regression: a getUserMedia that never settles must still fault loud ──
  //
  // In a TWA/WebView missing the Android RECORD_AUDIO permission,
  // getUserMedia can hang forever — neither resolving nor rejecting — so the
  // try/catch in startRecording never fires and the mic tap looks dead: no
  // error, no overlay, nothing. getUserMediaWithTimeout races the call
  // against GETUSERMEDIA_TIMEOUT_MS so a hang surfaces the same loud,
  // reportable fault a normal rejection produces.
  test("a getUserMedia that never resolves still surfaces a loud, reportable fault", async ({
    page,
  }) => {
    test.setTimeout(45000);
    await page.route(/\/api\/stt\/status$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "local",
          reachable: true,
          installed: true,
          local_process_running: true,
        }),
      }),
    );
    await page.addInitScript(() => {
      const hangingGetUserMedia = () => new Promise(() => {});
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = hangingGetUserMedia;
      } else {
        Object.defineProperty(navigator, "mediaDevices", {
          value: { getUserMedia: hangingGetUserMedia },
          configurable: true,
        });
      }
    });

    await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(
      () => {
        const t = document.getElementById("terminal");
        return t && t.childElementCount > 0;
      },
      { timeout: 15000 },
    );
    await page.evaluate(() => {
      const bar = document.getElementById("inputBar");
      if (bar) bar.classList.remove("hidden");
    });
    await page.locator("#micBtn").click();

    const overlay = page.locator("#mobux-mic-overlay.fault");
    await expect(overlay).toBeVisible({ timeout: 12000 });
    await expect(page.locator("#mobux-mic-overlay .mo-title")).toContainText(
      "Microphone access timed out",
    );

    // Computed visibility, not `.hidden` — a real box on screen, not display:none.
    const box = await overlay.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    const display = await overlay.evaluate(
      (el) => getComputedStyle(el).display,
    );
    expect(display).not.toBe("none");

    const reportLink = page.locator("#mobux-mic-overlay .mo-report-link");
    await expect(reportLink).toBeVisible();
    const href = await reportLink.getAttribute("href");
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/mvhenten/mobux/issues/new",
    );
    expect(url.searchParams.get("title")).toContain("[dictation] timeout");
    expect(url.searchParams.get("body")).toContain("Fault kind: timeout");
  });

  test("a transcription failure also renders a GitHub report link", async ({
    page,
  }) => {
    await page.route(/\/transcribe$/, async (route) => {
      await route.fulfill({ status: 500, body: "boom" });
    });

    await openRecording(page);
    await page
      .locator("#mobux-mic-overlay .mo-btn", { hasText: "Stop" })
      .click();

    const overlay = page.locator("#mobux-mic-overlay.fault");
    await expect(overlay).toBeVisible({ timeout: 10000 });

    const reportLink = page.locator("#mobux-mic-overlay .mo-report-link");
    await expect(reportLink).toBeVisible();
    const href = await reportLink.getAttribute("href");
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/mvhenten/mobux/issues/new",
    );
    expect(url.searchParams.get("title")).toContain("[dictation] http");
    expect(url.searchParams.get("body")).toContain("Fault kind: http");
  });

  // ── regression: a /transcribe that never responds must still fault loud ──
  //
  // The real bug (#170): a broken STT backend can accept the connection and
  // never answer POST /v1/audio/transcriptions — /health looks fine, so the
  // pre-record probe waves it through, and the client used to just sit on
  // the "Transcribing…" spinner forever with no error. transcribePending now
  // races the request against TRANSCRIBE_TIMEOUT_MS via AbortController, so a
  // hang surfaces the same loud, reportable fault as any other failure.
  test("a /transcribe that never responds still surfaces a loud, reportable fault within the timeout", async ({
    page,
  }) => {
    test.setTimeout(50000);
    // Never call route.fulfill/continue — the request stays pending,
    // simulating a backend that accepted the audio but never answers.
    await page.route(/\/transcribe$/, () => {});

    await openRecording(page);
    await page
      .locator("#mobux-mic-overlay .mo-btn", { hasText: "Stop" })
      .click();

    await expect(page.locator("#mobux-mic-overlay.transcribing")).toBeVisible({
      timeout: 5000,
    });

    const overlay = page.locator("#mobux-mic-overlay.fault");
    await expect(overlay).toBeVisible({ timeout: 35000 });
    await expect(page.locator("#mobux-mic-overlay .mo-title")).toContainText(
      "Transcription backend did not respond",
    );

    // Computed visibility, not `.hidden` — a real box on screen, not display:none.
    const box = await overlay.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    const display = await overlay.evaluate(
      (el) => getComputedStyle(el).display,
    );
    expect(display).not.toBe("none");

    const reportLink = page.locator("#mobux-mic-overlay .mo-report-link");
    await expect(reportLink).toBeVisible();
    const href = await reportLink.getAttribute("href");
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/mvhenten/mobux/issues/new",
    );
    expect(url.searchParams.get("title")).toContain(
      "[dictation] transcribe-timeout",
    );
    expect(url.searchParams.get("body")).toContain(
      "Fault kind: transcribe-timeout",
    );
  });
});

// ── settings: every card renders and hits its endpoint ──────────────────────

test("settings: every ported card renders and consumes its endpoint", async ({
  page,
}) => {
  const seen = new Set();
  page.on("request", (r) => {
    const u = new URL(r.url()).pathname;
    if (u.startsWith("/api/") || u.startsWith("/static/"))
      seen.add(`${r.method()} ${u}`);
  });

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });

  // Update / Renderer / Theme / Shell-integration / STT / Install / Notifications.
  await expect(page.locator("#update h2")).toHaveText("Software update");
  await expect(page.locator("#renderer-picker")).toBeVisible();
  await expect(page.locator("#theme-picker")).toBeVisible();
  await expect(page.locator("#shell-integration")).toBeVisible();
  await expect(page.locator("#stt-provider")).toBeVisible();
  await expect(page.locator("section#install-app")).toBeVisible();
  await expect(page.locator('input[name="bell"]')).toHaveCount(1);
  await expect(page.locator('input[name="program_exit_nonzero"]')).toHaveCount(
    1,
  );

  // Theme picker populated from /static/themes.js.
  await page.waitForFunction(
    () => document.querySelectorAll("#theme-picker option").length > 0,
    { timeout: 6000 },
  );

  // Shell-integration state resolved (not the initial "…").
  await expect(
    page.locator(
      '#shell-integration .shell-card[data-shell="bash"] [data-role="state"]',
    ),
  ).not.toHaveText("…", { timeout: 6000 });

  // Update card resolved a current version.
  await expect(page.locator("#update .settings-value").first()).not.toHaveText(
    "…",
    { timeout: 8000 },
  );

  // Listen + Build-info cards.
  await expect(page.locator("#listen-settings h2")).toHaveText("Listen");
  await expect(page.locator("#build-info h2")).toHaveText("Build");

  // The cards consumed their endpoints.
  for (const want of [
    "GET /api/update/status",
    "GET /api/settings/notifications",
    "GET /api/shell-integration/status",
    "GET /api/settings/stt",
    "GET /api/build-info",
    "GET /static/build-info.json",
  ]) {
    expect(seen.has(want), `expected ${want}`).toBeTruthy();
  }
});

// ── settings: STT provider switch shows per-provider fields + auto-saves ─────

test("settings: STT provider switch shows the right fields and auto-saves", async ({
  page,
}) => {
  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await page.waitForSelector("#stt-provider");
  const kind = page.locator("#sttKind");

  // network: Host + Port + Model; no API key, no install.
  await kind.selectOption("network");
  await expect(page.locator("#sttHost")).toBeVisible();
  await expect(page.locator("#sttPort")).toBeVisible();
  await expect(page.locator("#sttModelRow")).toBeVisible();
  await expect(page.locator("#sttApiKey")).toHaveCount(0);
  await expect(page.locator("#sttInstallBtn")).toHaveCount(0);

  // openai: API key + Model; no Host/Port.
  await kind.selectOption("openai");
  await expect(page.locator("#sttApiKey")).toBeVisible();
  await expect(page.locator("#sttModelRow")).toBeVisible();
  await expect(page.locator("#sttHost")).toHaveCount(0);
  await expect(page.locator("#sttPort")).toHaveCount(0);

  // local: install + run toggle; nothing else.
  await kind.selectOption("local");
  await expect(page.locator("#sttInstallBtn")).toBeVisible();
  await expect(page.locator("#sttToggleBtn")).toBeVisible();
  await expect(page.locator("#sttHost")).toHaveCount(0);

  // auto-save: switch to network, change the port, NO Save tap.
  await kind.selectOption("network");
  const probe = String(5290 + Math.floor(Math.random() * 9));
  const portEl = page.locator("#sttPort");
  await portEl.fill(probe);
  await portEl.blur();
  await expect(page.locator("#sttStatus")).toContainText("Saved", {
    timeout: 6000,
  });

  // Persisted with no Save tap.
  const cfg = await page.evaluate(async () =>
    (await fetch("/api/settings/stt")).json(),
  );
  expect(cfg.activeKind).toBe("network");
  expect(cfg.providers.network.port).toBe(probe);
});

// ── build-info card ─────────────────────────────────────────────────────────

test("settings: build-info card shows version and matching hashes", async ({
  page,
}) => {
  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  await expect(page.locator("#build-info h2")).toHaveText("Build");
  await expect(page.locator("#buildVersion")).not.toHaveText("…", {
    timeout: 6000,
  });
  await expect(page.locator("#buildServerHash")).not.toHaveText("…", {
    timeout: 6000,
  });
  await expect(page.locator("#buildFeHash")).not.toHaveText("—", {
    timeout: 6000,
  });
  // Fresh build: server hash and FE hash agree.
  const srv = await page.locator("#buildServerHash").textContent();
  const fe = await page.locator("#buildFeHash").textContent();
  expect(srv.trim()).toBe(fe.trim());
});

// ── regression: mesh-client loads exactly once (no double-declaration) ──────
//
// If HostPicker (mounted on the home route) loads mesh-client.js and then
// TerminalIsland (mounted on a session route) also loads mesh-client.js with a
// different cache-bust URL, the browser treats them as distinct scripts and
// executes the body twice — the top-level `const PEER_KEY` declaration on the
// second execution throws `SyntaxError: Identifier 'PEER_KEY' has already been
// declared`, which propagates as a pageerror and leaves the terminal blank.
// Guard: after the fix, TerminalIsland skips the load when window.MobuxMesh
// is already present. This test catches any regression in that guard.
test("mesh-client loads once: no double-declaration error navigating home then terminal", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // 1. Load the home route — HostPicker mounts and loads mesh-client.js first.
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  // Confirm mesh-client ran and exported its global before we navigate away.
  await page.waitForFunction(() => !!window.MobuxMesh, { timeout: 10000 });

  // 2. SPA-navigate to a terminal route — TerminalIsland mounts and must NOT
  //    re-execute mesh-client.js (same page, same global scope).
  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  // Terminal scaffold must be present.
  await expect(page.locator("#terminal")).toHaveCount(1);

  // Engine must attach child content (xterm viewport or sterk canvas).
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );

  // #terminal must have rendered height > 0 (not collapsed).
  const termHeight = await page.evaluate(() => {
    const t = document.getElementById("terminal");
    return t ? t.getBoundingClientRect().height : 0;
  });
  expect(termHeight).toBeGreaterThan(0);

  // window.MobuxMesh must still exist (not blown away by a failed second load).
  expect(await page.evaluate(() => !!window.MobuxMesh)).toBe(true);

  // No "already been declared" error — the core symptom of double-execution.
  const doubleDecl = pageErrors.filter((m) =>
    m.includes("already been declared"),
  );
  expect(
    doubleDecl,
    `double-declaration errors: ${doubleDecl.join("; ")}`,
  ).toHaveLength(0);

  // No SyntaxErrors at all from the boot chain.
  const syntaxErrors = pageErrors.filter((m) =>
    m.toLowerCase().includes("syntaxerror"),
  );
  expect(
    syntaxErrors,
    `unexpected SyntaxErrors: ${syntaxErrors.join("; ")}`,
  ).toHaveLength(0);
});

// ── regression: apiFetch only forgets the remote cred on a genuine upstream 401
//
// A relayed request can fail at two layers. A relay-/transport-level failure
// surfaces as a structured 502 (upstream_error) or 400 (bad_request); the home
// relay rejecting the BROWSER's own session surfaces as a 401 that still carries
// WWW-Authenticate (the relay strips that header from forwarded PEER responses,
// see relay.rs). Only a 401 WITHOUT WWW-Authenticate is the upstream peer
// rejecting the creds. apiFetch must clear the stored peer cred only in that
// last case — otherwise a momentary relay/home hiccup wipes a perfectly good
// remote cred and re-prompts. This drove the "asks for auth twice" loop.
test("apiFetch keeps the remote cred on relay-level failures, clears it only on a true upstream 401", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.MobuxMesh, { timeout: 10000 });

  const out = await page.evaluate(async () => {
    const M = window.MobuxMesh;
    const peer = "cred-guard-test:9999";
    const realFetch = window.fetch;
    const stub = (status, body, headers) => {
      window.fetch = async () => new Response(body, { status, headers });
    };
    const seed = () => M.setPeerCred(peer, "user", "pin");
    const r = {};
    try {
      M.setPeer(peer);

      // Relay/transport failure → structured 502. Cred must survive.
      seed();
      stub(502, JSON.stringify({ error: "upstream_error", message: "dial" }), {
        "Content-Type": "application/json",
      });
      await M.apiFetch("/api/sessions");
      r.credAfter502 = M.getPeerCred(peer);

      // Caller/relay rejection → structured 400. Cred must survive.
      seed();
      stub(400, JSON.stringify({ error: "bad_request", message: "bad peer" }), {
        "Content-Type": "application/json",
      });
      await M.apiFetch("/api/sessions");
      r.credAfter400 = M.getPeerCred(peer);

      // Home relay rejecting the browser's OWN session → 401 + WWW-Authenticate.
      // That header is present only on the relay's own auth response (it is
      // stripped from forwarded peer 401s), so the cred must NOT be cleared.
      seed();
      stub(401, "Authentication required", {
        "WWW-Authenticate": "Basic realm=mobux",
      });
      r.threwHomeHop = false;
      try {
        await M.apiFetch("/api/sessions");
      } catch (e) {
        r.threwHomeHop = true;
      }
      r.credAfterHomeHop = M.getPeerCred(peer);

      // Genuine upstream PEER 401 (relay stripped WWW-Authenticate) → clear cred.
      seed();
      stub(401, "Authentication required", {});
      r.threwUpstream = false;
      try {
        await M.apiFetch("/api/sessions");
      } catch (e) {
        r.threwUpstream = true;
        r.meshKind = e.meshKind;
      }
      r.credAfterUpstream = M.getPeerCred(peer);
    } finally {
      window.fetch = realFetch;
      M.clearPeerCred(peer);
      M.setPeer("");
    }
    return r;
  });

  // Relay-level failures (502/400) and the home-hop 401 all preserve the cred.
  expect(out.credAfter502).not.toBeNull();
  expect(out.credAfter400).not.toBeNull();
  expect(out.credAfterHomeHop).not.toBeNull();
  expect(out.threwHomeHop).toBe(true);

  // Only the genuine upstream 401 clears it and surfaces the unauthorized error.
  expect(out.threwUpstream).toBe(true);
  expect(out.meshKind).toBe("unauthorized");
  expect(out.credAfterUpstream).toBeNull();
});

// ── regression: second terminal session renders after navigating home → terminal → home → terminal
//
// Before the fix, terminal.js was an ES module already in the browser's module
// map after the first open. Client-side navigate() to a second session route
// never re-executed it, host-picker.js threw "already been declared", and
// #terminal stayed empty. The fix: open() hard-loads (location.href + reload())
// for every terminal route, so each open gets a fresh module scope.
test("second terminal open renders without engine boot error", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // A second dedicated session so the test can open two distinct terminals.
  const SEED2 = `spa-seed2-${process.pid}`;
  try {
    tmux(`kill-session -t ${SEED2}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SEED2} ${SHELL_ENV} "bash --norc --noprofile"`);

  try {
    // Home — both session rows must appear.
    await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
    await expect(
      page.locator(
        `#sessionList .swipe-row[data-name="${SEED}"] .session-item`,
      ),
    ).toBeVisible({ timeout: 8000 });
    await expect(
      page.locator(
        `#sessionList .swipe-row[data-name="${SEED2}"] .session-item`,
      ),
    ).toBeVisible({ timeout: 8000 });

    // Click first session row — hard-load navigates to the terminal route.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page
        .locator(`#sessionList .swipe-row[data-name="${SEED}"] .session-item`)
        .click(),
    ]);
    await page.waitForFunction(
      () => {
        const t = document.getElementById("terminal");
        return t && t.childElementCount > 0;
      },
      { timeout: 15000 },
    );
    expect(
      await page.evaluate(
        () =>
          document.getElementById("terminal").getBoundingClientRect().height,
      ),
    ).toBeGreaterThan(0);

    // Return to Home.
    await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
    await expect(
      page.locator(
        `#sessionList .swipe-row[data-name="${SEED2}"] .session-item`,
      ),
    ).toBeVisible({ timeout: 8000 });

    // Click second session row — hard-load again; without the fix this was blank
    // because terminal.js was already module-cached and would not re-execute.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page
        .locator(`#sessionList .swipe-row[data-name="${SEED2}"] .session-item`)
        .click(),
    ]);
    await page.waitForFunction(
      () => {
        const t = document.getElementById("terminal");
        return t && t.childElementCount > 0;
      },
      { timeout: 15000 },
    );
    expect(
      await page.evaluate(
        () =>
          document.getElementById("terminal").getBoundingClientRect().height,
      ),
    ).toBeGreaterThan(0);

    // MobuxMesh must be present (not blown away by a failed re-load).
    expect(await page.evaluate(() => !!window.MobuxMesh)).toBe(true);

    // Core symptom of double-execution — must be absent.
    const doubleDecl = pageErrors.filter((m) =>
      m.includes("already been declared"),
    );
    expect(
      doubleDecl,
      `double-declaration errors: ${doubleDecl.join("; ")}`,
    ).toHaveLength(0);
  } finally {
    try {
      tmux(`kill-session -t ${SEED2}`);
    } catch (_) {}
  }
});

// ── install page: QR codes ──────────────────────────────────────────────────

test("install page renders QR codes for CA and APK", async ({ page }) => {
  await page.goto(`${APP}#/install`, { waitUntil: "networkidle" });
  const qrs = page.locator(".install-qr");
  await expect(qrs).toHaveCount(2);
  await expect(qrs.first().locator("svg")).toBeVisible();
  await expect(qrs.nth(1).locator("svg")).toBeVisible();
  await expect(page.locator('a[href="/install/mobux-ca.crt"]')).toBeVisible();
  await expect(page.locator('a[href="/install/mobux.apk"]')).toBeVisible();
});

// ── mesh host picker ────────────────────────────────────────────────────────

test('mesh host picker is a native select with "This host" as default', async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  // Native <select> host picker inside .spa-host-picker — no popover/overlay.
  const picker = page.locator(".spa-host-picker");
  await expect(picker).toBeVisible();
  const select = picker.locator("select.host-select");
  await expect(select).toBeVisible();

  // Default selection is "This host" (empty-value option).
  await expect(select).toHaveValue("");
  const thisHostOption = select.locator('option[value=""]');
  await expect(thisHostOption).toHaveText("This host");

  // No old popover/floating overlay exists.
  await expect(page.locator(".spa-host-dropdown")).toHaveCount(0);
  await expect(page.locator(".host-trigger")).toHaveCount(0);
});

// ── regression: host-switcher single source of truth ───────────────────────
//
// Before the fix, three independent components each had their own view of
// "which host is active":
//   1. HostPicker restored the saved peer silently (no event dispatch), so the
//      select showed remote host A while the session list still showed local B.
//   2. refresh() ran before mesh-client.js loaded → apiGet fell back to plain
//      fetch → listed the local host regardless of the saved peer.
//   3. open() called currentPeer() but mesh might not be loaded yet → built
//      /s/<name> with NO host → terminal opened on the wrong host.
//
// The fix collapses to one source of truth: mesh-client.js's getPeer/setPeer,
// with refresh() gated on mesh being loaded, and HostPicker dispatching
// mobux:peer-changed on restore so the list always re-fetches from the correct
// host at the same time the picker updates.
//
// These tests use page.route() to mock /api/peers and the relay sessions
// endpoint so the smoke instance behaves as if a real peer is present without
// actually needing a second mobux binary.

// Fake peer used across all three regression tests.
const MOCK_PEER = "127.0.0.1:8282";
// Relay API paths use base64url (encodePeer in mesh-client.js).
const MOCK_PEER_ENC = btoa(MOCK_PEER)
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=/g, "");
// SPA navigation URLs (#/s/<peer>/<name>) still use encodeURIComponent.
const MOCK_PEER_URL_ENC = encodeURIComponent(MOCK_PEER);
const MOCK_PEER_SESSIONS = [
  { name: "peer-only-session", windows: 1, attached: 0 },
];

// Install the two route mocks that make the smoke instance pretend it has a
// peer. Call before any navigation that should see the mocked peer.
async function installPeerMocks(page) {
  // /api/peers: return the fake peer so it appears as an <option>.
  await page.route(/\/api\/peers(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        peers: [
          {
            host: "127.0.0.1",
            port: 8282,
            name: "test-peer",
            reachable: true,
          },
        ],
      }),
    }),
  );

  // relay sessions: return sessions that only exist on the fake peer.
  await page.route(new RegExp(`/r/${MOCK_PEER_ENC}/api/sessions`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PEER_SESSIONS),
    }),
  );
}

// Seed the saved peer + a dummy cred in localStorage so HostPicker restores
// it on load and open() doesn't block on ensurePeerCred.
async function seedPeerStorage(page) {
  await page.evaluate((peer) => {
    localStorage.setItem("mobux:peer", peer);
    // A dummy base64 cred (not checked by the mock route handler).
    localStorage.setItem(`mobux:peer-cred:${peer}`, btoa("smoke:00000"));
  }, MOCK_PEER);
}

async function clearPeerStorage(page) {
  await page.evaluate((peer) => {
    localStorage.removeItem("mobux:peer");
    localStorage.removeItem(`mobux:peer-cred:${peer}`);
  }, MOCK_PEER);
}

test("host-switcher: reload with persisted peer shows peer in select and fetches relay sessions", async ({
  page,
}) => {
  // Load once to establish the page context, then seed peer storage and
  // install mocks before reloading — this exercises the restore-on-load path.
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await seedPeerStorage(page);
  await installPeerMocks(page);

  // Capture which session-fetch URLs are actually requested.
  const sessionUrls = [];
  page.on("request", (r) => {
    if (r.url().includes("api/sessions")) sessionUrls.push(r.url());
  });

  await page.reload({ waitUntil: "networkidle" });

  // Picker must reflect the saved peer — not "This host".
  const select = page.locator("select.host-select");
  await expect(select).toHaveValue(MOCK_PEER);

  // Session list must show the PEER's sessions (not the local smoke sessions).
  await expect(page.locator("#sessionList .session-name")).toContainText(
    "peer-only-session",
    { timeout: 8000 },
  );

  // The relay path must have been fetched (not just the local /api/sessions).
  expect(
    sessionUrls.some((u) => u.includes(`/r/${MOCK_PEER_ENC}/api/sessions`)),
  ).toBeTruthy();

  await clearPeerStorage(page);
});

test("host-switcher: selecting a peer reliably refetches sessions from that peer", async ({
  page,
}) => {
  await installPeerMocks(page);
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  // Initially shows local sessions — seed session must be present.
  await expect(page.locator("#sessionList .session-item").first()).toBeVisible({
    timeout: 8000,
  });
  const localNames = await page
    .locator("#sessionList .session-name")
    .allTextContents();
  // Local list must NOT contain the peer-only session before switching.
  expect(localNames.some((n) => n.trim() === "peer-only-session")).toBeFalsy();

  // Pre-seed cred so selectPeer doesn't open the CredDialog.
  await page.evaluate((peer) => {
    localStorage.setItem(`mobux:peer-cred:${peer}`, btoa("smoke:00000"));
  }, MOCK_PEER);

  // Select the peer via the native <select>.
  await page.locator("select.host-select").selectOption(MOCK_PEER);

  // Wait for the select's controlled value to reflect the new peer in Preact's
  // state. This ensures the selectPeer() async chain (setPeer → notifyPeerChanged
  // → refresh()) has had a chance to commit before we assert on the session list.
  // Without this, toContainText may fail immediately with a strict-mode violation
  // because the local-session list still has 2 rows while the relay fetch is in
  // flight.
  await expect(page.locator("select.host-select")).toHaveValue(MOCK_PEER, {
    timeout: 3000,
  });

  // Session list must now show the PEER's sessions.
  await expect(page.locator("#sessionList .session-name")).toContainText(
    "peer-only-session",
    { timeout: 8000 },
  );

  // And no longer contain the seed session (list is exclusively from the peer).
  const peerNames = await page
    .locator("#sessionList .session-name")
    .allTextContents();
  expect(peerNames.some((n) => n.trim() === SEED)).toBeFalsy();

  await clearPeerStorage(page);
});

test("host-switcher: opening a remote session deep-links to /app#/s/<peer>/<name>", async ({
  page,
}) => {
  await installPeerMocks(page);
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await seedPeerStorage(page);
  await page.reload({ waitUntil: "networkidle" });

  // Wait for the peer session row to appear.
  await expect(page.locator("#sessionList .session-name")).toContainText(
    "peer-only-session",
    { timeout: 8000 },
  );

  // Clicking the session triggers window.location.href = '/app#/s/<peer>/<name>'
  // followed by a reload. Capture the navigation before the reload completes.
  const [navigation] = await Promise.all([
    page.waitForNavigation({ waitUntil: "commit", timeout: 10000 }),
    page
      .locator(
        '#sessionList .swipe-row[data-name="peer-only-session"] .session-item',
      )
      .click(),
  ]);

  const url = page.url();
  // URL must carry the peer host so the terminal routes to the right node.
  // SPA navigation URLs use encodeURIComponent (not base64url relay paths).
  const encodedPeer = MOCK_PEER_URL_ENC;
  expect(url).toContain(`/s/${encodedPeer}/peer-only-session`);
  // Must NOT be the no-host form (which would open on the local node).
  expect(url).not.toMatch(/\/s\/peer-only-session$/);

  await clearPeerStorage(page);
});
