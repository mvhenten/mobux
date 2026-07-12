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

const { createTmuxRunner, waitForClientAttached } = require("./lib/tmux.cjs");

// Dedicated tmux server/session, identical convention to smoke.spec.cjs, so
// SPA session ops drive the smoke instance's tmux without colliding with the
// host's default tmux server.
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const tmux = createTmuxRunner("mobux-test");

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

  // Current header: `mobux` wordmark (home link), gear button.
  // No old-style text tabs (.spa-nav / Home / Install tabs).
  await expect(page.locator(".app-wordmark")).toBeVisible();
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

// ── server-synced UI preferences (#211) ───────────────────────────────

const PREF_DEFAULTS = {
  renderer: "xterm",
  theme: "tomorrow-night-soft",
  default_view: "xterm",
  osc133_hint_dismissed: false,
  listen_voice: "",
  listen_rate: 1.0,
  listen_pitch: 1.0,
};

async function putPrefs(page, prefs) {
  const res = await page.request.put(`${BASE}/api/settings/preferences`, {
    data: prefs,
  });
  if (!res.ok()) throw new Error(`PUT preferences: ${res.status()}`);
}

test("preferences API round-trips the whole blob", async ({ page }) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  // A fresh row seeds to defaults; renderer/theme are always present strings.
  const initial = await page.evaluate(async () =>
    (await fetch("/api/settings/preferences")).json(),
  );
  expect(typeof initial.renderer).toBe("string");
  expect(typeof initial.theme).toBe("string");

  const put = {
    renderer: "sterk",
    theme: "nord",
    default_view: "reader",
    osc133_hint_dismissed: true,
    listen_voice: "Daniel",
    listen_rate: 1.4,
    listen_pitch: 0.8,
  };
  try {
    const status = await page.evaluate(async (body) => {
      const r = await fetch("/api/settings/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return r.status;
    }, put);
    expect(status).toBe(204);

    const got = await page.evaluate(async () =>
      (await fetch("/api/settings/preferences")).json(),
    );
    expect(got).toMatchObject(put);
  } finally {
    await putPrefs(page, PREF_DEFAULTS);
  }
});

test("terminal island reads the server renderer preference", async ({
  page,
}) => {
  // Set the renderer to sterk on the server, then load a terminal fresh: the
  // island must load the sterk vendor bundle, proving it booted from the
  // server preference — there is no per-device localStorage renderer anymore.
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await putPrefs(page, { ...PREF_DEFAULTS, renderer: "sterk" });
  try {
    // about:blank first, so navigating to the terminal route is a full document
    // load (not a hash-only change) and main.jsx re-runs — re-hydrating prefs
    // before the island boots.
    await page.goto("about:blank");
    const sterkBundle = page.waitForRequest(
      /\/static\/vendor\/sterk\.bundle\.js/,
      { timeout: 20000 },
    );
    await page.goto(`${APP}#/s/${SEED}`, { waitUntil: "domcontentloaded" });
    await sterkBundle;
  } finally {
    await putPrefs(page, PREF_DEFAULTS);
  }
});

test("settings cards render the seeded server preferences, not built-in defaults", async ({
  page,
}) => {
  // Regression test for a bug caught in review: RendererCard/ListenCard used
  // to initialize their signals from getPref() at module-eval time, which
  // runs before main.jsx's boot() has awaited hydrate(). That raced hydrate
  // and rendered built-in defaults (xterm/1.0/1.0) even though the server
  // held sterk/1.4 — and saving from that stale state reset the untouched
  // prefs back to defaults. Both cards now read on mount instead (like
  // ThemeCard already did), so a fresh load must show the seeded values.
  const seeded = {
    renderer: "sterk",
    theme: "nord",
    default_view: "reader",
    osc133_hint_dismissed: true,
    listen_voice: "",
    listen_rate: 1.4,
    listen_pitch: 0.6,
  };
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await putPrefs(page, seeded);
  try {
    await page.goto("about:blank");
    await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });

    await expect(page.locator("#renderer-picker select")).toHaveValue("sterk");

    const capable = await page.locator("#listenCapable").isVisible();
    if (capable) {
      await expect(page.locator("#listenRate")).toHaveValue("1.4");
      await expect(page.locator("#listenPitch")).toHaveValue("0.6");
    }
  } finally {
    await putPrefs(page, PREF_DEFAULTS);
  }
});

test("changing one preference does not reset the others (GET-merge-PUT)", async ({
  page,
}) => {
  // Regression test for a bug caught in review: prefs.js used to PUT the
  // tab's boot-time snapshot on every change. Seed a full set of non-default
  // values, change only the renderer through the UI, and confirm every other
  // field the seed set is still intact server-side afterward.
  const seeded = {
    renderer: "xterm",
    theme: "nord",
    default_view: "reader",
    osc133_hint_dismissed: true,
    listen_voice: "",
    listen_rate: 1.4,
    listen_pitch: 0.6,
  };
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await putPrefs(page, seeded);
  try {
    await page.goto("about:blank");
    await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });

    await page.locator("#renderer-picker select").selectOption("sterk");
    await expect(
      page.locator("#renderer-picker .settings-status"),
    ).toBeVisible();

    const after = await page.evaluate(async () =>
      (await fetch("/api/settings/preferences")).json(),
    );
    expect(after.renderer).toBe("sterk");
    expect(after).toMatchObject({
      theme: "nord",
      default_view: "reader",
      osc133_hint_dismissed: true,
      listen_rate: 1.4,
      listen_pitch: 0.6,
    });
  } finally {
    await putPrefs(page, PREF_DEFAULTS);
  }
});

