// A terminal tab sent to the background on a phone. Playwright has no
// page-lifecycle API, so a test overrides Document.prototype.visibilityState
// and dispatches the event the browser would, and stands in for a discard
// with `document.wasDiscarded` plus a reload of the same tab.

const { test, expect, PREF_DEFAULTS } = require("./fixtures.cjs");
const { createTmuxRunner } = require("./lib/tmux.cjs");
const terminalPage = require("./lib/terminal-page.cjs");

const BASE = process.env.MOBUX_URL || "https://localhost:5151";
const USER = process.env.MOBUX_USER || "";
const PASS = process.env.MOBUX_PASS || "";
const AUTH =
  USER && PASS
    ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    : null;
const SANDBOX_HOME = process.env.MOBUX_TEST_HOME || "/tmp/mobux-smoke/home";
const SHELL_ENV = `-e HISTFILE=/dev/null -e HOME=${SANDBOX_HOME}`;
const SESSION = `bg-resume-${process.pid}`;
const tmux = createTmuxRunner("mobux-test");

test.use({
  ...(AUTH ? { extraHTTPHeaders: { Authorization: AUTH } } : {}),
});

test.beforeAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
  tmux(`new-session -d -s ${SESSION} ${SHELL_ENV} "bash --norc --noprofile"`);
});

test.beforeEach(() => {
  terminalPage.resetSession(tmux, SESSION);
});

test.afterAll(() => {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch (_) {}
});

const bootTerminal = (page) => terminalPage.bootTerminal(page, BASE, SESSION);

function setVisibility(page, state) {
  return page.evaluate((state) => {
    Object.defineProperty(Document.prototype, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    Object.defineProperty(Document.prototype, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

const screenRows = (page) =>
  page.evaluate(() => {
    const t = window.__mobuxView.test;
    const top = t.viewportY();
    const rows = [];
    for (let y = top; y < top + t.rows(); y++) {
      rows.push((t.lineText(y) || "").trimEnd());
    }
    return rows;
  });

const wsReady = (page) =>
  page.evaluate(() => window.__mobuxView?.test?.wsReady?.() === true);

const historyRows = (page) =>
  page.evaluate(() => window.__mobuxView.test.historyRowCount());

test("a hidden tab drops its socket, polls and history, and resumes in place", async ({
  page,
}) => {
  const sockets = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/")) sockets.push(ws);
  });
  await bootTerminal(page);
  tmux(`send-keys -t ${SESSION} "seq 1 200" Enter`);
  await expect
    .poll(() => historyRows(page), { timeout: 8000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await screenRows(page)).join("\n"), { timeout: 8000 })
    .toContain("200");
  const before = await screenRows(page);
  await page.evaluate(() => (window.__bgResumeFlag = "kept"));

  await setVisibility(page, "hidden");
  await expect.poll(() => wsReady(page)).toBe(false);
  await expect.poll(() => sockets[0].isClosed()).toBe(true);
  expect(await page.evaluate(() => window.__mobuxView.test.suspended())).toBe(
    true,
  );
  await expect.poll(() => historyRows(page)).toBe(0);

  let panesWhileHidden = 0;
  const countPanes = (req) => {
    if (req.url().includes("/panes")) panesWhileHidden++;
  };
  page.on("request", countPanes);
  await page.waitForTimeout(6000);
  page.off("request", countPanes);
  expect(panesWhileHidden).toBe(0);

  await setVisibility(page, "visible");
  await expect.poll(() => wsReady(page), { timeout: 8000 }).toBe(true);
  await expect
    .poll(() => historyRows(page), { timeout: 8000 })
    .toBeGreaterThan(0);
  await expect.poll(() => screenRows(page), { timeout: 8000 }).toEqual(before);
  expect(sockets).toHaveLength(2);
  expect(await page.evaluate(() => window.__bgResumeFlag)).toBe("kept");
});

test("a new server build with a terminal open offers a reload instead of reloading", async ({
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
  await bootTerminal(page);
  await page.evaluate(() => window.__mobuxCheckBuildHash());
  await page.evaluate(() => (window.__bgResumeFlag = "kept"));

  hash = "hash-b";
  await page.evaluate(() => window.__mobuxCheckBuildHash());
  await expect(page.locator("#updateBar")).toBeVisible();
  await expect(page.locator("#updateBar")).toContainText(
    "New version available",
  );
  expect(await page.evaluate(() => window.__bgResumeFlag)).toBe("kept");

  await setVisibility(page, "hidden");
  expect(await page.evaluate(() => window.__mobuxBuildPollActive())).toBe(
    false,
  );
  await setVisibility(page, "visible");
  expect(await page.evaluate(() => window.__mobuxBuildPollActive())).toBe(true);

  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#updateBarReload").click(),
  ]);
  await expect(page.locator("#updateBar")).toHaveCount(0);
});

test("a discarded tab boots back into the view its window was left in", async ({
  page,
  request,
}, testInfo) => {
  await bootTerminal(page);
  const savedPref = page.waitForResponse(
    (r) =>
      r.url().includes("/api/settings/preferences") &&
      r.request().method() === "PUT",
  );
  await page.evaluate(() => window.__mobuxView.swap("reader"));
  await savedPref;
  // The reader must come back from the tab's own state, not from the
  // server-held default view.
  await request.put(`${BASE}/api/settings/preferences`, {
    data: { ...PREF_DEFAULTS, renderer: testInfo.project.use.renderer },
  });

  await setVisibility(page, "hidden");
  const saved = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("mobux:tab-state")),
  );
  expect(saved.view.current).toBe("reader");

  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, "wasDiscarded", {
      configurable: true,
      get: () => true,
    });
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__mobuxView?.current === "reader", {
    timeout: 8000,
  });
  await expect(page.locator("#reader")).not.toHaveClass(/hidden/);
  expect(
    await page.evaluate(() => sessionStorage.getItem("mobux:tab-state")),
  ).toBe(null);
});
