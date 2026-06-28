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
    const r = t.getBoundingClientRect();
    return {
      hostTop: r.top,
      hostBottom: r.bottom,
      hostHeight: r.height,
      viewportHeight: window.innerHeight,
      rows: window.__mobuxView?.test?.rows?.() ?? null,
    };
  });

  // The terminal host fills essentially the whole viewport: it starts at the
  // top (no SPA chrome on this route) and its bottom reaches the viewport
  // bottom within a few px. A too-short host (status bar stranded mid-screen)
  // leaves a large gap and fails this.
  expect(geo.hostTop).toBeLessThan(8);
  expect(geo.hostHeight).toBeGreaterThan(geo.viewportHeight * 0.85);
  expect(Math.abs(geo.viewportHeight - geo.hostBottom)).toBeLessThan(8);

  // And the PTY actually got enough rows for that height. Derive an expected
  // minimum from the host height; the ~13-row bug (top third only) fails this.
  const minRows = Math.floor((geo.hostHeight / geo.viewportHeight) * 30);
  expect(geo.rows).toBeGreaterThanOrEqual(Math.max(20, minRows));
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

  // The mobile input bar mounts lazily; reveal it the way a touch double-tap
  // would so the ribbon is laid out and measurable.
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