test("PUT rejects an invalid renderer/default_view with 400", async ({
  page,
}) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  const badRenderer = await page.evaluate(async () => {
    const r = await fetch("/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        renderer: "not-a-renderer",
        theme: "nord",
        default_view: "xterm",
        osc133_hint_dismissed: false,
        listen_voice: "",
        listen_rate: 1.0,
        listen_pitch: 1.0,
      }),
    });
    return r.status;
  });
  expect(badRenderer).toBe(400);

  const badView = await page.evaluate(async () => {
    const r = await fetch("/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        renderer: "xterm",
        theme: "nord",
        default_view: "not-a-view",
        osc133_hint_dismissed: false,
        listen_voice: "",
        listen_rate: 1.0,
        listen_pitch: 1.0,
      }),
    });
    return r.status;
  });
  expect(badView).toBe(400);

  // Neither rejected write should have touched the stored row.
  const got = await page.evaluate(async () =>
    (await fetch("/api/settings/preferences")).json(),
  );
  expect(got.renderer).not.toBe("not-a-renderer");
  expect(got.default_view).not.toBe("not-a-view");
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

  // Observability (#213): the attach carries the SPA's own loaded-bundle hash
  // as `&build=<hash>` so a stale tab identifies itself in the server's attach
  // log. The value is Vite's `assets/index-<hash>.js` filename hash, so it's
  // present in any real built SPA.
  expect(wsUrl).toMatch(/[?&]build=[\w-]+/);

  // Engine actually rendered into the host (xterm/sterk attaches a child).
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return t && t.childElementCount > 0;
    },
    { timeout: 15000 },
  );
});

// ── ws URL carries the node segment (node-drop guard, #185/#210) ────────────
//
// The node rides only in the hash URL (`#/s/<node>/<name>`) and must reach the
// server on the PTY WebSocket as `?node=<node>` — a dropped node silently
// attaches the wrong tmux (the "can't find session" bug class). The node here
// isn't configured on the smoke instance, so the server rejects the upgrade;
// that's fine — this asserts the URL the client BUILDS, captured before the
// server's verdict, alongside the `build=` observability param.
test("node-qualified route threads ?node= and &build= onto the PTY ws", async ({
  page,
}) => {
  const NODE = "nodeprobe";
  const wsSeen = new Promise((resolve) => {
    page.on("websocket", (ws) => {
      if (ws.url().includes(`/ws/${encodeURIComponent(SEED)}`))
        resolve(ws.url());
    });
  });

  await page.goto(`${APP}#/s/${NODE}/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  const wsUrl = await Promise.race([
    wsSeen,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("ws timeout")), 15000),
    ),
  ]);

  expect(wsUrl).toContain(`/ws/${encodeURIComponent(SEED)}`);
  expect(wsUrl).toContain(`node=${NODE}`);
  expect(wsUrl).toMatch(/[?&]build=[\w-]+/);
});

// ── node-drop on re-entry (issue #210) ──────────────────────────────────────
//
// A session's node rides only in the hash URL (`#/s/<node>/<name>`), so a
// re-entry by bare session name — a push-notification deep-link, the legacy
// `/s/<name>` server redirect, a hand-typed/bookmarked link — must not
// silently attach to the LOCAL host when the session actually lives on a
// node. That's fixed at the URL-production layer, server-side, where the
// knowledge actually lives: `push.rs::session_url` documents why its
// session is always hub-local (the alert-bell hook only ever runs there),
// and the `/s/{name}` route (`terminal_page` in src/main.rs) resolves an
// ambiguous/hand-typed name against the real session inventory before
// redirecting into the SPA. See:
//   - src/main.rs `resolve_session_location_*` unit tests (pure decision
//     logic: unique local, unique node, ambiguous, no match)
//   - test/fleet/hub-proxy.spec.cjs (real ssh + real second tmux server —
//     the only harness that can prove a notification-shaped URL actually
//     lands on the right tmux, not just the right *route*)
// A client-side "remember what node I last used" cache can't deliver this
// guarantee (a notification opened on a second device, or a fresh browser
// with no local storage, would still attach locally), so there is
// deliberately no client-side mechanism here — the SPA renders whatever
// (node, name) pair the URL already names.

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
    // On mobile the input bar (mic/ribbon) is a flex sibling of #terminal
    // that only reveals on tap-to-focus engagement (#201) — it stays
    // hidden through this test, so barHeight is normally 0, but the check
    // below covers either state: whenever it IS shown it legitimately
    // claims its own height at the bottom of the viewport instead of the
    // terminal.
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

// The fake socket exposes `window.__fakeEmitData(str)` so the test decides
// exactly when the first PTY byte arrives — timer-based emission raced the
// page's own networkidle settling and flaked either way.
function installFakeSocket(page) {
  return page.addInitScript(() => {
    class FakeSocket extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        this.binaryType = "blob";
        window.__fakeEmitData = (str) => this.onmessage?.({ data: str });
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
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
  });
}

test("loading splash reveals on first data (unchanged data-triggered path)", async ({
  page,
}) => {
  await installFakeSocket(page);

  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  // No data has arrived yet (emission is test-controlled) and the no-output
  // fallback (armed at 1.5s after open) is still far away — the splash must
  // be up.
  await expect(page.locator("#loadquote")).toHaveCount(1);
  expect(await loadquoteGone(page)).toBe(false);

  // First byte arrives — the data path reveals within ~200ms (fade + removal
  // complete by ~500ms), well before the fallback could ever fire. Steady
  // 100ms probes: the default poll backoff (100/250/500/1000) skips clean
  // over the fade window.
  await page.evaluate(() => window.__fakeEmitData("$ "));
  await expect
    .poll(() => loadquoteGone(page), { timeout: 1500, intervals: [100] })
    .toBe(true);
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

// ── ribbon: hidden through splash + attach, reveals only on engagement (#201) ─
//
// Follow-up to #198/#199. #198 made the ribbon share the splash's own
// reveal trigger (`scheduleReveal()`), so in an attached session it popped
// up the moment the first PTY output arrived and then sat pinned at the
// bottom for the rest of the read — splash dismissal is not an input event.
// The ribbon must instead stay hidden from load through attach and only
// reveal on actual engagement (tap-to-focus — the same `onDoubleTap`
// handler that already existed before #198), then hide again on keyboard
// dismissal exactly as it already did (input-bar.js's visualViewport
// handler, unchanged by this fix).
function ribbonVisible(page) {
  return page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    if (!bar) return false;
    const r = bar.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

// Simulates the double-tap gesture terminal.js's `onDoubleTap` handler
// responds to by revealing the input bar (`ensureInputBar().show()`).
// touch.js's gesture recognizer is wired on #touchOverlay and is
// renderer-agnostic — it sits above #terminal regardless of whether xterm
// or sterk is the active engine underneath, so this exercises the same
// "way in" on both renderer projects this spec runs under. Two real
// touchstart/touchend pairs fired back-to-back land well inside touch.js's
// TAP_MS/DTAP_MS windows, exactly like a physical double-tap.
function doubleTapOverlay(page, x = 100, y = 100) {
  return page.evaluate(
    ({ x, y }) => {
      const overlay = document.getElementById("touchOverlay");
      const mkTouch = () =>
        new Touch({ identifier: 0, target: overlay, clientX: x, clientY: y });
      const fire = (type, touches) =>
        overlay.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches }),
        );
      fire("touchstart", [mkTouch()]);
      fire("touchend", []);
      fire("touchstart", [mkTouch()]);
      fire("touchend", []);
    },
    { x, y },
  );
}

// Simulates the on-screen keyboard opening then dismissing by stubbing
// `visualViewport.height` and dispatching the `resize` event input-bar.js's
// auto-hide listener reacts to (shrink is a no-op for visibility; growing
// back by more than 50px while the bar is shown is what triggers `hide()`).
// Playwright can't drive a real soft keyboard headlessly, so this drives
// the exact DOM event the production code listens for instead of a
// same-effect-different-cause substitute like a bare `blur()` (input-bar.js
// has no blur listener — only this visualViewport path calls `hide()`).
// Mirrors the established stubbing pattern in critical-path.spec.cjs /
// smoke.spec.cjs's own keyboard-visualViewport tests.
async function simulateKeyboardOpenThenDismiss(page) {
  await page.evaluate(() => {
    const vv = window.visualViewport;
    window.__origVVHeight = vv.height;
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () =>
        typeof window.__stubVVHeight === "number"
          ? window.__stubVVHeight
          : window.__origVVHeight,
    });
  });
  await page.evaluate(() => {
    window.__stubVVHeight = window.__origVVHeight - 300;
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await page.evaluate(() => {
    window.__stubVVHeight = window.__origVVHeight;
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
}

test("ribbon stays hidden through the loading splash and after attach", async ({
  page,
}) => {
  await installFakeSocket(page);

  // domcontentloaded returns as soon as the scaffold is parsed, giving a
  // stable read of the pre-reveal state (data emission is test-controlled,
  // so nothing can reveal the splash before this test says so).
  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "domcontentloaded",
  });

  // #inputBar is part of the static scaffold TerminalIsland renders before
  // terminal.js even loads, so its mere presence proves nothing. Wait
  // instead for the engine to actually attach (children under #terminal) —
  // terminal.js's boot is synchronous up to and including the mobile
  // eager-mount decision, so by the time the engine has attached, that
  // decision has already run. Asserting "not visible" here catches the
  // regression: on the broken (#198) code this observes the ribbon already
  // revealed, not just "not yet created".
  await page.waitForFunction(() => {
    const t = document.getElementById("terminal");
    return t && t.childElementCount > 0;
  });

  // Splash is still up at this point; ribbon (reload/bug-report included)
  // must not be showing.
  await expect(page.locator("#loadquote")).toHaveCount(1);
  expect(await loadquoteGone(page)).toBe(false);
  expect(await ribbonVisible(page)).toBe(false);

  // The splash's own reveal condition fires (first PTY data) — the ribbon
  // must NOT come with it (#201: splash dismissal is not an input event).
  await page.evaluate(() => window.__fakeEmitData("$ "));
  await expect.poll(() => loadquoteGone(page), { timeout: 1000 }).toBe(true);
  expect(await ribbonVisible(page)).toBe(false);
});

test("ribbon reveals on tap-to-focus engagement and hides again on keyboard dismissal (#201)", async ({
  page,
}) => {
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
  // Real session output has almost certainly already dismissed the splash
  // by "networkidle"; make sure, so the assertion below is unambiguous
  // about engagement (not splash-dismissal) being the cause of reveal.
  await expect.poll(() => loadquoteGone(page), { timeout: 5000 }).toBe(true);
  expect(await ribbonVisible(page)).toBe(false);

  // Engage: double-tap the terminal, exactly like a phone user tapping to
  // type. This is the "way in" that must exist while the bar starts hidden.
  await doubleTapOverlay(page);
  await expect.poll(() => ribbonVisible(page), { timeout: 1000 }).toBe(true);

  // Dismiss: keyboard opens then closes — the bar must hide again, same as
  // it already did before #198/#201 (input-bar.js's visualViewport handler).
  await simulateKeyboardOpenThenDismiss(page);
  await expect.poll(() => ribbonVisible(page), { timeout: 1000 }).toBe(false);
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

  // The mobile input bar only reveals on tap-to-focus engagement (#201),
  // not on mount, so force it visible directly for these geometry checks —
  // they're about ribbon scroll behavior, not the reveal lifecycle.
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

// ── mobile mic button: hidden on mount, reachable via tap-to-focus (#201) ───
//
// Regression guard for the "mobile microphone button completely gone" bug
// introduced in v0.6.0 (SPA cutover). Before that fix, #micBtn lived inside
// #inputBar which started with class `hidden` (display:none) and stayed that
// way forever — a zero bounding rect with no discoverable way to activate it.
//
// #198 fixed the "no way in" half by having the bar mount eagerly, but also
// made it auto-reveal on splash dismissal, which #201 reverts: the bar mounts
// eagerly (mic button exists and is wired) but starts hidden, same as splash
// dismissal, attach, and everything up to the first tap. What must still hold
// is the "discoverable way to activate it" half of the original fix — tap-to-
// focus (double-tap the terminal) is that way in. This test FAILS if the bar
// never reveals (the pre-#198 bug) or if it's already visible before any
// engagement (the #201 regression), and PASSES when it's hidden until the
// double-tap, then visible and wired.
test("mobile #micBtn stays hidden until tap-to-focus, then reveals and wires the dictation flow", async ({
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

  // 1. #micBtn must exist in the DOM (rendered by TerminalIsland scaffold,
  //    wired by the eager mobile mount) ...
  await expect(page.locator("#micBtn")).toHaveCount(1);

  // 2. ... but stay computed-hidden (inside #inputBar's display:none) until
  //    engagement. getBoundingClientRect() returns all-zeros for hidden
  //    elements.
  const hiddenRect = await page.locator("#micBtn").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  expect(hiddenRect.width, "#micBtn must start hidden (width 0)").toBe(0);
  expect(hiddenRect.height, "#micBtn must start hidden (height 0)").toBe(0);

  // 3. Tap-to-focus is the discoverable way in: double-tap the terminal.
  await doubleTapOverlay(page);
  await expect.poll(() => ribbonVisible(page), { timeout: 1000 }).toBe(true);

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

  // 4. #micBtn must be wired to the dictation flow: clicking it must launch the
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
  await expect(page.locator("#nodes-settings")).toBeVisible();
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

  // The cards consumed their endpoints. The frontend bundle hash is read
  // straight off the loaded <script> tag (issue #192), not fetched — so
  // /static/build-info.json is no longer part of this contract.
  for (const want of [
    "GET /api/update/status",
    "GET /api/settings/notifications",
    "GET /api/shell-integration/status",
    "GET /api/settings/stt",
    "GET /api/settings/nodes",
    "GET /api/build-info",
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
//
// Server build_hash and the frontend bundle hash describe two different
// builds (the terminal-renderer bundles vs. the SPA's own Vite output — see
// web/build.js), so they are shown as two independent facts, not compared
// for a "stale" match (issue #192).

test("settings: build-info card shows version, server hash, and frontend hash", async ({
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

  // "unknown" means the binary lost its embedded build-info.json (#172) —
  // never acceptable on a fresh build.
  const srv = await page.locator("#buildServerHash").textContent();
  expect(srv.trim()).not.toBe("unknown");

  // The frontend hash is read off the loaded script tag's filename
  // (assets/index-<hash>.js), not fetched — a production build always has
  // one, so it must resolve to a real hash, never the dev-mode fallback.
  const fe = await page.locator("#buildFeHash").textContent();
  expect(fe.trim()).not.toBe("dev");
  expect(fe.trim()).toMatch(/^[\w-]+$/);
});

// ── manual hard reload (#189) ─────────────────────────────────────────────
//
// A single-action reload control always within reach: the app-shell header
// (Home + Settings) and, separately, the terminal ribbon. Both just call
// `location.reload()` — the only clean boot of the terminal engine (#188).

test("home and settings headers expose a reload button", async ({ page }) => {
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  const homeReload = page.locator(
    'button.header-icon-btn[aria-label="Reload"]',
  );
  await expect(homeReload).toBeVisible();

  await Promise.all([page.waitForEvent("load"), homeReload.click()]);
  await expect(page.locator(".app-wordmark")).toBeVisible();

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const settingsReload = page.locator(
    'button.header-icon-btn[aria-label="Reload"]',
  );
  await expect(settingsReload).toBeVisible();
  await Promise.all([page.waitForEvent("load"), settingsReload.click()]);
});

test("terminal ribbon exposes a reload button", async ({ page }) => {
  await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator("#reloadBtn")).toHaveCount(1);
  // The ribbon only reveals on tap-to-focus engagement (#201), not on
  // mount — force it visible so #reloadBtn is actionable. This test is
  // about the button existing and working, not the reveal lifecycle.
  await page.evaluate(() => {
    const bar = document.getElementById("inputBar");
    if (bar) bar.classList.remove("hidden");
  });
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#reloadBtn").click(),
  ]);
});

// ── automatic reload after server update (#189) ───────────────────────────
//
// The SPA remembers the server's build_hash (`/api/build-info`) in
// sessionStorage and hard-reloads once it observes a change. `window.__mobuxCheckBuildHash`
// (set up by watchBuildHash in lib/reload.js) lets the test force a check
// without waiting out the real poll interval.

test("auto-reload: first visit records a baseline, a later change reloads once, then settles", async ({
  page,
}) => {
  let hash = "hash-a";
  await page.route("**/api/build-info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "0.0.0-test", build_hash: hash }),
    }),
  );

  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("mobux:buildHash")))
    .toBe("hash-a");

  // Same hash again — no reload.
  let reloaded = false;
  page.once("load", () => (reloaded = true));
  await page.evaluate(() => window.__mobuxCheckBuildHash());
  await page.waitForTimeout(200);
  expect(reloaded).toBe(false);

  // Server hash changes — the next check hard-reloads exactly once, and
  // remembers the new hash so the reloaded page's own check settles instead
  // of looping.
  hash = "hash-b";
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate(() => window.__mobuxCheckBuildHash()),
  ]);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("mobux:buildHash")))
    .toBe("hash-b");

  let reloadedAgain = false;
  page.once("load", () => (reloadedAgain = true));
  await page.evaluate(() => window.__mobuxCheckBuildHash());
  await page.waitForTimeout(200);
  expect(reloadedAgain).toBe(false);
});

// ── terminal engine lifecycle (#188) ─────────────────────────────────────────
//
// The engine is a factory (`createTerminal({ node, session, host, renderer })`
// → `{ dispose() }`), so terminal routes are plain SPA navigations: mounting
// creates an engine, leaving disposes it, and a (node, session) change is
// dispose + create — never a document reload. These tests are the acceptance
// bar for that lifecycle; historically every same-document path into a second
// terminal either rendered nothing (stale module scope) or attached to the
// WRONG tmux (the #185/#188 "session not found" class, because the engine
// kept the first target it ever booted with).

// Wait until the engine on the current route is fully up: renderer DOM
// mounted, its PTY websocket open, AND tmux reporting the attach client —
// the socket opens ~50-80ms before the server's attach subprocess registers
// with tmux, and input sent into that window is lost (see
// waitForClientAttached in lib/tmux.cjs).
async function waitForEngine(page, session) {
  await page.waitForFunction(
    () => {
      const t = document.getElementById("terminal");
      return (
        t &&
        t.childElementCount > 0 &&
        window.__mobuxView?.test?.wsReady?.() === true
      );
    },
    { timeout: 15000 },
  );
  await waitForClientAttached(tmux, session);
}

// Exact-line occurrence count of `marker` in a tmux pane. The senders below
// split the marker in the typed command (`echo TG''T_1`) so the command echo
// can never match — only the command's OUTPUT contains the contiguous marker.
function paneMarkerCount(session, marker) {
  return tmux(`capture-pane -p -t ${session}`)
    .toString()
    .split("\n")
    .filter((l) => l.trim() === marker).length;
}

// mount → unmount → mount in ONE document, via the exact taps a user makes
// (session row → terminal → back → other session row). Asserts each mount
// attaches its own live websocket, the unmounted engine's socket is closed
// (disposed, not leaked), and input lands exactly once (no duplicated
// handlers surviving from the previous mount).
test("terminal engine survives mount → unmount → mount in one document", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const sockets = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/")) sockets.push(ws);
  });

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

    // Open the first session — a plain SPA navigation, no document load.
    await page
      .locator(`#sessionList .swipe-row[data-name="${SEED}"] .session-item`)
      .click();
    await expect(page).toHaveURL(new RegExp(`#/s/${SEED}$`));
    await waitForEngine(page, SEED);
    expect(sockets.length).toBe(1);
    expect(sockets[0].url()).toContain(`/ws/${SEED}`);

    // Back to Home — the island unmounts, dispose() tears the engine down:
    // its websocket closes and the test surface goes away with it.
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await expect(
      page.locator(
        `#sessionList .swipe-row[data-name="${SEED2}"] .session-item`,
      ),
    ).toBeVisible({ timeout: 8000 });
    await page.waitForFunction(() => window.__mobuxView === undefined, {
      timeout: 8000,
    });
    await expect
      .poll(() => sockets[0].isClosed(), { timeout: 8000 })
      .toBe(true);

    // Open the second session in the SAME document.
    await page
      .locator(`#sessionList .swipe-row[data-name="${SEED2}"] .session-item`)
      .click();
    await expect(page).toHaveURL(new RegExp(`#/s/${SEED2}$`));
    await waitForEngine(page, SEED2);
    expect(sockets.length).toBe(2);
    expect(sockets[1].url()).toContain(`/ws/${SEED2}`);

    // Input lands exactly once — a duplicated handler from the first mount
    // would run the command twice.
    const MARK = `LIFE_${process.pid}`;
    await page.evaluate(
      (m) => window.__mobuxView.send(`echo ${m.slice(0, 4)}''${m.slice(4)}\r`),
      MARK,
    );
    await expect
      .poll(() => paneMarkerCount(SEED2, MARK), { timeout: 8000 })
      .toBe(1);

    // Core symptom of the old self-booting module — must be absent.
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

// Same-document navigation from one terminal route straight to another —
// hand-editing the address bar, or browser back/forward between two terminal
// routes. The engine must attach to the target in the NEW URL (the
// #185/#188 regression class: the stale engine kept serving the FIRST
// session/node, rendering another tmux's output — or its "session not
// found" — under the new route). No reload is allowed to paper over it.
test("navigating between two session routes re-attaches to the right target without a reload", async ({
  page,
}) => {
  const sockets = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/")) sockets.push(ws);
  });

  const SEED3 = `spa-seed3-${process.pid}`;
  try {
    tmux(`kill-session -t ${SEED3}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SEED3} ${SHELL_ENV} "bash --norc --noprofile"`);

  try {
    await page.goto(`${APP}#/s/${encodeURIComponent(SEED)}`, {
      waitUntil: "networkidle",
    });
    await waitForEngine(page, SEED);
    expect(sockets.length).toBe(1);
    expect(sockets[0].url()).toContain(`/ws/${SEED}`);

    // Prove the next navigation stays in THIS document.
    await page.evaluate(() => {
      window.__sameDocProbe = true;
    });

    await page.evaluate((name) => {
      location.hash = `#/s/${encodeURIComponent(name)}`;
    }, SEED3);
    await waitForEngine(page, SEED3);

    // Same document (no reload) …
    expect(await page.evaluate(() => window.__sameDocProbe)).toBe(true);
    // … the old engine is gone (socket closed, not leaked) …
    await expect
      .poll(() => sockets[0].isClosed(), { timeout: 8000 })
      .toBe(true);
    // … and the new engine attached to the target in the URL.
    expect(sockets.length).toBe(2);
    expect(sockets[1].url()).toContain(`/ws/${SEED3}`);

    // Keystrokes land in SEED3's tmux — and never in SEED's.
    const MARK = `TGT_${process.pid}`;
    await page.evaluate(
      (m) => window.__mobuxView.send(`echo ${m.slice(0, 3)}''${m.slice(3)}\r`),
      MARK,
    );
    await expect
      .poll(() => paneMarkerCount(SEED3, MARK), { timeout: 8000 })
      .toBe(1);
    expect(paneMarkerCount(SEED, MARK)).toBe(0);
  } finally {
    try {
      tmux(`kill-session -t ${SEED3}`);
    } catch (_) {}
  }
});

// ── node picker + nodes settings (#176 phase 3) ─────────────────────────────
//
// The backend side (/api/nodes, GET/PUT /api/settings/nodes, ?node= on the
// sessions API and the PTY WebSocket) lands in the node-inventory PR; these
// tests mock those endpoints at the page level so the UI contract is pinned
// regardless of merge order — and keep passing against a real backend after.

const NODE_FIXTURE = {
  nodes: [
    { name: "devbox", target: "mvhenten@devbox", reachable: true },
    { name: "lab", target: "ubuntu@lab", reachable: false },
  ],
};

function mockNodes(page, fixture = NODE_FIXTURE) {
  return page.route(/\/api\/nodes$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    }),
  );
}

test("home renders no node picker when zero nodes are configured", async ({
  page,
}) => {
  // Against the real backend first: pre-node-inventory it 404s /api/nodes,
  // which must mean "zero nodes", not an error — the UI is identical to today.
  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await expect(page.locator("#sessionList .session-item").first()).toBeVisible({
    timeout: 8000,
  });
  await expect(page.locator("#nodePicker")).toHaveCount(0);

  // An explicit empty inventory renders no picker either.
  await mockNodes(page, { nodes: [] });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("#sessionList .session-item").first()).toBeVisible({
    timeout: 8000,
  });
  await expect(page.locator("#nodePicker")).toHaveCount(0);
});

test("node picker: renders nodes, marks unreachable, threads ?node, persists selection", async ({
  page,
}) => {
  await mockNodes(page);
  const sessionQueries = [];
  await page.route(/\/api\/sessions(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const u = new URL(route.request().url());
    const node = u.searchParams.get("node");
    sessionQueries.push(node);
    if (node === "devbox") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { name: "remote-sess", windows: 1, attached: 0 },
        ]),
      });
    }
    if (node === "lab") {
      return route.fulfill({ status: 502, body: "ssh: connect refused" });
    }
    return route.continue();
  });

  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });

  const picker = page.locator("#nodePicker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".node-chip")).toHaveCount(3); // local + 2 nodes
  await expect(picker.locator('.node-chip[data-node=""]')).toHaveClass(
    /active/,
  );

  // Unreachable node is clearly marked — computed-visible, not just a class.
  const dead = picker.locator('.node-chip[data-node="lab"] .node-dead');
  await expect(dead).toHaveText("unreachable");
  const deadBox = await dead.boundingBox();
  expect(deadBox.width).toBeGreaterThan(0);

  // Pick devbox → the session list refetches with ?node=devbox and shows the
  // remote list.
  await picker.locator('.node-chip[data-node="devbox"]').click();
  await expect(
    page.locator('#sessionList .swipe-row[data-name="remote-sess"]'),
  ).toBeVisible({ timeout: 8000 });
  expect(sessionQueries).toContain("devbox");

  // Device-level persistence: localStorage, survives a reload.
  expect(await page.evaluate(() => localStorage.getItem("mobux:node"))).toBe(
    "devbox",
  );
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.locator('#nodePicker .node-chip[data-node="devbox"]'),
  ).toHaveClass(/active/);
  await expect(
    page.locator('#sessionList .swipe-row[data-name="remote-sess"]'),
  ).toBeVisible({ timeout: 8000 });

  // An unreachable node is still selectable — the failure is loud at connect,
  // never a silent no-op.
  await page.locator('#nodePicker .node-chip[data-node="lab"]').click();
  await expect(
    page.locator('#nodePicker .node-chip[data-node="lab"]'),
  ).toHaveClass(/active/);
  await expect(page.locator("#sessionList .hint")).toContainText(
    "Failed to load sessions",
    { timeout: 8000 },
  );

  // Back to local → the plain sessions API (no ?node) serves the seed again.
  await page.locator('#nodePicker .node-chip[data-node=""]').click();
  await expect(
    page.locator(`#sessionList .swipe-row[data-name="${SEED}"]`),
  ).toBeVisible({ timeout: 8000 });
  expect(await page.evaluate(() => localStorage.getItem("mobux:node"))).toBe(
    null,
  );
});

test("creating a session targets the selected node", async ({ page }) => {
  await mockNodes(page, {
    nodes: [{ name: "devbox", target: "mvhenten@devbox", reachable: true }],
  });
  await page.addInitScript(() => localStorage.setItem("mobux:node", "devbox"));
  const posts = [];
  await page.route(/\/api\/sessions(\?[^/]*)?$/, async (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === "POST") {
      posts.push(u.searchParams.get("node"));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    }
    if (u.searchParams.get("node") === "devbox") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    }
    return route.continue();
  });

  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await page.locator("#fabNew").click();
  await page.locator("#sessionName").fill("on-devbox");
  await page.locator("#newSessionForm .btn-create").click();

  await expect.poll(() => posts.length, { timeout: 8000 }).toBeGreaterThan(0);
  expect(posts[0]).toBe("devbox");
});

// Issue #185: the session URL carries the node segment, so the terminal is
// pinned to the node it was opened from — a later picker change or another
// device can never re-target it.
test("opening a session from a node navigates to #/s/<node>/<name>", async ({
  page,
}) => {
  await mockNodes(page, {
    nodes: [{ name: "devbox", target: "mvhenten@devbox", reachable: true }],
  });
  await page.addInitScript(() => localStorage.setItem("mobux:node", "devbox"));
  await page.route(/\/api\/sessions(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const u = new URL(route.request().url());
    if (u.searchParams.get("node") === "devbox") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { name: "remote-sess", windows: 1, attached: 0 },
        ]),
      });
    }
    return route.continue();
  });

  await page.goto(`${APP}#/`, { waitUntil: "networkidle" });
  await page
    .locator('#sessionList .swipe-row[data-name="remote-sess"] .session-item')
    .click();
  await expect(page).toHaveURL(/#\/s\/devbox\/remote-sess$/, {
    timeout: 8000,
  });
});

test("terminal PTY websocket and pane calls carry ?node= from the URL's node segment", async ({
  page,
}) => {
  // FakeSocket (same shape as the splash tests') so the assertion doesn't
  // depend on the backend accepting the ?node param: it records the URL and
  // fires `open`, which triggers the engine's refreshPanes fetch. The node
  // comes from the route alone — localStorage stays deliberately empty.
  await page.addInitScript(() => {
    window.__wsUrls = [];
    class FakeSocket extends EventTarget {
      constructor(url) {
        super();
        window.__wsUrls.push(String(url));
        this.url = url;
        this.readyState = 0;
        this.binaryType = "blob";
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
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
  });

  const paneCalls = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith("/panes")) paneCalls.push(u.search);
  });

  await page.goto(`${APP}#/s/devbox/${encodeURIComponent(SEED)}`, {
    waitUntil: "networkidle",
  });

  await page.waitForFunction(
    () => (window.__wsUrls || []).some((u) => u.includes("/ws/")),
    { timeout: 15000 },
  );
  const wsUrl = (await page.evaluate(() => window.__wsUrls)).find((u) =>
    u.includes("/ws/"),
  );
  expect(wsUrl).toContain(`/ws/${encodeURIComponent(SEED)}?node=devbox`);

  await expect
    .poll(() => paneCalls.length, { timeout: 15000 })
    .toBeGreaterThan(0);
  expect(paneCalls[0]).toContain("node=devbox");
});

// The target field is read-only (tapping it opens the host suggestion
// sheet — see below), so filling it in a test means: open the sheet, type
// into its own field, then confirm with Done.
async function fillNodeTarget(card, page, value) {
  await card.locator("#nodeTarget").click();
  const sheet = page.locator('[data-testid="host-picker-sheet"]');
  await expect(sheet).toBeVisible();
  await sheet.locator(".picker-input").fill(value);
  await sheet.locator(".picker-done").click();
  await expect(sheet).toHaveCount(0);
}

function mockHostSuggestions(page, fixture = { hosts: [] }) {
  return page.route(/\/api\/host-suggestions$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    }),
  );
}

test("settings: nodes card lists, adds, and removes nodes via PUT /api/settings/nodes", async ({
  page,
}) => {
  let stored = { nodes: [{ name: "devbox", target: "mvhenten@devbox" }] };
  const puts = [];
  await page.route(/\/api\/settings\/nodes$/, async (route) => {
    if (route.request().method() === "PUT") {
      stored = JSON.parse(route.request().postData());
      puts.push(stored);
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stored),
    });
  });
  await mockHostSuggestions(page);

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const card = page.locator("#nodes-settings");
  await expect(card).toBeVisible();

  // The SSH-key stance is stated on the card — keys are the operator's job,
  // no key-management UI.
  await expect(card.locator(".settings-lede")).toContainText("SSH key");

  await expect(card.locator(".node-row")).toHaveCount(1);
  await expect(card.locator('.node-row[data-name="devbox"]')).toContainText(
    "mvhenten@devbox",
  );

  // ADD replaces the whole list with the new entry appended.
  await card.locator("#nodeName").fill("lab");
  await fillNodeTarget(card, page, "ubuntu@lab");
  await card.locator("#nodeAddBtn").click();
  await expect(card.locator(".node-row")).toHaveCount(2);
  expect(puts[0].nodes).toEqual([
    { name: "devbox", target: "mvhenten@devbox" },
    { name: "lab", target: "ubuntu@lab" },
  ]);

  // REMOVE puts the list without the removed node.
  await card.locator('.node-row[data-name="devbox"] .node-remove').click();
  await expect(card.locator(".node-row")).toHaveCount(1);
  expect(puts[1].nodes).toEqual([{ name: "lab", target: "ubuntu@lab" }]);
});

test("settings: a failed nodes save is loud and keeps the old list", async ({
  page,
}) => {
  await page.route(/\/api\/settings\/nodes$/, async (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({ status: 500, body: "boom" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nodes: [] }),
    });
  });
  await mockHostSuggestions(page);

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const card = page.locator("#nodes-settings");
  await card.locator("#nodeName").fill("lab");
  await fillNodeTarget(card, page, "ubuntu@lab");
  await card.locator("#nodeAddBtn").click();

  const status = page.locator("#nodesStatus");
  await expect(status).toContainText("Save failed", { timeout: 5000 });
  // Computed-visible, and the phantom node was not added.
  const box = await status.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  await expect(card.locator(".node-row")).toHaveCount(0);
});

// A failed GET must never collapse into an editable `[]` — that's
// indistinguishable from a real "zero nodes configured" response, and
// add/remove PUT the whole list back (a full-list replace). A stale empty
// list from a transient load failure, followed by one "Add", would silently
// wipe every previously-configured node on the server — this is the actual
// mechanism that emptied the live node table out from under a running
// remote session.
test("settings: a failed nodes load disables editing instead of offering an empty, saveable list", async ({
  page,
}) => {
  const puts = [];
  await page.route(/\/api\/settings\/nodes$/, async (route) => {
    if (route.request().method() === "PUT") {
      puts.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 200, body: "" });
    }
    return route.fulfill({ status: 500, body: "boom" });
  });
  await mockHostSuggestions(page, {
    hosts: [{ name: "should-not-appear", source: "ssh" }],
  });

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const card = page.locator("#nodes-settings");
  await expect(card).toBeVisible();

  // No real list was ever confirmed — no rows, no "zero nodes" hint either
  // (that hint means a confirmed empty list, not a failed one).
  await expect(card.locator(".node-row")).toHaveCount(0);
  await expect(card).toContainText("Could not load the node list");

  // The add form is present but wholly inert until a load succeeds — every
  // control disabled, so there is no way to compose and fire a save that
  // would PUT this failure-derived (non-)list back as the truth.
  await expect(card.locator("#nodeName")).toBeDisabled();
  await expect(card.locator("#nodeTarget")).toBeDisabled();
  await expect(card.locator("#nodeAddBtn")).toBeDisabled();

  // The picker must not open either — a disabled field can't stage a value
  // for a save that would PUT this failure-derived (non-)list back.
  await card.locator("#nodeTarget").click({ force: true });
  await expect(page.locator('[data-testid="host-picker-sheet"]')).toHaveCount(
    0,
  );

  // Give any (incorrect) save a moment to fire, then assert it never did.
  await page.waitForTimeout(300);
  expect(puts.length).toBe(0);

  // Recovering the GET and retrying loads the real list and re-enables editing.
  await page.unroute(/\/api\/settings\/nodes$/);
  await page.route(/\/api\/settings\/nodes$/, async (route) => {
    if (route.request().method() === "PUT") {
      puts.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 200, body: "" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        nodes: [{ name: "sandbox", target: "mvhenten@sandbox" }],
      }),
    });
  });
  await card.locator("#nodesRetryBtn").click();
  await expect(card.locator(".node-row")).toHaveCount(1);
  await expect(card.locator("#nodeAddBtn")).toBeEnabled();
});

// ── host suggestion picker (#193) ────────────────────────────────────────
//
// GET /api/host-suggestions lands with the backend PR; these tests mock it
// at the page level so the picker's UI contract is pinned regardless of
// merge order, same convention as mockNodes above.

test("host suggestion sheet: renders detected hosts with source + online, tap fills the field and closes", async ({
  page,
}) => {
  await mockHostSuggestions(page, {
    hosts: [
      { name: "devbox", source: "ssh" },
      { name: "gpu-box", source: "tailscale", online: true },
      { name: "labbox.local", source: "mdns" },
    ],
  });
  await page.route(/\/api\/settings\/nodes$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nodes: [] }),
    }),
  );

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const card = page.locator("#nodes-settings");
  await expect(card.locator("#nodeTarget")).toBeEnabled();
  await card.locator("#nodeTarget").click();

  const sheet = page.locator('[data-testid="host-picker-sheet"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".picker-row")).toHaveCount(3);

  const tsRow = sheet.locator(".picker-row").nth(1);
  await expect(tsRow).toContainText("gpu-box");
  await expect(tsRow.locator(".picker-badge")).toContainText("tailscale");
  await expect(tsRow.locator(".picker-online-dot")).toHaveClass(/online/);

  // ssh/mdns rows carry no online info at all — no dot rendered.
  await expect(
    sheet.locator(".picker-row").first().locator(".picker-online-dot"),
  ).toHaveCount(0);

  await tsRow.click();
  await expect(sheet).toHaveCount(0);
  await expect(card.locator("#nodeTarget")).toHaveValue("gpu-box");
});

test("host suggestion sheet: no detections still allows manual typing", async ({
  page,
}) => {
  await mockHostSuggestions(page, { hosts: [] });
  await page.route(/\/api\/settings\/nodes$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nodes: [] }),
    }),
  );

  await page.goto(`${APP}#/settings`, { waitUntil: "networkidle" });
  const card = page.locator("#nodes-settings");
  await card.locator("#nodeTarget").click();

  const sheet = page.locator('[data-testid="host-picker-sheet"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".picker-row")).toHaveCount(0);
  await expect(sheet.locator(".picker-hint")).toContainText(
    "No hosts detected",
  );

  await sheet.locator(".picker-input").fill("manual@host");
  await sheet.locator(".picker-done").click();
  await expect(sheet).toHaveCount(0);
  await expect(card.locator("#nodeTarget")).toHaveValue("manual@host");
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

// ── fail-hard error page + ribbon bug report (#190, #191) ───────────────────
//
// Every current call site already catches its own API errors and shows an
// inline status (Home's session hint, the settings cards' flash rows) — that
// is correct, expected-error handling, not the "swallowed error / dead
// widget" pattern #190 targets. The fail-hard page (lib/fatalError.js) is a
// safety net for whatever DOESN'T get caught: an uncaught `ApiError`-shaped
// rejection, exactly what a future forgotten `.catch()` would produce. These
// tests drive that mechanism directly, the same way a real omission would
// trigger it, rather than fighting the app's already-tested recoverable
// error paths.

test("an uncaught ApiError-shaped rejection fails hard with a full-screen error page and a prefilled GitHub link", async ({
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
  await expect(page.locator(".fatal-error-summary")).toContainText(
    "GET /api/whatever -> 500",
  );
  await expect(page.locator(".fatal-error-block").first()).toContainText(
    "boom: something exploded server-side",
  );

  // Full takeover — the app underneath is gone, not just covered.
  await expect(page.locator("#sessionList")).toHaveCount(0);

  const reportLink = page.locator(".fatal-error-report-btn");
  await expect(reportLink).toBeVisible();
  await expect
    .poll(() => reportLink.getAttribute("href"), { timeout: 5000 })
    .not.toBe("#");
  const href = await reportLink.getAttribute("href");
  const url = new URL(href);
  expect(url.origin + url.pathname).toBe(
    "https://github.com/mvhenten/mobux/issues/new",
  );
  expect(url.searchParams.get("title")).toContain("GET /api/whatever -> 500");
  const body = url.searchParams.get("body");
  expect(body).toContain("## Diagnostics");
  expect(body).toContain("boom: something exploded server-side");
});

test("ribbon bug-report button opens a prefilled GitHub issue with the diagnostics bundle", async ({
  page,
}) => {
  // Real popup path — no window.open stub. The tab must be opened
  // synchronously inside the click gesture (awaiting the diagnostics
  // fetches first would lose the user activation, and popup blockers —
  // Android Chrome, the primary target — silently kill the open), then be
  // steered to the issue URL once the bundle resolves. Stub the GitHub
  // response at the context level so the navigation never leaves the test
  // host.
  await page
    .context()
    .route("https://github.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "ok" }),
    );

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

  // Sits right next to the settings gear in the ribbon.
  await expect(page.locator("#reportBugBtn")).toBeVisible();
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 5000 }),
    page.locator("#reportBugBtn").click(),
  ]);

  await popup.waitForURL(/github\.com\/mvhenten\/mobux\/issues\/new/, {
    timeout: 8000,
  });
  const url = new URL(popup.url());
  expect(url.origin + url.pathname).toBe(
    "https://github.com/mvhenten/mobux/issues/new",
  );
  expect(url.searchParams.get("title")).toBe("Bug report");
  const body = url.searchParams.get("body");
  expect(body).toContain("## Diagnostics");
  const diagMatch = body.match(/```json\n([\s\S]*?)\n```/);
  expect(diagMatch).toBeTruthy();
  const diagnostics = JSON.parse(diagMatch[1]);
  expect(diagnostics.userAgent).toBeTruthy();
  expect(diagnostics.route).toContain(SEED);
});
